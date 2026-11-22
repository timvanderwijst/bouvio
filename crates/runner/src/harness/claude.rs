//! Claude Code over `stream-json`: one long-lived process per thread, messages
//! in on stdin, events out on stdout.

use super::{HarnessOut, HarnessSession, SessionConfig};
use anyhow::{Context, Result};
use async_trait::async_trait;
use cuna_protocol::{AgentStatus, ApprovalLevel, ThreadEvent};
use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex;

pub struct ClaudeSession {
    cfg: SessionConfig,
    out: UnboundedSender<HarnessOut>,
    proc: Mutex<Option<Proc>>,
    turn_open: Arc<AtomicBool>,
}

struct Proc {
    child: Child,
    stdin: ChildStdin,
}

impl ClaudeSession {
    pub fn new(cfg: SessionConfig, out: UnboundedSender<HarnessOut>) -> Self {
        Self { cfg, out, proc: Mutex::new(None), turn_open: Arc::new(AtomicBool::new(false)) }
    }

    fn command(&self) -> Command {
        let mut cmd = Command::new("claude");
        cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
        // Approvals inside the app come with the permission-prompt tool (phase 2).
        // Until then each level maps to a Claude Code permission mode.
        let mode = match self.cfg.approval {
            ApprovalLevel::AskAll => "default",
            ApprovalLevel::AskRisky => "acceptEdits",
            ApprovalLevel::Free => "bypassPermissions",
        };
        cmd.args(["--permission-mode", mode]);
        if let Some(m) = &self.cfg.model {
            cmd.args(["--model", m]);
        }
        if let Some(id) = &self.cfg.resume {
            cmd.args(["--resume", id]);
        }
        if let Some(path) = &self.cfg.mcp_config {
            cmd.arg("--mcp-config").arg(path);
            // Cuna's own fleet tools never need a person's yes.
            cmd.args(["--allowedTools", "mcp__cuna__spawn_thread,mcp__cuna__list_threads,mcp__cuna__thread_status,mcp__cuna__create_issue,mcp__cuna__remember"]);
            if self.cfg.prompt_tool {
                cmd.args(["--permission-prompt-tool", "mcp__cuna__approve"]);
            }
        }
        if let Some(i) = self.cfg.instructions.as_deref().filter(|i| !i.trim().is_empty()) {
            cmd.args(["--append-system-prompt", i]);
        }
        cmd.current_dir(&self.cfg.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        cmd
    }

    async fn ensure_started(&self) -> Result<()> {
        let mut guard = self.proc.lock().await;
        if let Some(p) = guard.as_mut() {
            if p.child.try_wait()?.is_none() {
                return Ok(());
            }
        }
        let mut child = self.command().spawn().context("start claude; is Claude Code installed?")?;
        let stdin = child.stdin.take().context("claude stdin")?;
        let stdout = child.stdout.take().context("claude stdout")?;
        let stderr = child.stderr.take().context("claude stderr")?;

        // Claude Code prints warnings on stderr during normal runs, so stderr only
        // counts as an error when the process ends in the middle of a turn.
        let stderr_buf = Arc::new(StdMutex::new(String::new()));
        let sb = stderr_buf.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut b = sb.lock().unwrap();
                b.push_str(&line);
                b.push('\n');
            }
        });

        let out = self.out.clone();
        let turn_open = self.turn_open.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if v["type"] == "result" {
                    turn_open.store(false, Ordering::SeqCst);
                }
                for o in translate(&v) {
                    if out.send(o).is_err() {
                        return;
                    }
                }
            }
            if turn_open.swap(false, Ordering::SeqCst) {
                // Give the stderr reader a moment to drain.
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                let msg = stderr_buf.lock().unwrap().trim().to_string();
                let message = if msg.is_empty() { "Claude Code stopped unexpectedly".to_string() } else { msg };
                let _ = out.send(HarnessOut::Event(ThreadEvent::Error { message }));
                let _ = out.send(HarnessOut::Event(ThreadEvent::Status { status: AgentStatus::Error }));
            }
        });

        *guard = Some(Proc { child, stdin });
        Ok(())
    }
}

#[async_trait]
impl HarnessSession for ClaudeSession {
    async fn send(&self, text: &str) -> Result<()> {
        self.ensure_started().await?;
        self.turn_open.store(true, Ordering::SeqCst);
        let msg = json!({ "type": "user", "message": { "role": "user", "content": text } });
        let mut guard = self.proc.lock().await;
        let p = guard.as_mut().context("claude not running")?;
        p.stdin.write_all(format!("{msg}\n").as_bytes()).await?;
        p.stdin.flush().await?;
        Ok(())
    }

