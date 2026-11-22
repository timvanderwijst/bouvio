//! Adapters that drive an agent CLI and translate its output into `ThreadEvent`s.

pub mod claude;
pub mod codex;

use anyhow::Result;
use async_trait::async_trait;
use cuna_protocol::{ApprovalLevel, Effort, HarnessKind, ThreadEvent};
use std::path::PathBuf;
use tokio::sync::mpsc::UnboundedSender;

/// What a harness reports back to the runner.
#[derive(Debug)]
pub enum HarnessOut {
    Event(ThreadEvent),
    /// The harness's own session id, kept so a thread can resume after a restart.
    SessionId(String),
}

pub struct SessionConfig {
    pub cwd: PathBuf,
    pub model: Option<String>,
    pub effort: Effort,
    pub approval: ApprovalLevel,
    pub resume: Option<String>,
    pub instructions: Option<String>,
    /// `--mcp-config` file with the `cuna` server and the workspace's servers.
    pub mcp_config: Option<PathBuf>,
    /// Route permission prompts to people through `mcp__cuna__approve`.
    pub prompt_tool: bool,
}

#[async_trait]
pub trait HarnessSession: Send + Sync {
    /// Send a user message. Output arrives on the session's channel.
    async fn send(&self, text: &str) -> Result<()>;
    /// Stop the current turn and the process behind it.
    async fn stop(&self) -> Result<()>;
}

pub fn start(
    kind: HarnessKind,
    cfg: SessionConfig,
    out: UnboundedSender<HarnessOut>,
) -> Result<Box<dyn HarnessSession>> {
    match kind {
        HarnessKind::ClaudeCode => Ok(Box::new(claude::ClaudeSession::new(cfg, out))),
        HarnessKind::Codex => Ok(Box::new(codex::CodexSession::new(cfg, out))),
        other => anyhow::bail!("{other:?} is not supported yet"),
    }
}
