//! The desktop app: the runner built in, a hub connection, and a thin set of
//! Tauri commands. Almost everything goes through `rpc`, which runs locally or,
//! for workspaces someone else hosts, through the hub.

mod api;
mod hub;

use base64::Engine;
use bouvio_agent::{media, KeyringStore};
use bouvio_protocol::*;
use bouvio_runner::{terminal::TerminalOut, Runner};
use hub::Hub;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

type R<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    format!("{e:#}").trim_start_matches("Error: ").to_string()
}

struct App {
    runner: Arc<Runner>,
    hub: Hub,
}

#[tauri::command]
async fn rpc(app: State<'_, Arc<App>>, workspace_id: Option<Uuid>, method: String, params: Value, actor: String) -> R<Value> {
    if method == "list_workspaces" {
        let mut all = app.runner.workspaces();
        all.extend(app.hub.remote.lock().unwrap().iter().cloned());
        return serde_json::to_value(all).map_err(err);
    }
    if let Some(ws) = workspace_id.filter(|w| app.hub.is_remote(*w)) {
        return app.hub.client().map_err(err)?.rpc(ws, &method, params).await.map_err(err);
    }
    // Own workspaces: the hub user name if signed in, so shared threads show who wrote.
    let name = app.hub.user.lock().unwrap().as_ref().map(|u| u.name.clone()).unwrap_or(actor);
    app.runner.call(&method, params, &name).await.map_err(err)
}

#[tauri::command]
async fn pick_folder(handle: AppHandle) -> R<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    handle.dialog().file().pick_folder(move |f| {
        let _ = tx.send(f.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()));
    });
    rx.await.map_err(err)
}

// ---- providers, keys, models, media ---------------------------------------------------------

#[tauri::command]
fn providers() -> Vec<ProviderInfo> {
    KeyringStore::configured()
}

/// Keys go to the OS keychain. Where there is none (some Linux setups) they go
/// to a file only this user can read, and into this process's environment,
/// which `KeyringStore` reads as its fallback.
#[tauri::command]
fn set_key(app: State<'_, Arc<App>>, provider: ProviderKind, key: Option<String>) -> R<()> {
    let key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    let keychain = match &key {
        Some(k) => KeyringStore::set(provider, k),
        None => KeyringStore::delete(provider),
    };
    let path = app.runner.store().dir().join("keys.json");
    let mut file: serde_json::Map<String, Value> = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let var = bouvio_agent::keys::env_vars(provider).first().copied().unwrap_or_default();
    match (&key, keychain.is_ok()) {
        (Some(k), false) => {
            file.insert(provider.id().into(), Value::String(k.clone()));
            std::env::set_var(var, k);
        }
        _ => {
            file.remove(provider.id());
            if key.is_none() {
                std::env::remove_var(var);
            }
        }
    }
    hub::write_private(&path, &serde_json::to_string(&file).map_err(err)?).map_err(err)
}

fn load_file_keys(dir: &std::path::Path) {
    let Ok(b) = std::fs::read(dir.join("keys.json")) else { return };
    let Ok(map) = serde_json::from_slice::<serde_json::Map<String, Value>>(&b) else { return };
    for p in ProviderKind::ALL {
        if let (Some(Value::String(k)), Some(var)) = (map.get(p.id()), bouvio_agent::keys::env_vars(p).first()) {
            std::env::set_var(var, k);
        }
    }
}

#[tauri::command]
async fn list_models() -> Vec<ModelInfo> {
    bouvio_agent::list_models(&KeyringStore).await
}

#[tauri::command]
async fn generate_media(app: State<'_, Arc<App>>, workspace_id: Uuid, thread_id: Option<Uuid>, kind: String, model: String, prompt: String) -> R<Artifact> {
    if app.hub.is_remote(workspace_id) {
        return Err("Generate media in your own workspaces; shared ones run on their host.".into());
    }
    let dir = app.runner.media_dir(workspace_id);
    let path = match kind.as_str() {
        "image" => media::generate_image(&KeyringStore, &model, &prompt, &dir).await,
        "video" => media::generate_video(&KeyringStore, &model, &prompt, &dir).await,
        "speech" => media::speak(&KeyringStore, &model, &prompt, &dir).await,
        k => return Err(format!("unknown media kind {k}")),
    }
    .map_err(err)?;
    app.runner.add_artifact(workspace_id, thread_id, &path, Some(prompt), Some(model)).map_err(err)
}

/// Voice input: audio recorded in the window, transcribed with the user's key.
#[tauri::command]
async fn transcribe(app: State<'_, Arc<App>>, audio_base64: String, mime: String, model: Option<String>) -> R<String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(audio_base64).map_err(err)?;
    let ext = if mime.contains("ogg") { "ogg" } else if mime.contains("mp4") { "m4a" } else { "webm" };
    let path = app.runner.store().dir().join("tmp").join(format!("{}.{ext}", Uuid::new_v4()));
    std::fs::create_dir_all(path.parent().unwrap()).map_err(err)?;
    std::fs::write(&path, bytes).map_err(err)?;
    let r = media::transcribe(&KeyringStore, model.as_deref().unwrap_or("openai:whisper-1"), &path).await;
    let _ = std::fs::remove_file(&path);
    r.map_err(err)
}

// ---- hub ---------------------------------------------------------------------------------------

#[tauri::command]
fn hub_status(app: State<'_, Arc<App>>) -> HubStatus {
    app.hub.status()
}

