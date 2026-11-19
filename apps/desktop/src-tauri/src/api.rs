//! Plugs Bouvio's own agent loop (API keys, OpenRouter) into the runner as the
//! `api` harness.

use anyhow::Result;
use async_trait::async_trait;
use bouvio_agent::{Agent, AgentConfig, AgentOut, KeyringStore, Tool, ToolCtx};
use bouvio_protocol::{AgentStatus, ThreadEvent};
use bouvio_runner::harness::{HarnessOut, HarnessSession, SessionConfig};
use bouvio_runner::Runner;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub fn factory() -> bouvio_runner::ApiFactory {
    Arc::new(|runner, thread, cfg, out| Ok(Box::new(ApiSession::new(runner, thread.id, thread.model.clone(), cfg, out)?)))
}

struct ApiSession {
    runner: Arc<Runner>,
    thread_id: Uuid,
    agent: Arc<Mutex<Agent>>,
    out: mpsc::UnboundedSender<HarnessOut>,
    cancel: std::sync::Mutex<CancellationToken>,
    save_to: PathBuf,
}

impl ApiSession {
    fn new(runner: Arc<Runner>, thread_id: Uuid, model: Option<String>, cfg: SessionConfig, out: mpsc::UnboundedSender<HarnessOut>) -> Result<Self> {
        let model = model.ok_or_else(|| anyhow::anyhow!("choose a model for this thread"))?;
        let tools: Vec<Arc<dyn Tool>> = bouvio_runner::mcp::tools()
            .as_array()
            .into_iter()
            .flatten()
            .filter(|t| t["name"] != "approve")
            .map(|t| Arc::new(FleetTool { runner: runner.clone(), thread_id, def: t.clone() }) as Arc<dyn Tool>)
            .collect();
        let config = AgentConfig {
            cwd: cfg.cwd,
            model,
            instructions: cfg.instructions,
            approval: cfg.approval,
            keys: Arc::new(KeyringStore),
            extra_tools: tools,
            max_steps: 50,
        };
        let save_to = runner.store().dir().join("agents").join(format!("{thread_id}.json"));
        let agent = match std::fs::read(&save_to).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
            Some(saved) => Agent::restore(config, saved)?,
            None => Agent::new(config),
        };
        Ok(Self { runner, thread_id, agent: Arc::new(Mutex::new(agent)), out, cancel: std::sync::Mutex::new(CancellationToken::new()), save_to })
    }
}

#[async_trait]
impl HarnessSession for ApiSession {
    async fn send(&self, text: &str) -> Result<()> {
        let cancel = CancellationToken::new();
        *self.cancel.lock().unwrap() = cancel.clone();
        let (tx, mut rx) = mpsc::unbounded_channel::<AgentOut>();
        let out = self.out.clone();
        let runner = self.runner.clone();
        let thread_id = self.thread_id;
        // Approvals go to the people in the thread; events go straight through.
        tokio::spawn(async move {
            while let Some(o) = rx.recv().await {
                match o {
                    AgentOut::Event(e) => {
                        let _ = out.send(HarnessOut::Event(e));
                    }
                    AgentOut::Approval { tool, input, reply, .. } => {
                        let r = runner.clone();
                        tokio::spawn(async move {
                            let _ = reply.send(r.request_approval(thread_id, tool, input).await);
                        });
                    }
                }
            }
        });
        let agent = self.agent.clone();
        let text = text.to_string();
        let out = self.out.clone();
        let save_to = self.save_to.clone();
        tokio::spawn(async move {
            let mut a = agent.lock().await;
            if let Err(e) = a.turn(&text, tx, cancel).await {
                let _ = out.send(HarnessOut::Event(ThreadEvent::Error { message: format!("{e:#}") }));
                let _ = out.send(HarnessOut::Event(ThreadEvent::Status { status: AgentStatus::Error }));
            } else {
                let _ = out.send(HarnessOut::Event(ThreadEvent::Status { status: AgentStatus::Idle }));
            }
            if let Some(dir) = save_to.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&save_to, serde_json::to_vec(&a.save()).unwrap_or_default());
        });
        Ok(())
    }

    async fn stop(&self) -> Result<()> {
        self.cancel.lock().unwrap().cancel();
        Ok(())
    }
}

/// The `bouvio` fleet tools (spawn_thread, …) for API agents.
struct FleetTool {
    runner: Arc<Runner>,
    thread_id: Uuid,
    def: Value,
}

#[async_trait]
impl Tool for FleetTool {
    fn name(&self) -> &str {
        self.def["name"].as_str().unwrap_or("")
    }
    fn description(&self) -> &str {
        self.def["description"].as_str().unwrap_or("")
    }
    fn schema(&self) -> Value {
        self.def["inputSchema"].clone()
    }
    fn risky(&self, _input: &Value) -> bool {
        false
    }
    async fn call(&self, input: Value, _ctx: &ToolCtx) -> Result<String> {
        let v = self.runner.fleet_call(self.thread_id, self.name(), input).await?;
        Ok(v.as_str().map(String::from).unwrap_or_else(|| v.to_string()))
    }
}