    async fn stop(&self) -> Result<()> {
        self.turn_open.store(false, Ordering::SeqCst);
        if let Some(mut p) = self.proc.lock().await.take() {
            let _ = p.child.kill().await;
        }
        Ok(())
    }
}

/// One line of Claude Code output to zero or more runner messages.
pub fn translate(v: &Value) -> Vec<HarnessOut> {
    let mut out = Vec::new();
    match v["type"].as_str() {
        Some("system") if v["subtype"] == "init" => {
            if let Some(id) = v["session_id"].as_str() {
                out.push(HarnessOut::SessionId(id.to_string()));
            }
            out.push(HarnessOut::Event(ThreadEvent::Status { status: AgentStatus::Working }));
        }
        Some("assistant") => {
            for block in v["message"]["content"].as_array().into_iter().flatten() {
                match block["type"].as_str() {
                    Some("text") => {
                        let text = block["text"].as_str().unwrap_or_default().to_string();
                        if !text.trim().is_empty() {
                            out.push(HarnessOut::Event(ThreadEvent::AssistantText { text }));
                        }
                    }
                    Some("tool_use") => out.push(HarnessOut::Event(ThreadEvent::ToolUse {
                        id: block["id"].as_str().unwrap_or_default().to_string(),
                        name: block["name"].as_str().unwrap_or_default().to_string(),
                        input: block["input"].clone(),
                    })),
                    _ => {}
                }
            }
        }
        Some("user") => {
            for block in v["message"]["content"].as_array().into_iter().flatten() {
                if block["type"] == "tool_result" {
                    out.push(HarnessOut::Event(ThreadEvent::ToolResult {
                        tool_use_id: block["tool_use_id"].as_str().unwrap_or_default().to_string(),
                        output: tool_result_text(&block["content"]),
                        is_error: block["is_error"].as_bool().unwrap_or(false),
                    }));
                }
            }
        }
        Some("result") => {
            if v["is_error"].as_bool().unwrap_or(false) {
                let message = v["result"].as_str().unwrap_or("Claude Code reported an error").to_string();
                out.push(HarnessOut::Event(ThreadEvent::Error { message }));
            }
            out.push(HarnessOut::Event(ThreadEvent::TurnComplete {
                duration_ms: v["duration_ms"].as_u64().unwrap_or(0),
                cost_usd: v["total_cost_usd"].as_f64(),
            }));
            let status = if v["is_error"].as_bool().unwrap_or(false) { AgentStatus::Error } else { AgentStatus::Idle };
            out.push(HarnessOut::Event(ThreadEvent::Status { status }));
        }
        _ => {}
    }
    out
}

fn tool_result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(line: &str) -> Vec<ThreadEvent> {
        translate(&serde_json::from_str(line).unwrap())
            .into_iter()
            .filter_map(|o| match o {
                HarnessOut::Event(e) => Some(e),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn init_gives_session_and_working() {
        let v = serde_json::json!({"type":"system","subtype":"init","session_id":"abc"});
        let out = translate(&v);
        assert!(matches!(&out[0], HarnessOut::SessionId(s) if s == "abc"));
        assert!(matches!(&out[1], HarnessOut::Event(ThreadEvent::Status { status: AgentStatus::Working })));
    }

    #[test]
    fn assistant_text_and_tool_use() {
        let e = events(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Looking."},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.rs"}}]}}"#);
        assert!(matches!(&e[0], ThreadEvent::AssistantText { text } if text == "Looking."));
        assert!(matches!(&e[1], ThreadEvent::ToolUse { name, .. } if name == "Read"));
    }

    #[test]
    fn tool_result_array_content() {
        let e = events(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"ok"}]}]}}"#);
        assert!(matches!(&e[0], ThreadEvent::ToolResult { output, is_error: false, .. } if output == "ok"));
    }

    #[test]
    fn result_completes_turn() {
        let e = events(r#"{"type":"result","subtype":"success","duration_ms":4100,"total_cost_usd":0.41,"is_error":false,"result":"done"}"#);
        assert!(matches!(&e[0], ThreadEvent::TurnComplete { duration_ms: 4100, cost_usd: Some(c) } if (*c - 0.41).abs() < 1e-9));
        assert!(matches!(&e[1], ThreadEvent::Status { status: AgentStatus::Idle }));
    }
}