#[tauri::command]
fn hub_set_url(app: State<'_, Arc<App>>, url: String) -> R<()> {
    app.hub.set_url(&app.runner, url).map_err(err)
}

#[tauri::command]
async fn hub_request(app: State<'_, Arc<App>>, method: String, path: String, body: Option<Value>) -> R<Value> {
    app.hub.request(&method, &path, body).await.map_err(err)
}

/// Finish any sign-in (email code, or the code shown after Google/GitHub).
#[tauri::command]
async fn hub_sign_in(app: State<'_, Arc<App>>, path: String, body: Value) -> R<HubUser> {
    let v = app.hub.request("POST", &path, Some(body)).await.map_err(err)?;
    app.hub.signed_in(&app.runner, v).await.map_err(err)
}

#[tauri::command]
fn hub_logout(app: State<'_, Arc<App>>) -> R<()> {
    app.hub.logout().map_err(err)
}

#[tauri::command]
async fn hub_refresh(app: State<'_, Arc<App>>) -> R<Vec<Workspace>> {
    app.hub.refresh(&app.runner).await.map_err(err)
}

#[tauri::command]
async fn hub_share(app: State<'_, Arc<App>>, workspace_id: Uuid) -> R<Workspace> {
    app.hub.share(&app.runner, workspace_id).await.map_err(err)
}

#[tauri::command]
async fn hub_join(app: State<'_, Arc<App>>, code: String) -> R<Vec<Workspace>> {
    let code = code.trim().rsplit('/').next().unwrap_or("").to_string();
    app.hub.request("POST", &format!("/invites/{code}/accept"), None).await.map_err(err)?;
    app.hub.refresh(&app.runner).await.map_err(err)
}

#[tauri::command]
fn hub_send(app: State<'_, Arc<App>>, msg: ClientMsg) -> R<()> {
    app.hub.client().map_err(err)?.send(msg);
    Ok(())
}

// ---- wiring ------------------------------------------------------------------------------------

fn forward<T: Clone + Send + 'static>(handle: AppHandle, mut rx: tokio::sync::broadcast::Receiver<T>, emit: impl Fn(&AppHandle, T) + Send + 'static) {
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(v) => emit(&handle, v),
                // A slow window misses some messages; the logs on disk have them all.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });
}

/// Hub events for workspaces others host arrive under the same names as local ones.
fn forward_hub(handle: AppHandle, app: Arc<App>) {
    tauri::async_runtime::spawn(async move {
        let mut attached: Option<usize> = None;
        loop {
            let client = app.hub.client.lock().unwrap().clone();
            let Some(client) = client else {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                continue;
            };
            let id = Arc::as_ptr(&client) as usize;
            if attached == Some(id) {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                continue;
            }
            attached = Some(id);
            let mut rx = client.inbound.subscribe();
            let h = handle.clone();
            let a = app.clone();
            tauri::async_runtime::spawn(async move {
                while let Ok(msg) = rx.recv().await {
                    let _ = match msg {
                        ServerMsg::Event { workspace_id, kind, payload } if a.hub.is_remote(workspace_id) => {
                            let name = if kind == "notice" { "workspace-notice".to_string() } else { kind };
                            h.emit(&name, payload)
                        }
                        ServerMsg::Chat { message } => h.emit("hub-chat", message),
                        ServerMsg::Presence { presence, online } => h.emit("hub-presence", json!({ "presence": presence, "online": online })),
                        ServerMsg::HostStatus { workspace_id, online } => h.emit("hub-host", json!({ "workspace_id": workspace_id, "online": online })),
                        ServerMsg::Welcome { user } => h.emit("hub-status", json!({ "user": user })),
                        _ => Ok(()),
                    };
                }
            });
        }
    });
}

pub fn run() {
    let _ = tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).try_init();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = std::env::var_os("BOUVIO_DATA").map(PathBuf::from).unwrap_or_else(Runner::default_dir);
            load_file_keys(&dir);
            let runner = Runner::open(dir)?;
            runner.set_api_factory(api::factory());
            tauri::async_runtime::block_on(runner.start())?;
            let h = app.handle().clone();
            forward(h.clone(), runner.subscribe_events(), |a, e| {
                let _ = a.emit("thread-event", e);
            });
            forward(h.clone(), runner.subscribe_threads(), |a, t| {
                let _ = a.emit("thread-changed", t);
            });
            forward(h.clone(), runner.subscribe_notices(), |a, n| {
                let _ = a.emit("workspace-notice", n);
            });
            forward(h.clone(), runner.terminals.subscribe(), |a, o| {
                let _ = match o {
                    TerminalOut::Chunk(c) => a.emit("terminal-chunk", c),
                    TerminalOut::Exit(x) => a.emit("terminal-exit", x),
                };
            });
            let state = Arc::new(App { hub: Hub::load(&runner), runner: runner.clone() });
            forward_hub(h, state.clone());
            let s = state.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = s.hub.connect(&s.runner).await {
                    tracing::info!("hub: {e:#}");
                }
            });
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rpc,
            pick_folder,
            providers,
            set_key,
            list_models,
            generate_media,
            transcribe,
            hub_status,
            hub_set_url,
            hub_request,
            hub_sign_in,
            hub_logout,
            hub_refresh,
            hub_share,
            hub_join,
            hub_send,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Bouvio");
}
