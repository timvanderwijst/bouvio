//! One entry point for every runner method, by name with JSON params.
//!
//! The desktop app calls it for local workspaces; the hub client calls it for
//! members of a shared workspace (`call_scoped`, which keeps them inside it).
//! Helpers inside agents (the MCP server) come in through `control_call`.

use crate::Runner;
use anyhow::{bail, Context, Result};
use bouvio_protocol::*;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

fn p<T: DeserializeOwned>(params: &Value, key: &str) -> Result<T> {
    serde_json::from_value(params.get(key).cloned().unwrap_or(Value::Null)).with_context(|| format!("param `{key}`"))
}

fn opt<T: DeserializeOwned>(params: &Value, key: &str) -> Option<T> {
    params.get(key).cloned().and_then(|v| serde_json::from_value(v).ok())
}

fn ok<T: serde::Serialize>(v: T) -> Result<Value> {
    Ok(serde_json::to_value(v)?)
}

/// Methods that only make sense on your own machine, never through the hub.
const LOCAL_ONLY: &[&str] = &["list_workspaces", "create_workspace", "update_workspace", "detect_harnesses"];

impl Runner {
    pub async fn call(self: &Arc<Self>, method: &str, params: Value, actor: &str) -> Result<Value> {
        let w = || p::<Uuid>(&params, "workspace_id");
        let th = || p::<Uuid>(&params, "thread_id");
        match method {
            "detect_harnesses" => ok(crate::detect_harnesses().await),
            "list_workspaces" => ok(self.workspaces()),
            "create_workspace" => ok(self.create_workspace(p(&params, "name")?, opt(&params, "root"))?),
            "update_workspace" => {
                let ws: Workspace = p(&params, "workspace")?;
                self.put_workspace(ws.clone())?;
                ok(ws)
            }
            "list_captains" => ok(self.captains(w()?)),
            "create_captain" => ok(self.create_captain(p(&params, "captain")?)?),
            "list_threads" => ok(self.threads(w()?)),
            "create_thread" => ok(self.create_thread(p(&params, "thread")?).await?),
            "thread_events" => ok(self.thread_events(th()?)?),
            "send_message" => ok(self.send_message(th()?, p(&params, "text")?, actor.to_string()).await?),
            "stop_thread" => ok(self.stop_thread(th()?).await?),
            "thread_diff" => ok(self.thread_diff(th()?).await?),
            "resolve_approval" => ok(self.resolve_approval(p(&params, "id")?, p(&params, "allowed")?, actor)?),

            "open_terminal" => {
                let cwd = self.thread_cwd(th()?).filter(|p| p.exists()).or_else(dirs::home_dir).unwrap_or_else(|| ".".into());
                let id = self.terminals.open(&cwd, p(&params, "cols")?, p(&params, "rows")?)?;
                if let Some(t) = self.thread(th()?) {
                    self.terminals.set_workspace(id, t.workspace_id);
                }
                ok(id)
            }
            "write_terminal" => ok(self.terminals.write(p(&params, "id")?, &p::<String>(&params, "data")?)?),
            "resize_terminal" => ok(self.terminals.resize(p(&params, "id")?, p(&params, "cols")?, p(&params, "rows")?)?),
            "close_terminal" => ok(self.terminals.close(p(&params, "id")?)?),

            "workspace_settings" => ok(self.settings(w()?)),
            "workspace_settings_set" => ok(self.set_settings(w()?, &p(&params, "settings")?)?),

            "list_issues" => ok(self.list_issues(w()?)),
            "create_issue" => ok(self.create_issue(w()?, p(&params, "title")?, opt(&params, "body").unwrap_or_default(), opt(&params, "status"), opt(&params, "captain_id"))?),
            "update_issue" => ok(self.update_issue(p(&params, "issue")?)?),
            "delete_issue" => ok(self.delete_issue(p(&params, "id")?)?),
            "start_issue" => ok(self.start_issue(p(&params, "id")?, opt(&params, "captain_id"), actor.to_string()).await?),
            "sync_github_issues" => ok(self.sync_github_issues(w()?).await?),

            "list_pull_requests" => ok(self.list_pull_requests(w()?).await?),
            "create_pull_request" => ok(self.create_pull_request(th()?, opt(&params, "title")).await?),
            "merge_pull_request" => ok(self.merge_pull_request(w()?, p(&params, "number")?).await?),
            "commit_thread" => ok(self.commit_thread(th()?, opt(&params, "message").unwrap_or_default()).await?),

            "list_automations" => ok(self.list_automations(w()?)),
            "create_automation" | "update_automation" => ok(self.save_automation(p(&params, "automation")?)?),
            "delete_automation" => ok(self.delete_automation(p(&params, "id")?)?),
            "run_automation" => ok(self.run_automation(p(&params, "id")?).await?),

            "list_artifacts" => ok(self.list_artifacts(w()?)),
            "read_artifact" => self.read_artifact(p(&params, "id")?),
            "list_files" => ok(self.list_files(w()?, &opt::<String>(&params, "dir").unwrap_or_default())?),
            "read_file" => self.read_file(w()?, &p::<String>(&params, "path")?),

            "list_boards" => ok(self.list_boards(w()?)),
            "create_board" => ok(self.create_board(w()?, p(&params, "name")?)?),
            "get_board" => ok(self.get_board(p(&params, "id")?)?),
            "update_board" => ok(self.update_board(p(&params, "id")?, p(&params, "doc")?, actor)?),
            "rename_board" => ok(self.rename_board(p(&params, "id")?, p(&params, "name")?)?),
            "delete_board" => ok(self.delete_board(p(&params, "id")?)?),

            "dev_servers" => ok(self.dev_servers(w()?)),
            "start_dev_server" => ok(self.start_dev_server(th()?)?),
            "stop_dev_server" => ok(self.stop_dev_server(th()?)?),

            m => bail!("unknown method `{m}`"),
        }
    }

