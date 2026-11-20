//! App-side feature areas: things that need the desktop itself rather than the
//! runner (local models, OS integration, updates). Each module answers
//! `app_call` methods it owns and may plug model access into the runner.

pub mod local;
pub mod platform;

use crate::App;
use anyhow::Result;
use serde_json::Value;
use std::sync::Arc;

pub async fn call(app: &Arc<App>, method: &str, params: &Value) -> Option<Result<Value>> {
    if let Some(r) = local::call(app, method, params).await {
        return Some(r);
    }
    platform::call(app, method, params).await
}

/// Runs once in Tauri's setup, after the runner has started.
pub fn setup(app: &Arc<App>, handle: &tauri::AppHandle) {
    local::setup(app, handle);
    platform::setup(app, handle);
}

/// Extra Tauri plugins an area needs.
pub fn plugins<R: tauri::Runtime>(b: tauri::Builder<R>) -> tauri::Builder<R> {
    platform::plugins(b)
}
