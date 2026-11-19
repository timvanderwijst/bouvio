//! Studio: artifacts agents make, boards, files of a workspace, and dev
//! servers for live frames.

use crate::{git, store, Runner};
use anyhow::{bail, Context, Result};
use base64::Engine;
use bouvio_protocol::*;
use chrono::Utc;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::SystemTime;
use uuid::Uuid;

pub fn kind_of(path: &Path) -> Option<ArtifactKind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "html" | "htm" => ArtifactKind::Html,
        "md" | "markdown" => ArtifactKind::Markdown,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" => ArtifactKind::Image,
        "svg" => ArtifactKind::Svg,
        "mp4" | "webm" | "mov" => ArtifactKind::Video,
        "mp3" | "wav" | "ogg" | "m4a" => ArtifactKind::Audio,
        "pdf" => ArtifactKind::Pdf,
        "csv" | "tsv" | "xlsx" | "json" => ArtifactKind::Data,
        _ => return None,
    })
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("svg") => "image/svg+xml",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("m4a") => "audio/mp4",
        Some("pdf") => "application/pdf",
        Some("html" | "htm") => "text/html",
        Some("md" | "markdown") => "text/markdown",
        Some("csv") => "text/csv",
        Some("json") => "application/json",
        _ => "text/plain",
    }
}

const MAX_INLINE: u64 = 25 * 1024 * 1024;

impl Runner {
    /// After a turn: record files the agent created or changed that are worth showing.
    pub(crate) async fn scan_artifacts(self: &Arc<Self>, thread_id: Uuid) {
        let Some(t) = self.thread(thread_id) else { return };
        let Some(cwd) = t.cwd.clone().map(PathBuf::from) else { return };
        let mut files: Vec<PathBuf> = Vec::new();
        if git::is_repo(&cwd).await {
            if let Ok(out) = tokio::process::Command::new("git").arg("-C").arg(&cwd).args(["status", "--porcelain", "-uall"]).output().await {
                for line in String::from_utf8_lossy(&out.stdout).lines() {
                    if line.len() > 3 && !line.starts_with(" D") {
                        files.push(cwd.join(line[3..].trim_matches('"')));
                    }
                }
            }
        }
        let since = t.updated_at - chrono::Duration::minutes(30);
        for path in files {
            let Some(kind) = kind_of(&path) else { continue };
            // Lockfiles and configs are not artifacts.
            if kind == ArtifactKind::Data && path.file_name().is_some_and(|n| n.to_string_lossy().contains("lock") || n == "package.json" || n == "tsconfig.json") {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&path) else { continue };
            let modified: chrono::DateTime<Utc> = meta.modified().unwrap_or(SystemTime::now()).into();
            if modified < since {
                continue;
            }
            let p = path.to_string_lossy().into_owned();
            let existing = self.artifacts.find(|a| a.path == p);
            let a = Artifact {
                id: existing.as_ref().map(|a| a.id).unwrap_or_else(Uuid::new_v4),
                workspace_id: t.workspace_id,
                thread_id: Some(thread_id),
                kind,
                title: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                path: p,
                size: meta.len(),
                created_at: existing.as_ref().map(|a| a.created_at).unwrap_or_else(Utc::now),
                prompt: None,
                model: None,
            };
            let _ = self.artifacts.put(a.clone(), |x| x.id);
            if existing.is_none() {
                let _ = self.emit(thread_id, ThreadEvent::ArtifactCreated { artifact: a.clone() });
            }
            self.notice(t.workspace_id, "artifact-changed", &a);
        }
    }

    pub fn list_artifacts(&self, workspace_id: Uuid) -> Vec<Artifact> {
        let mut v = self.artifacts.filter(|a| a.workspace_id == workspace_id && Path::new(&a.path).exists());
        v.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        v
    }

    /// Record a generated file (image, video, speech) as an artifact.
    pub fn add_artifact(&self, workspace_id: Uuid, thread_id: Option<Uuid>, path: &Path, prompt: Option<String>, model: Option<String>) -> Result<Artifact> {
        let kind = kind_of(path).context("unknown file type")?;
        let a = Artifact {
            id: Uuid::new_v4(),
            workspace_id,
            thread_id,
            kind,
            title: prompt.clone().map(|p| crate::work::short_title(&p)).unwrap_or_else(|| path.file_name().unwrap_or_default().to_string_lossy().into_owned()),
            path: path.to_string_lossy().into_owned(),
            size: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
            created_at: Utc::now(),
            prompt,
            model,
        };
        self.artifacts.put(a.clone(), |x| x.id)?;
        if let Some(t) = thread_id {
            self.emit(t, ThreadEvent::ArtifactCreated { artifact: a.clone() })?;
        }
        self.notice(workspace_id, "artifact-changed", &a);
        Ok(a)
    }