    /// The workspace an RPC touches, so a member of one shared workspace can
    /// never reach into another one through the same runner.
    fn workspace_of(&self, method: &str, params: &Value) -> Result<Uuid> {
        if let Some(w) = opt::<Uuid>(params, "workspace_id") {
            return Ok(w);
        }
        if let Some(t) = opt::<Uuid>(params, "thread_id") {
            return Ok(self.thread(t).context("unknown thread")?.workspace_id);
        }
        if let Some(t) = params.get("thread").and_then(|t| opt::<Uuid>(t, "workspace_id")) {
            return Ok(t);
        }
        if let Some(c) = params.get("captain").and_then(|t| opt::<Uuid>(t, "workspace_id")) {
            return Ok(c);
        }
        if let Some(i) = params.get("issue").and_then(|i| opt::<Uuid>(i, "id")) {
            return Ok(self.issues.find(|x| x.id == i).context("unknown issue")?.workspace_id);
        }
        if let Some(a) = params.get("automation") {
            if let Some(id) = opt::<Uuid>(a, "id").filter(|id| !id.is_nil()) {
                return Ok(self.automations.find(|x| x.id == id).context("unknown automation")?.workspace_id);
            }
            return opt::<Uuid>(a, "workspace_id").context("automation without workspace");
        }
        if let Some(id) = opt::<Uuid>(params, "id") {
            if let Some(i) = self.issues.find(|x| x.id == id) {
                return Ok(i.workspace_id);
            }
            if let Some(a) = self.automations.find(|x| x.id == id) {
                return Ok(a.workspace_id);
            }
            if let Some(a) = self.artifacts.find(|x| x.id == id) {
                return Ok(a.workspace_id);
            }
            if let Ok(b) = self.get_board(id) {
                return Ok(b.workspace_id);
            }
            if method.ends_with("_terminal") || method == "resolve_approval" {
                // Terminal and approval ids carry no workspace; they are checked by owner below.
                return Err(anyhow::anyhow!("scoped"));
            }
        }
        bail!("cannot tell which workspace `{method}` touches")
    }

    /// A call from a member of a shared workspace, relayed by the hub. The hub
    /// already checked their role; here we make sure it stays in that workspace.
    pub async fn call_scoped(self: &Arc<Self>, workspace_id: Uuid, method: &str, params: Value, actor: &str) -> Result<Value> {
        if LOCAL_ONLY.contains(&method) {
            bail!("`{method}` is not available through the hub");
        }
        match self.workspace_of(method, &params) {
            Ok(w) if w == workspace_id => {}
            Ok(_) => bail!("that belongs to another workspace"),
            Err(e) if e.to_string() == "scoped" => {
                if method.ends_with("_terminal") {
                    let id: Uuid = p(&params, "id")?;
                    if self.terminals.workspace_of(id) != Some(workspace_id) {
                        bail!("that terminal belongs to another workspace");
                    }
                }
                if method == "resolve_approval" {
                    let id: String = p(&params, "id")?;
                    let owner = self.pending.lock().unwrap().get(&id).map(|(t, _)| *t).context("no such approval")?;
                    if self.thread(owner).map(|t| t.workspace_id) != Some(workspace_id) {
                        bail!("that belongs to another workspace");
                    }
                }
            }
            Err(e) => return Err(e),
        }
        self.call(method, params, actor).await
    }

    // ---- approvals -----------------------------------------------------------------------

