//! The Bouvio runner: the part that actually runs agents.
//!
//! It lives inside the desktop app, and the same code runs headless on a VPS.
//! It owns the threads on this machine, drives their harness, keeps their
//! event log and status, and serves terminals and diffs.

pub mod control;
pub mod detect;
pub mod dispatch;
pub mod git;
pub mod harness;
pub mod hub;
pub mod mcp;
pub mod store;
pub mod studio;
pub mod terminal;
pub mod work;

use anyhow::{Context, Result};
use bouvio_protocol::*;
use chrono::Utc;
use harness::{HarnessOut, HarnessSession, SessionConfig};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use store::{Collection, Store};
use terminal::Terminals;
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

pub use detect::detect_harnesses;

/// Something that changed in a workspace besides threads: an issue, a board,
/// an artifact. The UI and the hub forward these by `kind`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Notice {
    pub workspace_id: Uuid,
    pub kind: String,
    pub payload: serde_json::Value,
}

pub struct Runner {
    store: Store,
    events: broadcast::Sender<ThreadEnvelope>,
    threads: broadcast::Sender<Thread>,
    notices: broadcast::Sender<Notice>,
    sessions: tokio::sync::Mutex<HashMap<Uuid, Arc<dyn HarnessSession>>>,
    seqs: Mutex<HashMap<Uuid, u64>>,
    pending: Mutex<HashMap<String, (Uuid, tokio::sync::oneshot::Sender<bool>)>>,
    control: std::sync::OnceLock<control::ControlAddr>,
    /// Executable that serves `mcp` (the app itself, or bouvio-runner).
    self_exe: Mutex<Option<PathBuf>>,
    pub(crate) issues: Collection<Issue>,
    pub(crate) automations: Collection<Automation>,
    pub(crate) artifacts: Collection<Artifact>,
    pub(crate) dev: Mutex<HashMap<Uuid, (DevServer, tokio::process::Child)>>,
    /// Extra harnesses plugged in by the app (the API agent loop).
    api_factory: Mutex<Option<ApiFactory>>,
    pub terminals: Terminals,
}

/// Builds a session for `HarnessKind::Api`; set by the app so the runner does
/// not depend on any provider code.
#[allow(clippy::type_complexity)]
pub type ApiFactory = Arc<dyn Fn(Arc<Runner>, &Thread, SessionConfig, mpsc::UnboundedSender<HarnessOut>) -> Result<Box<dyn HarnessSession>> + Send + Sync>;

impl Runner {
    /// Open the runner on its data dir (`~/.bouvio` by default).
    pub fn open(dir: impl Into<PathBuf>) -> Result<Arc<Self>> {
        let store = Store::open(dir)?;
        let (events, _) = broadcast::channel(4096);
        let (threads, _) = broadcast::channel(256);

        // A thread that was working or waiting when the runner stopped is neither now.
        for ws in store.workspaces() {
            for t in store.threads(ws.id) {
                if matches!(t.status, AgentStatus::Working | AgentStatus::Blocked) {
                    store.update_thread(t.id, |t| t.status = AgentStatus::Idle)?;
                }
            }
        }

        let dir = store.dir().to_path_buf();
        let (notices, _) = broadcast::channel(1024);
        Ok(Arc::new(Self {
            issues: Collection::open(dir.join("issues.json"))?,
            automations: Collection::open(dir.join("automations.json"))?,
            artifacts: Collection::open(dir.join("artifacts.json"))?,
            store,
            events,
            threads,
            notices,
            sessions: tokio::sync::Mutex::new(HashMap::new()),
            seqs: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            control: std::sync::OnceLock::new(),
            self_exe: Mutex::new(std::env::current_exe().ok()),
            dev: Mutex::new(HashMap::new()),
            api_factory: Mutex::new(None),
            terminals: Terminals::new(),
        }))
    }

    pub fn default_dir() -> PathBuf {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".bouvio")
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<ThreadEnvelope> {
        self.events.subscribe()
    }

    pub fn subscribe_threads(&self) -> broadcast::Receiver<Thread> {
        self.threads.subscribe()
    }

    pub fn subscribe_notices(&self) -> broadcast::Receiver<Notice> {
        self.notices.subscribe()
    }

    pub(crate) fn notice(&self, workspace_id: Uuid, kind: &str, payload: impl serde::Serialize) {
        let payload = serde_json::to_value(payload).unwrap_or_default();
        let _ = self.notices.send(Notice { workspace_id, kind: kind.to_string(), payload });
    }

