//! Local AI: Ollama/LM Studio, whisper.cpp, Piper, ComfyUI, local embeddings; plugs embeddings and completions into the runner.

use crate::App;
use anyhow::Result;
use serde_json::Value;
use std::sync::Arc;

pub async fn call(_app: &Arc<App>, _method: &str, _params: &Value) -> Option<Result<Value>> {
    None
}

pub fn setup(_app: &Arc<App>, _handle: &tauri::AppHandle) {}
