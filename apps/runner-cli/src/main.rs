//! `cuna-runner`: the runner without a window.
//!
//! Phase 1 uses it to drive a thread from a shell; phase 3 adds `serve`,
//! which connects to a hub and keeps agents working while laptops are closed.

use anyhow::Result;
use cuna_protocol::{AgentStatus, ApprovalLevel, Effort, HarnessKind, NewThread, ThreadEvent};
use cuna_runner::Runner;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "cuna-runner", version, about)]
struct Cli {
    /// Data dir (default: ~/.cuna)
    #[arg(long, global = true)]
    data: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Serve the `cuna` MCP server on stdio (started by agents, not by people).
    Mcp,
    /// Keep running and host this runner's shared workspaces through a hub,
    /// so agents keep working while laptops are closed.
    Serve {
        /// Hub address, e.g. https://hub.example.com
        #[arg(long, env = "CUNA_HUB")]
        hub: String,
        /// Hub token of the account that owns the workspaces.
        #[arg(long, env = "CUNA_HUB_TOKEN")]
        token: String,
    },
    /// List the agent CLIs found on this machine.
    Detect,
    /// Start a thread in a folder and print its events as JSON lines.
    Run {
        prompt: String,
        #[arg(long, default_value = ".")]
        cwd: PathBuf,
        #[arg(long, default_value = "claude_code")]
        harness: String,
        #[arg(long)]
        model: Option<String>,
        /// Work in a separate git worktree.
        #[arg(long)]
        isolate: bool,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Mcp => cuna_runner::mcp::serve_stdio().await?,
        Cmd::Serve { hub, token } => {
            let runner = Runner::open(cli.data.unwrap_or_else(Runner::default_dir))?;
            runner.start().await?;
            let client = cuna_runner::hub::HubClient::connect(runner.clone(), hub.clone(), token);
            println!("cuna-runner: hosting {} shared workspace(s) through {hub}", runner.workspaces().iter().filter(|w| w.kind == cuna_protocol::WorkspaceKind::Shared).count());
            let _keep = client;
            tokio::signal::ctrl_c().await?;
        }
        Cmd::Detect => {
            for h in cuna_runner::detect_harnesses().await {
                let state = if h.available { h.version.unwrap_or_else(|| "available".into()) } else { "not found".into() };
                println!("{:<12} {}", serde_json::to_value(h.kind)?.as_str().unwrap_or(""), state);
            }
        }
        Cmd::Run { prompt, cwd, harness, model, isolate } => {
            let runner = Runner::open(cli.data.unwrap_or_else(Runner::default_dir))?;
            runner.start().await?;
            let harness: HarnessKind = serde_json::from_value(serde_json::Value::String(harness))?;
            let root = std::fs::canonicalize(&cwd)?;
            let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Workspace".into());
            let root_s = root.to_string_lossy().into_owned();
            let ws = match runner.workspaces().into_iter().find(|w| w.root.as_deref() == Some(root_s.as_str())) {
                Some(w) => w,
                None => runner.create_workspace(name, Some(root_s))?,
            };
            let thread = runner
                .create_thread(NewThread {
                    workspace_id: ws.id,
                    lead_id: None,
                    title: None,
                    harness,
                    model,
                    effort: Effort::Medium,
                    approval: ApprovalLevel::AskRisky,
                    isolate,
                })
                .await?;
            let mut rx = runner.subscribe_events();
            runner.send_message(thread.id, prompt, whoami()).await?;
            // Events from before subscribing are already in the log.
            for e in runner.thread_events(thread.id)? {
                println!("{}", serde_json::to_string(&e)?);
            }
            let mut seen = runner.thread_events(thread.id)?.last().map(|e| e.seq);
            loop {
                let e = rx.recv().await?;
                if e.thread_id != thread.id || seen.is_some_and(|s| e.seq <= s) {
                    continue;
                }
                seen = Some(e.seq);
                println!("{}", serde_json::to_string(&e)?);
                if let ThreadEvent::Status { status: AgentStatus::Idle | AgentStatus::Error } = e.event {
                    break;
                }
            }
            runner.stop_thread(thread.id).await?;
        }
    }
    Ok(())
}

fn whoami() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_else(|_| "you".into())
}
