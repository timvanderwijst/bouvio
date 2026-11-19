//! The agent loop: send the conversation, run the tools the model asks for,
//! repeat until it answers without tools.

use crate::keys::KeyStore;
use crate::pricing;
use crate::provider::{self, Message, ModelRef, Part, Request, Role, Stop, ToolSpec};
use crate::tools::{self, Tool, ToolCtx};
use anyhow::{anyhow, bail, Result};
use bouvio_protocol::{AgentStatus, ApprovalLevel, ThreadEvent};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{mpsc::UnboundedSender, oneshot};
use tokio_util::sync::CancellationToken;

/// What a turn sends back to the runner.
#[derive(Debug)]
pub enum AgentOut {
    Event(ThreadEvent),
    /// Ask a person; the loop waits for the reply (false on drop).
    Approval { id: String, tool: String, input: serde_json::Value, reply: oneshot::Sender<bool> },
}

pub struct AgentConfig {
    pub cwd: PathBuf,
    /// Provider-qualified: "openrouter:anthropic/claude-sonnet-4.5", "anthropic:claude-sonnet-4-5", "openai:gpt-4.1", "google:gemini-2.5-pro"
    pub model: String,
    pub instructions: Option<String>,
    pub approval: ApprovalLevel,
    pub keys: Arc<dyn KeyStore>,
    /// The runner adds fleet tools (spawn_thread…). A tool with the same name as a
    /// built-in one replaces it.
    pub extra_tools: Vec<Arc<dyn Tool>>,
    /// Model calls per turn before the loop stops (default 50).
    pub max_steps: usize,
}

impl AgentConfig {
    /// Defaults: no instructions, `AskRisky`, no extra tools, 50 steps.
    pub fn new(cwd: impl Into<PathBuf>, model: impl Into<String>, keys: Arc<dyn KeyStore>) -> Self {
        Self {
            cwd: cwd.into(),
            model: model.into(),
            instructions: None,
            approval: ApprovalLevel::AskRisky,
            keys,
            extra_tools: Vec::new(),
            max_steps: 50,
        }
    }
}

const SAVE_VERSION: u64 = 1;
/// Cap on any tool result sent back to the model.
const MAX_TOOL_OUTPUT: usize = 100_000;

pub struct Agent {
    cfg: AgentConfig,
    tools: Vec<Arc<dyn Tool>>,
    history: Vec<Message>,
}

/// How the tool part of a step ended.
enum StepEnd {
    Continue,
    Cancelled,
}

impl Agent {
    pub fn new(mut cfg: AgentConfig) -> Self {
        cfg.cwd = std::path::absolute(&cfg.cwd).unwrap_or(cfg.cwd);
        if cfg.max_steps == 0 {
            cfg.max_steps = 50;
        }
        let mut tools = tools::builtin(&cfg.cwd);
        for extra in &cfg.extra_tools {
            tools.retain(|t| t.name() != extra.name());
            tools.push(extra.clone());
        }
        Self { cfg, tools, history: Vec::new() }
    }

    pub fn config(&self) -> &AgentConfig {
        &self.cfg
    }

    /// Switch model between turns; the history carries over.
    pub fn set_model(&mut self, model: impl Into<String>) {
        self.cfg.model = model.into();
    }

    pub fn set_approval(&mut self, approval: ApprovalLevel) {
        self.cfg.approval = approval;
    }

    /// History as JSON so the runner can persist and resume a thread.
    pub fn save(&self) -> serde_json::Value {
        json!({ "version": SAVE_VERSION, "model": self.cfg.model, "messages": self.history })
    }

    pub fn restore(cfg: AgentConfig, saved: serde_json::Value) -> anyhow::Result<Self> {
        let version = saved["version"].as_u64().ok_or_else(|| anyhow!("Saved agent history has no version"))?;
        if version > SAVE_VERSION {
            bail!("Saved agent history is version {version}; this build reads up to {SAVE_VERSION}");
        }
        let history: Vec<Message> = serde_json::from_value(saved["messages"].clone())
            .map_err(|e| anyhow!("Saved agent history is damaged: {e}"))?;
        let mut agent = Self::new(cfg);
        agent.history = history;
        Ok(agent)
    }