    /// Start background services: the control socket for helpers, and the
    /// automation scheduler. Call once, inside a tokio runtime.
    pub async fn start(self: &Arc<Self>) -> Result<()> {
        let addr = control::serve(self.clone()).await?;
        let _ = self.control.set(addr);
        work::spawn_scheduler(self.clone());
        Ok(())
    }

    /// The executable Claude Code should run as the `bouvio` MCP server.
    pub fn set_mcp_exe(&self, exe: PathBuf) {
        *self.self_exe.lock().unwrap() = Some(exe);
    }

    pub fn set_api_factory(&self, f: ApiFactory) {
        *self.api_factory.lock().unwrap() = Some(f);
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn workspace(&self, id: Uuid) -> Option<Workspace> {
        self.store.workspace(id)
    }

    pub fn thread(&self, id: Uuid) -> Option<Thread> {
        self.store.thread(id)
    }

    pub fn put_workspace(&self, ws: Workspace) -> Result<()> {
        self.store.put_workspace(ws)
    }

    pub fn settings(&self, workspace_id: Uuid) -> WorkspaceSettings {
        let mut s: WorkspaceSettings = store::load(&self.store.dir().join("settings").join(format!("{workspace_id}.json"))).unwrap_or_default();
        if s.issue_prefix.is_empty() {
            s.issue_prefix = self
                .store
                .workspace(workspace_id)
                .map(|w| w.name.chars().filter(|c| c.is_ascii_alphanumeric()).take(3).collect::<String>().to_uppercase())
                .filter(|p| !p.is_empty())
                .unwrap_or_else(|| "ISS".into());
        }
        s
    }

    pub fn set_settings(&self, workspace_id: Uuid, s: &WorkspaceSettings) -> Result<()> {
        store::save(&self.store.dir().join("settings").join(format!("{workspace_id}.json")), s)?;
        self.notice(workspace_id, "settings-changed", s);
        Ok(())
    }

    // ---- workspaces & captains ------------------------------------------------

    pub fn workspaces(&self) -> Vec<Workspace> {
        self.store.workspaces()
    }

    pub fn create_workspace(&self, name: String, root: Option<String>) -> Result<Workspace> {
        let ws = Workspace { id: Uuid::new_v4(), name, kind: WorkspaceKind::Personal, root, created_at: Utc::now(), role: None, host: None };
        self.store.put_workspace(ws.clone())?;
        Ok(ws)
    }

    pub fn captains(&self, workspace_id: Uuid) -> Vec<Captain> {
        self.store.captains(workspace_id)
    }

    pub fn create_captain(&self, new: NewCaptain) -> Result<Captain> {
        let c = Captain {
            id: Uuid::new_v4(),
            workspace_id: new.workspace_id,
            avatar_seed: rand_seed(&new.name),
            name: new.name,
            instructions: new.instructions,
            harness: new.harness,
            model: new.model,
            effort: new.effort,
            approval: new.approval,
        };
        self.store.put_captain(c.clone())?;
        Ok(c)
    }

    // ---- threads --------------------------------------------------------------

    pub fn threads(&self, workspace_id: Uuid) -> Vec<Thread> {
        self.store.threads(workspace_id)
    }

    pub fn thread_events(&self, thread_id: Uuid) -> Result<Vec<ThreadEnvelope>> {
        self.store.events(thread_id)
    }

    pub async fn create_thread(&self, new: NewThread) -> Result<Thread> {
        let ws = self.store.workspace(new.workspace_id).context("unknown workspace")?;
        let id = Uuid::new_v4();
        let mut cwd = ws.root.clone();
        let mut branch = None;

        if let Some(root) = ws.root.as_deref().map(Path::new) {
            if git::is_repo(root).await {
                if new.isolate {
                    let b = format!("bouvio/{}", &id.simple().to_string()[..8]);
                    let base = self.store.dir().join("worktrees").join(ws.id.to_string());
                    let path = git::add_worktree(root, &base, &b).await?;
                    cwd = Some(path.to_string_lossy().into_owned());
                    branch = Some(b);
                } else {
                    branch = git::current_branch(root).await;
                }
            }
        }

        let now = Utc::now();
        let t = Thread {
            id,
            workspace_id: ws.id,
            captain_id: new.captain_id,
            title: new.title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| "New thread".into()),
            harness: new.harness,
            model: new.model,
            effort: new.effort,
            approval: new.approval,
            status: AgentStatus::Idle,
            cwd,
            branch,
            created_at: now,
            updated_at: now,
            cost_usd: 0.0,
            session_id: None,
        };
        self.store.put_thread(t.clone())?;
        let _ = self.threads.send(t.clone());
        Ok(t)
    }

