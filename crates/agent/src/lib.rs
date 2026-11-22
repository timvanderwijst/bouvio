//! Cuna's own agent loop for people who connect API keys (OpenRouter,
//! Anthropic, OpenAI, Google) or run models on their own machine (Ollama,
//! LM Studio, any OpenAI-compatible server; see [`local`]) instead of running
//! Claude Code or Codex, plus model listing, one-shot completions, embeddings
//! and media generation.
//!
//! Keys belong to the user and live in the OS keychain ([`KeyringStore`]);
//! Cuna never pays for a call.
//!
//! A turn ([`Agent::turn`]) streams `ThreadEvent`s on a channel, in this order:
//! `Status{Working}`, then per model step any `AssistantText`, one `ToolUse`
//! per call, and for each call (after `Status{Blocked}` → [`AgentOut::Approval`]
//! → `Status{Working}` when it needs a yes) its `ToolResult`; finally
//! `TurnComplete{duration_ms, cost_usd}` and `Status{Idle}` — or `Error`,
//! `TurnComplete`, `Status{Error}` when something failed.

mod agent;
pub mod keys;
pub mod local;
pub mod media;
mod models;
mod oneshot;
mod pricing;
mod provider;
pub mod tools;

pub use agent::{Agent, AgentConfig, AgentOut};
pub use keys::{KeyStore, KeyringStore, StaticKeys};
pub use models::list_models;
pub use oneshot::{complete, embed, resolve_model};
pub use tokio_util::sync::CancellationToken;
pub use tools::{Tool, ToolCtx};