    fn system_prompt(&self) -> String {
        let os = match std::env::consts::OS {
            "macos" => "macOS",
            "windows" => "Windows",
            "linux" => "Linux",
            other => other,
        };
        let shell = if cfg!(windows) { "cmd.exe" } else { "bash" };
        let mut s = format!(
            "You are a capable coding agent working inside Bouvio, a workspace where people and AI agents work together. \
You help with software engineering and other tasks in the project, using the tools you have.\n\n\
- Use the tools to look things up instead of guessing. Read a file before you change it; prefer edit_file for changes to existing files.\n\
- Keep paths relative to the working directory. Do not touch files outside it unless asked.\n\
- Run builds and tests with bash to check your work. Commands must not wait for input.\n\
- If a tool call is denied, do not try to get around it; ask or take another approach.\n\
- Be concise. When done, say briefly what you changed and anything left open.\n\n\
Working directory: {}\nOperating system: {os} (shell: {shell})\nToday: {}",
            self.cfg.cwd.display(),
            chrono::Local::now().format("%Y-%m-%d"),
        );
        if let Some(i) = self.cfg.instructions.as_deref().map(str::trim).filter(|i| !i.is_empty()) {
            s.push_str("\n\n# Instructions\n\n");
            s.push_str(i);
        }
        s
    }

    fn tool(&self, name: &str) -> Option<&Arc<dyn Tool>> {
        self.tools.iter().find(|t| t.name() == name)
    }

    /// Run one user turn to completion: stream tool calls/results/text as ThreadEvents,
    /// end with TurnComplete{duration_ms, cost_usd}.
    ///
    /// Provider and tool failures are reported as events (`Error`, then
    /// `TurnComplete` and `Status{Error}`) and the call still returns `Ok`. It
    /// returns `Err` only when `out` is closed.
    pub async fn turn(&mut self, user_text: &str, out: UnboundedSender<AgentOut>, cancel: CancellationToken) -> anyhow::Result<()> {
        let started = Instant::now();
        let mut cost: Option<f64> = Some(0.0);
        emit(&out, ThreadEvent::Status { status: AgentStatus::Working })?;
        self.history.push(Message::user_text(user_text));

        let model = match ModelRef::parse(&self.cfg.model) {
            Ok(m) => m,
            Err(e) => return self.fail(&out, started, None, e.to_string()),
        };
        let Some(key) = self.cfg.keys.get(model.provider) else {
            return self.fail(&out, started, None, provider::missing_key(model.provider));
        };
        let specs: Vec<ToolSpec> = self
            .tools
            .iter()
            .map(|t| ToolSpec { name: t.name().to_string(), description: t.description().to_string(), schema: t.schema() })
            .collect();
        let system = self.system_prompt();

        for _ in 0..self.cfg.max_steps {
            let req = Request { system: &system, messages: &self.history, tools: &specs };
            let reply = match provider::complete(&model, &key, &req, &cancel).await {
                Ok(r) => r,
                Err(e) if provider::is_cancelled(&e) => return self.finish(&out, started, cost, AgentStatus::Idle),
                Err(e) => return self.fail(&out, started, cost, format!("{e:#}")),
            };
            cost = match (cost, pricing::cost(model.provider, &model.model, &reply.usage)) {
                (Some(a), Some(b)) => Some(a + b),
                _ => None,
            };

            let calls: Vec<(String, String, Value)> = reply
                .parts
                .iter()
                .filter_map(|p| match p {
                    Part::ToolCall { id, name, input, .. } => Some((id.clone(), name.clone(), input.clone())),
                    _ => None,
                })
                .collect();
            for p in &reply.parts {
                match p {
                    Part::Text { text } if !text.trim().is_empty() => emit(&out, ThreadEvent::AssistantText { text: text.clone() })?,
                    Part::ToolCall { id, name, input, .. } => emit(
                        &out,
                        ThreadEvent::ToolUse {
                            id: id.clone(),
                            name: self.tool(name).map(|t| t.display_name().to_string()).unwrap_or_else(|| name.clone()),
                            input: input.clone(),
                        },
                    )?,
                    _ => {}
                }
            }
            if !reply.parts.is_empty() {
                self.history.push(Message { role: Role::Assistant, parts: reply.parts });
            }

            if calls.is_empty() {
                match reply.stop {
                    Stop::Pause => continue,
                    Stop::Refusal(why) => return self.fail(&out, started, cost, why),
                    Stop::MaxTokens => {
                        return self.fail(&out, started, cost, "The model hit its output limit before finishing. Ask it to continue.".into())
                    }
                    _ => return self.finish(&out, started, cost, AgentStatus::Idle),
                }
            }

            match self.run_tools(calls, &out, &cancel).await? {
                StepEnd::Continue => {}
                StepEnd::Cancelled => return self.finish(&out, started, cost, AgentStatus::Idle),
            }
            if cancel.is_cancelled() {
                return self.finish(&out, started, cost, AgentStatus::Idle);
            }
        }
        let steps = self.cfg.max_steps;
        self.fail(&out, started, cost, format!("Stopped after {steps} steps without finishing. Send a message to let it go on."))
    }