    /// Ask the people in a thread whether a tool call may run, and wait.
    pub async fn request_approval(&self, thread_id: Uuid, tool: String, input: Value) -> bool {
        let id = Uuid::new_v4().simple().to_string()[..12].to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), (thread_id, tx));
        let _ = self.emit(thread_id, ThreadEvent::ApprovalRequest { id: id.clone(), tool, input });
        let _ = self.emit(thread_id, ThreadEvent::Status { status: AgentStatus::Blocked });
        let allowed = rx.await.unwrap_or(false);
        let _ = self.emit(thread_id, ThreadEvent::Status { status: AgentStatus::Working });
        allowed
    }

    pub fn resolve_approval(&self, id: String, allowed: bool, by: &str) -> Result<()> {
        let (thread_id, tx) = self.pending.lock().unwrap().remove(&id).context("this request was already answered")?;
        self.emit(thread_id, ThreadEvent::ApprovalResolved { id, allowed, by: by.to_string() })?;
        let _ = tx.send(allowed);
        Ok(())
    }

    /// Fleet tools for agents that are not behind MCP (Bouvio's own API loop).
    pub async fn fleet_call(self: &Arc<Self>, thread_id: Uuid, method: &str, params: Value) -> Result<Value> {
        self.control_call(thread_id, method, params).await
    }

    /// Calls from the `bouvio` MCP server running inside an agent.
    pub(crate) async fn control_call(self: &Arc<Self>, thread_id: Uuid, method: &str, params: Value) -> Result<Value> {
        let thread = self.thread(thread_id).context("unknown thread")?;
        match method {
            "approve" => {
                let tool = params["tool_name"].as_str().unwrap_or("tool").to_string();
                let input = params["input"].clone();
                let allowed = thread.approval == ApprovalLevel::Free || self.request_approval(thread_id, tool, input.clone()).await;
                // Claude Code expects this JSON as the tool's text result.
                let answer = if allowed {
                    json!({ "behavior": "allow", "updatedInput": input })
                } else {
                    json!({ "behavior": "deny", "message": "A person in Bouvio declined this. Ask what they want instead." })
                };
                Ok(Value::String(answer.to_string()))
            }
            "spawn_thread" => {
                let title: String = p(&params, "title")?;
                let prompt: String = p(&params, "prompt")?;
                let isolate = opt::<bool>(&params, "isolate").unwrap_or(true);
                let t = self
                    .create_thread(NewThread {
                        workspace_id: thread.workspace_id,
                        captain_id: thread.captain_id,
                        title: Some(title.clone()),
                        harness: thread.harness,
                        model: thread.model.clone(),
                        effort: thread.effort,
                        approval: thread.approval,
                        isolate,
                    })
                    .await?;
                self.emit(thread_id, ThreadEvent::ThreadSpawned { thread_id: t.id, title })?;
                let author = thread.captain_id.and_then(|c| self.store().captain(c)).map(|c| c.name).unwrap_or_else(|| thread.title.clone());
                let me = self.clone();
                let id = t.id;
                tokio::spawn(async move {
                    let _ = me.send_message(id, prompt, author).await;
                });
                Ok(json!({ "thread_id": t.id, "branch": t.branch }))
            }
            "list_threads" => Ok(json!(self
                .threads(thread.workspace_id)
                .into_iter()
                .map(|t| json!({ "id": t.id, "title": t.title, "status": t.status, "branch": t.branch }))
                .collect::<Vec<_>>())),
            "thread_status" => {
                let id: Uuid = p(&params, "thread_id")?;
                let t = self.thread(id).filter(|t| t.workspace_id == thread.workspace_id).context("unknown thread")?;
                let last = self.thread_events(id)?.into_iter().rev().find_map(|e| match e.event {
                    ThreadEvent::AssistantText { text } => Some(text),
                    _ => None,
                });
                Ok(json!({ "status": t.status, "branch": t.branch, "last_reply": last }))
            }
            "create_issue" => {
                let i = self.create_issue(thread.workspace_id, p(&params, "title")?, opt(&params, "body").unwrap_or_default(), None, thread.captain_id)?;
                Ok(Value::String(i.key))
            }
            "remember" => {
                let fact: String = p(&params, "fact")?;
                let mut s = self.settings(thread.workspace_id);
                if !s.memory.is_empty() && !s.memory.ends_with('\n') {
                    s.memory.push('\n');
                }
                s.memory.push_str(&format!("- {}\n", fact.trim()));
                self.set_settings(thread.workspace_id, &s)?;
                Ok(Value::String("Saved to workspace memory.".into()))
            }
            m => bail!("unknown tool `{m}`"),
        }
    }
}