    pub async fn send_message(self: &Arc<Self>, thread_id: Uuid, text: String, author: String) -> Result<()> {
        let thread = self.store.thread(thread_id).context("unknown thread")?;
        // The first message names the thread, like every chat app does.
        if thread.title == "New thread" {
            let title = title_from(&text);
            if let Some(t) = self.store.update_thread(thread_id, |t| t.title = title)? {
                let _ = self.threads.send(t);
            }
        }
        self.emit(thread_id, ThreadEvent::UserMessage { text: text.clone(), author })?;
        self.emit(thread_id, ThreadEvent::Status { status: AgentStatus::Working })?;

        let session = match self.session(&thread).await {
            Ok(s) => s,
            Err(e) => return self.fail(thread_id, e),
        };
        if let Err(e) = session.send(&text).await {
            self.sessions.lock().await.remove(&thread_id);
            return self.fail(thread_id, e);
        }
        Ok(())
    }

    pub async fn stop_thread(&self, thread_id: Uuid) -> Result<()> {
        if let Some(s) = self.sessions.lock().await.remove(&thread_id) {
            s.stop().await?;
        }
        self.emit(thread_id, ThreadEvent::Status { status: AgentStatus::Idle })?;
        Ok(())
    }

    pub async fn thread_diff(&self, thread_id: Uuid) -> Result<String> {
        let t = self.store.thread(thread_id).context("unknown thread")?;
        let cwd = t.cwd.context("thread has no folder")?;
        if !git::is_repo(Path::new(&cwd)).await {
            return Ok(String::new());
        }
        git::diff(Path::new(&cwd)).await
    }

    pub fn thread_cwd(&self, thread_id: Uuid) -> Option<PathBuf> {
        self.store.thread(thread_id).and_then(|t| t.cwd).map(PathBuf::from)
    }

    fn fail(&self, thread_id: Uuid, e: anyhow::Error) -> Result<()> {
        self.emit(thread_id, ThreadEvent::Error { message: format!("{e:#}") })?;
        self.emit(thread_id, ThreadEvent::Status { status: AgentStatus::Error })?;
        Ok(())
    }

    async fn session(self: &Arc<Self>, thread: &Thread) -> Result<Arc<dyn HarnessSession>> {
        let mut sessions = self.sessions.lock().await;
        if let Some(s) = sessions.get(&thread.id) {
            return Ok(s.clone());
        }
        let cwd = thread
            .cwd
            .clone()
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));
        let settings = self.settings(thread.workspace_id);
        let captain = thread.captain_id.and_then(|c| self.store.captain(c));
        let instructions = compose_instructions(captain.as_ref(), &settings);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mcp_config = self.write_mcp_config(thread, &settings).ok();
        let cfg = SessionConfig {
            cwd,
            model: thread.model.clone(),
            effort: thread.effort,
            approval: thread.approval,
            resume: thread.session_id.clone(),
            instructions: Some(instructions),
            prompt_tool: mcp_config.is_some() && thread.approval != ApprovalLevel::Free,
            mcp_config,
        };
        let s: Arc<dyn HarnessSession> = if thread.harness == HarnessKind::Api {
            let f = self.api_factory.lock().unwrap().clone().context("API models need the desktop app or a runner with keys")?;
            Arc::from(f(self.clone(), thread, cfg, tx)?)
        } else {
            Arc::from(harness::start(thread.harness, cfg, tx)?)
        };
        sessions.insert(thread.id, s.clone());

        let me = self.clone();
        let thread_id = thread.id;
        tokio::spawn(async move {
            while let Some(out) = rx.recv().await {
                let r = match out {
                    HarnessOut::Event(e) => {
                        let done = matches!(e, ThreadEvent::TurnComplete { .. });
                        let r = me.emit(thread_id, e);
                        if done {
                            let me2 = me.clone();
                            tokio::spawn(async move { me2.scan_artifacts(thread_id).await });
                        }
                        r
                    }
                    HarnessOut::SessionId(id) => {
                        me.store.update_thread(thread_id, |t| t.session_id = Some(id)).map(|_| ())
                    }
                };
                if let Err(e) = r {
                    tracing::warn!("thread {thread_id}: {e:#}");
                }
            }
        });
        Ok(s)
    }

    /// Record an event: number it, persist it, fold it into the thread, broadcast it.
    pub(crate) fn emit(&self, thread_id: Uuid, event: ThreadEvent) -> Result<()> {
        // Harnesses repeat their status; only changes are worth an event.
        if let ThreadEvent::Status { status } = &event {
            if self.store.thread(thread_id).is_some_and(|t| t.status == *status) {
                return Ok(());
            }
        }
        let seq = {
            let mut seqs = self.seqs.lock().unwrap();
            let next = match seqs.get(&thread_id) {
                Some(s) => s + 1,
                None => self.store.events(thread_id)?.last().map(|e| e.seq + 1).unwrap_or(0),
            };
            seqs.insert(thread_id, next);
            next
        };
        let env = ThreadEnvelope { thread_id, seq, at: Utc::now(), event };
        self.store.append_event(&env)?;

        let updated = self.store.update_thread(thread_id, |t| {
            t.updated_at = env.at;
            match &env.event {
                ThreadEvent::Status { status } => t.status = *status,
                ThreadEvent::TurnComplete { cost_usd: Some(c), .. } => t.cost_usd += c,
                _ => {}
            }
        })?;
        if let Some(t) = updated {
            if matches!(env.event, ThreadEvent::Status { .. } | ThreadEvent::TurnComplete { .. }) {
                let _ = self.threads.send(t);
            }
        }
        let _ = self.events.send(env);
        Ok(())
    }
}