    /// Run the calls in order and append their results as one user message.
    async fn run_tools(
        &mut self,
        calls: Vec<(String, String, Value)>,
        out: &UnboundedSender<AgentOut>,
        cancel: &CancellationToken,
    ) -> Result<StepEnd> {
        let mut results = Vec::new();
        let mut end = StepEnd::Continue;
        for (id, name, input) in calls {
            let (output, is_error) = if matches!(end, StepEnd::Cancelled) || cancel.is_cancelled() {
                end = StepEnd::Cancelled;
                ("Cancelled by the user before this ran.".to_string(), true)
            } else {
                let (o, e, cancelled) = self.run_tool(&name, input, out, cancel).await?;
                if cancelled {
                    end = StepEnd::Cancelled;
                }
                (o, e)
            };
            emit(out, ThreadEvent::ToolResult { tool_use_id: id.clone(), output: output.clone(), is_error })?;
            results.push(Part::ToolResult { id, output, is_error });
        }
        // Every call gets a result, so the history stays valid even after a cancel.
        self.history.push(Message { role: Role::User, parts: results });
        Ok(end)
    }

    /// One tool call → (output, is_error, cancelled).
    async fn run_tool(
        &self,
        name: &str,
        input: Value,
        out: &UnboundedSender<AgentOut>,
        cancel: &CancellationToken,
    ) -> Result<(String, bool, bool)> {
        let Some(tool) = self.tool(name).cloned() else {
            return Ok((format!("Unknown tool `{name}`. Use one of the tools you were given."), true, false));
        };
        if !input.is_object() {
            return Ok(("The tool input was not a valid JSON object; call the tool again with valid arguments.".into(), true, false));
        }
        let ask = match self.cfg.approval {
            ApprovalLevel::AskAll => true,
            ApprovalLevel::AskRisky => tool.risky(&input),
            ApprovalLevel::Free => false,
        };
        if ask {
            let (tx, rx) = oneshot::channel();
            emit(out, ThreadEvent::Status { status: AgentStatus::Blocked })?;
            out.send(AgentOut::Approval {
                id: uuid::Uuid::new_v4().to_string(),
                tool: tool.display_name().to_string(),
                input: input.clone(),
                reply: tx,
            })
            .map_err(|_| anyhow!("The agent's output channel is closed"))?;
            let allowed = tokio::select! {
                _ = cancel.cancelled() => None,
                r = rx => Some(r.unwrap_or(false)),
            };
            emit(out, ThreadEvent::Status { status: AgentStatus::Working })?;
            match allowed {
                None => return Ok(("Cancelled by the user while waiting for approval.".into(), true, true)),
                Some(false) => {
                    return Ok((
                        "Denied by the user. Do not retry this or work around it; continue another way or ask what they want.".into(),
                        true,
                        false,
                    ))
                }
                Some(true) => {}
            }
        }
        let ctx = ToolCtx { cwd: self.cfg.cwd.clone(), cancel: cancel.child_token() };
        let res = tokio::select! {
            r = tool.call(input, &ctx) => Some(r),
            _ = cancel.cancelled() => None,
        };
        Ok(match res {
            None => ("Cancelled by the user.".into(), true, true),
            Some(Ok(s)) => (tools::truncate_middle(if s.is_empty() { "(no output)" } else { &s }, MAX_TOOL_OUTPUT), false, false),
            Some(Err(e)) => (tools::truncate_middle(&format!("{e:#}"), MAX_TOOL_OUTPUT), true, cancel.is_cancelled()),
        })
    }

