//! Codex via `codex exec --json`: one process per turn, resumed by session id.
//!
//! Experimental: written against the documented JSONL events of `codex exec`.
//! `codex app-server` (JSON-RPC, used by T3 Code) is the richer target once
//! approvals move into the app.

use super::{HarnessOut, HarnessSession, SessionConfig};
use anyhow::{Context, Result};
use async_trait::async_trait;
use cuna_protocol::{AgentStatus, ApprovalLevel, ThreadEvent};
use serde_json::Value;
use std::process::Stdio;
use std::sync::Mutex as StdMutex;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex;

pub struct CodexSession {
    cfg: SessionConfig,
    out: UnboundedSender<HarnessOut>,
    session: std::sync::Arc<StdMutex<Option<String>>>,
    child: Mutex<Option<Child>>,
}

impl CodexSession {
    pub fn new(cfg: SessionConfig, out: UnboundedSender<HarnessOut>) -> Self {
        let session = std::sync::Arc::new(StdMutex::new(cfg.resume.clone()));
        Self { cfg, out, session, child: Mutex::new(None) }
    }
}

#[async_trait]
impl HarnessSession for CodexSession {
    async fn send(&self, text: &str) -> Result<()> {
        let mut cmd = Command::new("codex");
        cmd.arg("exec");
        let resume = self.session.lock().unwrap().clone();
        if let Some(id) = &resume {
            cmd.args(["resume", id]);
        }
        cmd.arg("--json");
        let sandbox = match self.cfg.approval {
            ApprovalLevel::AskAll => "read-only",
            ApprovalLevel::AskRisky => "workspace-write",
            ApprovalLevel::Free => "danger-full-access",
        };
        cmd.args(["--sandbox", sandbox]);
        if let Some(m) = &self.cfg.model {
            cmd.args(["--model", m]);
        }
        cmd.arg(text)
            .current_dir(&self.cfg.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().context("start codex; is the Codex CLI installed?")?;
        let stdout = child.stdout.take().context("codex stdout")?;
        let stderr = child.stderr.take().context("codex stderr")?;
        *self.child.lock().await = Some(child);

        let out = self.out.clone();
        let session = self.session.clone();
        let _ = out.send(HarnessOut::Event(ThreadEvent::Status { status: AgentStatus::Working }));
        tokio::spawn(async move {
            let started = Instant::now();
            let mut lines = BufReader::new(stdout).lines();
            let mut finished = false;
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                for o in translate(&v, started.elapsed().as_millis() as u64) {
                    if let HarnessOut::SessionId(id) = &o {
                        *session.lock().unwrap() = Some(id.clone());
                    }
                    if matches!(o, HarnessOut::Event(ThreadEvent::TurnComplete { .. })) {
                        finished = true;
                    }
                    let _ = out.send(o);
                }
            }
            if !finished {
                let mut err = String::new();
                let mut el = BufReader::new(stderr).lines();
                while let Ok(Some(l)) = el.next_line().await {
                    err.push_str(&l);
                    err.push('\n');
                }
                let message = if err.trim().is_empty() { "Codex stopped unexpectedly".into() } else { err.trim().to_string() };
                let _ = out.send(HarnessOut::Event(ThreadEvent::Error { message }));
                let _ = out.send(HarnessOut::Event(ThreadEvent::Status { status: AgentStatus::Error }));
            }
        });
        Ok(())
    }

    async fn stop(&self) -> Result<()> {
        if let Some(mut c) = self.child.lock().await.take() {
            let _ = c.kill().await;
        }
        Ok(())
    }
}

pub fn translate(v: &Value, elapsed_ms: u64) -> Vec<HarnessOut> {
    let ev = |e| HarnessOut::Event(e);
    match v["type"].as_str() {
        Some("thread.started") => v["thread_id"].as_str().map(|id| vec![HarnessOut::SessionId(id.into())]).unwrap_or_default(),
        Some("item.started") if v["item"]["type"] == "command_execution" => vec![ev(ThreadEvent::ToolUse {
            id: v["item"]["id"].as_str().unwrap_or_default().into(),
            name: "Bash".into(),
            input: serde_json::json!({ "command": v["item"]["command"] }),
        })],
        Some("item.completed") => {
            let item = &v["item"];
            let id = item["id"].as_str().unwrap_or_default().to_string();
            match item["type"].as_str() {
                Some("agent_message") => vec![ev(ThreadEvent::AssistantText { text: item["text"].as_str().unwrap_or_default().into() })],
                Some("command_execution") => vec![ev(ThreadEvent::ToolResult {
                    tool_use_id: id,
                    output: item["aggregated_output"].as_str().unwrap_or_default().into(),
                    is_error: item["exit_code"].as_i64().map(|c| c != 0).unwrap_or(false),
                })],
                Some("file_change") => {
                    let files: Vec<String> = item["changes"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|c| c["path"].as_str().map(String::from))
                        .collect();
                    vec![ev(ThreadEvent::ToolUse { id, name: "Edit".into(), input: serde_json::json!({ "files": files }) })]
                }
                _ => vec![],
            }
        }
        Some("turn.completed") => vec![
            ev(ThreadEvent::TurnComplete { duration_ms: elapsed_ms, cost_usd: None }),
            ev(ThreadEvent::Status { status: AgentStatus::Idle }),
        ],
        Some("turn.failed") | Some("error") => {
            let message = v["error"]["message"].as_str().or(v["message"].as_str()).unwrap_or("Codex failed").to_string();
            vec![
                ev(ThreadEvent::Error { message }),
                ev(ThreadEvent::TurnComplete { duration_ms: elapsed_ms, cost_usd: None }),
                ev(ThreadEvent::Status { status: AgentStatus::Error }),
            ]
        }
        _ => vec![],
    }
}
