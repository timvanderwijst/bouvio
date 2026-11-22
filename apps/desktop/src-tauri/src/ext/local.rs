//! Local AI: Ollama/LM Studio, whisper.cpp, Piper, ComfyUI, local embeddings; plugs embeddings and completions into the runner.
//!
//! App methods:
//! - `local_status` → `LocalStatus`
//! - `local_config_get` → `LocalConfig`; `local_config_set {config}` → `LocalConfig` (saved to `<data dir>/local.json`)
//! - `local_pull {model}` → null; progress as `local-progress` events (`LocalProgress`)
//! - `local_download {kind: "whisper"|"piper", name}` → null; progress as `local-progress`
//! - `local_recommended` → `LocalRecommended[]`

use crate::App;
use anyhow::{anyhow, bail, Result};
use cuna_agent::local::{self, LocalConfig, LocalProgress};
use cuna_agent::KeyringStore;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Emitter;

static HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Pulls and downloads running now, so a second click does not start another.
fn busy() -> &'static Mutex<HashSet<String>> {
    static B: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    B.get_or_init(Default::default)
}

fn config_path(app: &App) -> PathBuf {
    app.runner.store().dir().join("local.json")
}

fn emit(p: LocalProgress) {
    if let Some(h) = HANDLE.get() {
        let _ = h.emit("local-progress", p);
    }
}

fn failed(kind: &str, name: &str, e: &anyhow::Error) -> LocalProgress {
    LocalProgress {
        kind: kind.into(),
        name: name.into(),
        status: "error".into(),
        completed: None,
        total: None,
        done: true,
        error: Some(format!("{e:#}")),
    }
}

/// Run a pull or download in the background; its progress and end arrive as events.
fn background<F>(kind: &str, name: String, work: F) -> Result<Value>
where
    F: std::future::Future<Output = Result<()>> + Send + 'static,
{
    let key = format!("{kind}:{name}");
    if !busy().lock().unwrap().insert(key.clone()) {
        return Ok(json!({ "started": false }));
    }
    let kind = kind.to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = work.await {
            emit(failed(&kind, &name, &e));
        }
        busy().lock().unwrap().remove(&key);
    });
    Ok(json!({ "started": true }))
}

fn str_param<'a>(params: &'a Value, name: &str) -> Result<&'a str> {
    params[name].as_str().map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| anyhow!("`{name}` is missing"))
}

pub async fn call(app: &Arc<App>, method: &str, params: &Value) -> Option<Result<Value>> {
    let r = match method {
        "local_status" => Ok(serde_json::to_value(local::status().await).unwrap_or_default()),
        "local_config_get" => Ok(serde_json::to_value(local::config()).unwrap_or_default()),
        "local_config_set" => set_config(app, params),
        "local_recommended" => Ok(serde_json::to_value(local::recommended()).unwrap_or_default()),
        "local_pull" => match str_param(params, "model") {
            Ok(model) => {
                let model = model.strip_prefix("local:").unwrap_or(model).to_string();
                let m = model.clone();
                background("ollama", model, async move { local::pull(&m, emit).await })
            }
            Err(e) => Err(e),
        },
        "local_download" => match (str_param(params, "kind"), str_param(params, "name")) {
            (Ok(kind), Ok(name)) if kind == "whisper" || kind == "piper" => {
                let (k, n) = (kind.to_string(), name.to_string());
                background(kind, name.to_string(), async move { local::download(&k, &n, emit).await.map(|_| ()) })
            }
            (Ok(kind), Ok(_)) => Err(anyhow!("Unknown download kind {kind:?}; use whisper or piper")),
            (Err(e), _) | (_, Err(e)) => Err(e),
        },
        _ => return None,
    };
    Some(r)
}

fn set_config(app: &App, params: &Value) -> Result<Value> {
    let c: LocalConfig = serde_json::from_value(params["config"].clone()).map_err(|e| anyhow!("Bad local settings: {e}"))?;
    if !c.default_model.is_empty() && !c.default_model.contains(':') {
        bail!("The default model needs a provider prefix, like local:qwen3:8b");
    }
    local::set_config(c);
    let saved = local::config();
    local::save_config(&config_path(app), &saved)?;
    Ok(serde_json::to_value(saved)?)
}

pub fn setup(app: &Arc<App>, handle: &tauri::AppHandle) {
    let _ = HANDLE.set(handle.clone());
    local::set_models_dir(app.runner.store().dir().join("local"));
    local::set_config(local::load_config(&config_path(app)));

    // Model access for the other areas (briefs, search, evals): local first, then keys.
    *app.runner.hooks.embed.lock().unwrap() =
        Some(Arc::new(|texts: Vec<String>| Box::pin(async move { cuna_agent::embed(&KeyringStore, &texts).await })));
    *app.runner.hooks.complete.lock().unwrap() = Some(Arc::new(|model: Option<String>, system: String, user: String| {
        Box::pin(async move { cuna_agent::complete(&KeyringStore, model.as_deref(), &system, &user).await })
    }));

    // Warm the detection cache so the first `providers` call already knows.
    tauri::async_runtime::spawn(async {
        local::reachable().await;
    });
}