    pub fn media_dir(&self, workspace_id: Uuid) -> PathBuf {
        self.store().dir().join("media").join(workspace_id.to_string())
    }

    /// File contents for preview: text for text kinds, a data URL otherwise.
    pub fn read_artifact(&self, id: Uuid) -> Result<Value> {
        let a = self.artifacts.find(|a| a.id == id).context("unknown artifact")?;
        read_for_preview(Path::new(&a.path))
    }

    // ---- files -------------------------------------------------------------------------

    fn inside(&self, workspace_id: Uuid, rel: &str) -> Result<PathBuf> {
        let root = PathBuf::from(self.workspace(workspace_id).context("unknown workspace")?.root.context("this workspace has no folder")?);
        let root = root.canonicalize()?;
        let p = root.join(rel.trim_start_matches(['/', '\\'])).canonicalize().context("no such file")?;
        if !p.starts_with(&root) {
            bail!("outside the workspace");
        }
        Ok(p)
    }

    pub fn list_files(&self, workspace_id: Uuid, dir: &str) -> Result<Vec<FileEntry>> {
        let base = self.inside(workspace_id, dir)?;
        let root = self.inside(workspace_id, "")?;
        let mut out = Vec::new();
        let walker = ignore::WalkBuilder::new(&base).max_depth(Some(1)).hidden(false).filter_entry(|e| e.file_name() != ".git").build();
        for e in walker.flatten() {
            if e.path() == base {
                continue;
            }
            let meta = e.metadata().ok();
            out.push(FileEntry {
                name: e.file_name().to_string_lossy().into_owned(),
                path: e.path().strip_prefix(&root).unwrap_or(e.path()).to_string_lossy().replace('\\', "/"),
                dir: meta.as_ref().is_some_and(|m| m.is_dir()),
                size: meta.map(|m| m.len()).unwrap_or(0),
            });
        }
        out.sort_by(|a, b| b.dir.cmp(&a.dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(out)
    }

    pub fn read_file(&self, workspace_id: Uuid, rel: &str) -> Result<Value> {
        read_for_preview(&self.inside(workspace_id, rel)?)
    }

    // ---- boards --------------------------------------------------------------------------

    fn board_path(&self, id: Uuid) -> PathBuf {
        self.store().dir().join("boards").join(format!("{id}.json"))
    }

    pub fn list_boards(&self, workspace_id: Uuid) -> Vec<Board> {
        let dir = self.store().dir().join("boards");
        let mut out: Vec<Board> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| serde_json::from_slice::<Board>(&std::fs::read(e.path()).ok()?).ok())
            .filter(|b| b.workspace_id == workspace_id)
            .map(|mut b| {
                b.doc = Value::Null; // the list does not need contents
                b
            })
            .collect();
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        out
    }

    pub fn create_board(&self, workspace_id: Uuid, name: String) -> Result<Board> {
        let now = Utc::now();
        let b = Board { id: Uuid::new_v4(), workspace_id, name, created_at: now, updated_at: now, doc: json!({ "items": [] }) };
        store::save(&self.board_path(b.id), &b)?;
        self.notice(workspace_id, "board-changed", json!({ "id": b.id, "name": b.name }));
        Ok(b)
    }

    pub fn get_board(&self, id: Uuid) -> Result<Board> {
        let raw = std::fs::read(self.board_path(id)).context("unknown board")?;
        Ok(serde_json::from_slice(&raw)?)
    }

    pub fn update_board(&self, id: Uuid, doc: Value, by: &str) -> Result<()> {
        let mut b = self.get_board(id)?;
        b.doc = doc;
        b.updated_at = Utc::now();
        store::save(&self.board_path(id), &b)?;
        self.notice(b.workspace_id, "board-doc", json!({ "id": id, "doc": b.doc, "by": by }));
        Ok(())
    }

    pub fn rename_board(&self, id: Uuid, name: String) -> Result<()> {
        let mut b = self.get_board(id)?;
        b.name = name;
        store::save(&self.board_path(id), &b)?;
        self.notice(b.workspace_id, "board-changed", json!({ "id": id, "name": b.name }));
        Ok(())
    }

    pub fn delete_board(&self, id: Uuid) -> Result<()> {
        let b = self.get_board(id)?;
        std::fs::remove_file(self.board_path(id))?;
        self.notice(b.workspace_id, "board-deleted", json!({ "id": id }));
        Ok(())
    }

    // ---- dev servers for live frames ------------------------------------------------------

    pub fn dev_servers(&self, workspace_id: Uuid) -> Vec<DevServer> {
        let mut dev = self.dev.lock().unwrap();
        dev.retain(|_, (_, child)| child.try_wait().ok().flatten().is_none());
        dev.values()
            .filter(|(d, _)| self.thread(d.thread_id).is_some_and(|t| t.workspace_id == workspace_id))
            .map(|(d, _)| d.clone())
            .collect()
    }

    /// Start the workspace's dev command in a thread's folder on a free port.
    pub fn start_dev_server(&self, thread_id: Uuid) -> Result<DevServer> {
        if let Some((d, _)) = self.dev.lock().unwrap().get(&thread_id) {
            return Ok(d.clone());
        }
        let t = self.thread(thread_id).context("unknown thread")?;
        let cwd = t.cwd.clone().context("thread has no folder")?;
        let cmd = self.settings(t.workspace_id).dev_command.context("set a dev command in workspace settings, like `pnpm dev --port {port}`")?;
        let port = std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
        let line = cmd.replace("{port}", &port.to_string());
        let mut c = if cfg!(windows) {
            let mut c = tokio::process::Command::new("cmd");
            c.args(["/C", &line]);
            c
        } else {
            let mut c = tokio::process::Command::new("sh");
            c.args(["-c", &line]);
            c
        };
        let child = c
            .current_dir(cwd)
            .env("PORT", port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("start dev command")?;
        let d = DevServer { thread_id, url: format!("http://127.0.0.1:{port}"), port, running: true };
        self.dev.lock().unwrap().insert(thread_id, (d.clone(), child));
        self.notice(t.workspace_id, "dev-server", &d);
        Ok(d)
    }

    pub fn stop_dev_server(&self, thread_id: Uuid) -> Result<()> {
        if let Some((mut d, mut child)) = self.dev.lock().unwrap().remove(&thread_id) {
            let _ = child.start_kill();
            d.running = false;
            if let Some(t) = self.thread(thread_id) {
                self.notice(t.workspace_id, "dev-server", &d);
            }
        }
        Ok(())
    }

    // ---- MCP config for Claude Code ----------------------------------------------------------

    pub(crate) fn write_mcp_config(&self, thread: &Thread, settings: &WorkspaceSettings) -> Result<PathBuf> {
        let addr = self.control.get().context("runner services not started")?;
        let exe = self.self_exe.lock().unwrap().clone().context("no executable for the MCP server")?;
        let mut servers = serde_json::Map::new();
        servers.insert(
            "bouvio".into(),
            json!({
                "command": exe.to_string_lossy(),
                "args": ["mcp"],
                "env": {
                    "BOUVIO_CONTROL": addr.port.to_string(),
                    "BOUVIO_TOKEN": addr.token,
                    "BOUVIO_THREAD": thread.id.to_string(),
                }
            }),
        );
        for s in &settings.mcp_servers {
            let env: serde_json::Map<String, Value> = s.env.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
            servers.insert(s.name.clone(), json!({ "command": s.command, "args": s.args, "env": env }));
        }
        let path = self.store().dir().join("mcp").join(format!("{}.json", thread.id));
        store::save(&path, &json!({ "mcpServers": servers }))?;
        Ok(path)
    }
}

pub fn read_for_preview(path: &Path) -> Result<Value> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > MAX_INLINE {
        bail!("file is larger than 25 MB");
    }
    let m = mime(path);
    let bytes = std::fs::read(path)?;
    if m.starts_with("text/") || m == "application/json" || m == "image/svg+xml" {
        if let Ok(text) = String::from_utf8(bytes.clone()) {
            return Ok(json!({ "mime": m, "text": text, "path": path.to_string_lossy() }));
        }
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(json!({ "mime": m, "data_url": format!("data:{m};base64,{b64}"), "path": path.to_string_lossy() }))
}
