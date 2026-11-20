//! Platform: updates, plugins, OS notifications.

use crate::App;
use anyhow::Result;
use serde_json::Value;
use std::sync::Arc;

pub async fn call(_app: &Arc<App>, _method: &str, _params: &Value) -> Option<Result<Value>> {
    None
}

pub fn setup(_app: &Arc<App>, _handle: &tauri::AppHandle) {}

pub fn plugins<R: tauri::Runtime>(b: tauri::Builder<R>) -> tauri::Builder<R> {
    b
}