fn compose_instructions(captain: Option<&Captain>, s: &WorkspaceSettings) -> String {
    let mut parts = vec!["You work inside Bouvio, a shared workspace where people and agents collaborate. People in this workspace watch your work live. The `bouvio` tools let you split work into parallel threads (spawn_thread), follow them up, file issues and keep workspace memory.".to_string()];
    if let Some(c) = captain {
        parts.push(format!("You are the captain \"{}\". {}", c.name, c.instructions));
    }
    if !s.instructions.trim().is_empty() {
        parts.push(format!("Workspace instructions:\n{}", s.instructions.trim()));
    }
    if !s.memory.trim().is_empty() {
        parts.push(format!("Workspace memory:\n{}", s.memory.trim()));
    }
    parts.join("\n\n")
}

pub(crate) fn title_from(text: &str) -> String {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("New thread").trim();
    let mut t: String = line.chars().take(60).collect();
    if line.chars().count() > 60 {
        t.push('…');
    }
    t
}

fn rand_seed(name: &str) -> u32 {
    // Stable per name, so a captain keeps its face when recreated.
    name.bytes().fold(2166136261u32, |h, b| (h ^ b as u32).wrapping_mul(16777619))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn thread_lifecycle_without_harness() {
        let dir = tempfile::tempdir().unwrap();
        let r = Runner::open(dir.path()).unwrap();
        let ws = r.create_workspace("Bouvio".into(), None).unwrap();
        let t = r
            .create_thread(NewThread {
                workspace_id: ws.id,
                captain_id: None,
                title: None,
                harness: HarnessKind::Api,
                model: None,
                effort: Effort::Medium,
                approval: ApprovalLevel::AskRisky,
                isolate: false,
            })
            .await
            .unwrap();
        // The API loop is phase 2, so this ends in a clear error, not a hang.
        r.send_message(t.id, "Fix the sign-up form\nmore".into(), "Tim".into()).await.unwrap();
        let events = r.thread_events(t.id).unwrap();
        assert!(matches!(events[0].event, ThreadEvent::UserMessage { .. }));
        assert!(events.iter().any(|e| matches!(e.event, ThreadEvent::Error { .. })));
        let t2 = r.threads(ws.id).pop().unwrap();
        assert_eq!(t2.title, "Fix the sign-up form");
        assert_eq!(t2.status, AgentStatus::Error);

        // Reopening keeps everything and continues the sequence.
        drop(r);
        let r = Runner::open(dir.path()).unwrap();
        assert_eq!(r.thread_events(t.id).unwrap().len(), events.len());
    }

    #[tokio::test]
    async fn worktree_per_thread() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let sh = |args: &[&str]| {
            assert!(std::process::Command::new("git").arg("-C").arg(&repo).args(args).status().unwrap().success())
        };
        sh(&["init", "-q", "-b", "main"]);
        sh(&["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);

        let r = Runner::open(dir.path().join("data")).unwrap();
        let ws = r.create_workspace("Repo".into(), Some(repo.to_string_lossy().into())).unwrap();
        let t = r
            .create_thread(NewThread {
                workspace_id: ws.id,
                captain_id: None,
                title: Some("Isolated".into()),
                harness: HarnessKind::ClaudeCode,
                model: None,
                effort: Effort::Medium,
                approval: ApprovalLevel::AskRisky,
                isolate: true,
            })
            .await
            .unwrap();
        assert!(t.branch.as_deref().unwrap().starts_with("bouvio/"));
        let cwd = PathBuf::from(t.cwd.unwrap());
        std::fs::write(cwd.join("hello.txt"), "hi\n").unwrap();
        let diff = r.thread_diff(t.id).await.unwrap();
        assert!(diff.contains("+hi"), "{diff}");
    }
}
