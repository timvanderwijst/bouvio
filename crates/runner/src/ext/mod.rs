//! Feature areas that plug into the runner, each in its own module with the
//! same shape:
//!
//! - `call` answers the runner methods it owns (`None` = not mine),
//! - `workspace_of` names the workspace a call touches, for hub scoping,
//! - `start` runs background work once the runner is up.
//!
//! The runner never depends on provider code; the app plugs in model access
//! through [`Hooks`].

pub mod comms;
pub mod dev;
pub mod knowledge;
pub mod office;
pub mod personal;
pub mod platform;

use crate::Runner;
use anyhow::Result;
use futures::future::BoxFuture;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

/// Embed texts into vectors (local model or a provider), set by the app.
pub type EmbedFn = Arc<dyn Fn(Vec<String>) -> BoxFuture<'static, Result<Vec<Vec<f32>>>> + Send + Sync>;
/// One-shot text completion for summaries, briefs and evals, set by the app.
/// Arguments: model (provider-qualified, or None for the default), system prompt, user prompt.
pub type CompleteFn = Arc<dyn Fn(Option<String>, String, String) -> BoxFuture<'static, Result<String>> + Send + Sync>;

#[derive(Default)]
pub struct Hooks {
    pub embed: Mutex<Option<EmbedFn>>,
    pub complete: Mutex<Option<CompleteFn>>,
}

impl Hooks {
    pub fn embed(&self) -> Option<EmbedFn> {
        self.embed.lock().unwrap().clone()
    }
    pub fn complete(&self) -> Option<CompleteFn> {
        self.complete.lock().unwrap().clone()
    }
}

pub async fn call(r: &Arc<Runner>, method: &str, params: &Value, actor: &str) -> Option<Result<Value>> {
    if let Some(x) = office::call(r, method, params, actor).await {
        return Some(x);
    }
    if let Some(x) = knowledge::call(r, method, params, actor).await {
        return Some(x);
    }
    if let Some(x) = dev::call(r, method, params, actor).await {
        return Some(x);
    }
    if let Some(x) = personal::call(r, method, params, actor).await {
        return Some(x);
    }
    if let Some(x) = platform::call(r, method, params, actor).await {
        return Some(x);
    }
    comms::call(r, method, params, actor).await
}

pub fn workspace_of(r: &Runner, method: &str, params: &Value) -> Option<Result<Uuid>> {
    office::workspace_of(r, method, params)
        .or_else(|| knowledge::workspace_of(r, method, params))
        .or_else(|| dev::workspace_of(r, method, params))
        .or_else(|| personal::workspace_of(r, method, params))
        .or_else(|| platform::workspace_of(r, method, params))
        .or_else(|| comms::workspace_of(r, method, params))
}

pub fn start(r: &Arc<Runner>) {
    office::start(r);
    knowledge::start(r);
    dev::start(r);
    personal::start(r);
    platform::start(r);
    comms::start(r);
}
