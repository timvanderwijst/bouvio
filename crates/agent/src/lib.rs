//! Bouvio's own agent loop for people who connect API keys (OpenRouter,
//! Anthropic, OpenAI, Google) instead of running Claude Code or Codex, plus
//! model listing and media generation with those keys.
//!
//! Keys belong to the user and live in the OS keychain ([`KeyringStore`]);
//! Bouvio never pays for a call.
//!
//! A turn ([`Agent::turn`]) streams `ThreadEvent`s on a channel, in this order:
//! `Status{Working}`, then per model step any `AssistantText`, one `ToolUse`
//! per call, and for each call (after `Status{Blocked}` → [`AgentOut::Approval`]
//! → `Status{Working}` when it needs a yes) its `ToolResult`; finally
//! `TurnComplete{duration_ms, cost_usd}` and `Status{Idle}` — or `Error`,
//! `TurnComplete`, `Status{Error}` when something failed.

mod agent;
pub mod keys;
pub mod media;
mod models;
mod pricing;
mod provider;
pub mod tools;

pub use agent::{Agent, AgentConfig, AgentOut};
pub use keys::{KeyStore, KeyringStore, StaticKeys};
pub use models::list_models;
pub use tokio_util::sync::CancellationToken;
pub use tools::{Tool, ToolCtx};