    fn finish(&self, out: &UnboundedSender<AgentOut>, started: Instant, cost: Option<f64>, status: AgentStatus) -> Result<()> {
        emit(out, ThreadEvent::TurnComplete { duration_ms: started.elapsed().as_millis() as u64, cost_usd: cost })?;
        emit(out, ThreadEvent::Status { status })
    }

    fn fail(&self, out: &UnboundedSender<AgentOut>, started: Instant, cost: Option<f64>, message: String) -> Result<()> {
        emit(out, ThreadEvent::Error { message })?;
        self.finish(out, started, cost, AgentStatus::Error)
    }
}

fn emit(out: &UnboundedSender<AgentOut>, e: ThreadEvent) -> Result<()> {
    out.send(AgentOut::Event(e)).map_err(|_| anyhow!("The agent's output channel is closed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::StaticKeys;

    fn cfg() -> AgentConfig {
        AgentConfig::new(std::env::temp_dir(), "openai:gpt-4.1", Arc::new(StaticKeys::new()))
    }

    #[test]
    fn save_restore_roundtrip() {
        let mut a = Agent::new(cfg());
        a.history = vec![
            Message::user_text("hi"),
            Message {
                role: Role::Assistant,
                parts: vec![
                    Part::Opaque { provider: "anthropic".into(), value: json!({"type":"thinking","signature":"x"}) },
                    Part::Text { text: "hello".into() },
                    Part::ToolCall { id: "c1".into(), name: "bash".into(), input: json!({"command":"ls"}), extra: None },
                ],
            },
            Message { role: Role::User, parts: vec![Part::ToolResult { id: "c1".into(), output: "a\nb".into(), is_error: false }] },
        ];
        let saved = a.save();
        let text = serde_json::to_string(&saved).unwrap();
        let b = Agent::restore(cfg(), serde_json::from_str(&text).unwrap()).unwrap();
        assert_eq!(a.history, b.history);
        assert_eq!(b.save(), saved);
        assert!(Agent::restore(cfg(), json!({"version": 99, "messages": []})).is_err());
        assert!(Agent::restore(cfg(), json!({"messages": []})).is_err());
    }

    #[test]
    fn system_prompt_has_cwd_os_and_instructions() {
        let mut c = cfg();
        c.instructions = Some("Always write tests.".into());
        let a = Agent::new(c);
        let s = a.system_prompt();
        assert!(s.contains(&format!("Working directory: {}", a.cfg.cwd.display())));
        assert!(s.contains("Operating system: "));
        assert!(s.ends_with("Always write tests."));
    }

    #[tokio::test]
    async fn missing_key_is_reported() {
        let mut c = cfg();
        c.model = "openrouter:anthropic/claude-sonnet-4.5".into();
        let mut a = Agent::new(c);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        a.turn("hi", tx, CancellationToken::new()).await.unwrap();
        let mut events = Vec::new();
        while let Ok(AgentOut::Event(e)) = rx.try_recv() {
            events.push(e);
        }
        assert!(matches!(&events[0], ThreadEvent::Status { status: AgentStatus::Working }));
        assert!(matches!(&events[1], ThreadEvent::Error { message } if message == "Add an OpenRouter key in Settings"));
        assert!(matches!(&events[2], ThreadEvent::TurnComplete { cost_usd: None, .. }));
        assert!(matches!(&events[3], ThreadEvent::Status { status: AgentStatus::Error }));
    }

    #[test]
    fn extra_tools_replace_builtins() {
        struct Fake;
        #[async_trait::async_trait]
        impl Tool for Fake {
            fn name(&self) -> &str {
                "bash"
            }
            fn description(&self) -> &str {
                "fake"
            }
            fn schema(&self) -> Value {
                json!({"type":"object"})
            }
            fn risky(&self, _: &Value) -> bool {
                false
            }
            async fn call(&self, _: Value, _: &ToolCtx) -> Result<String> {
                Ok("fake".into())
            }
        }
        let mut c = cfg();
        c.extra_tools = vec![Arc::new(Fake)];
        let a = Agent::new(c);
        assert_eq!(a.tools.iter().filter(|t| t.name() == "bash").count(), 1);
        assert_eq!(a.tool("bash").unwrap().description(), "fake");
        assert_eq!(a.tools.len(), 8);
    }
}
