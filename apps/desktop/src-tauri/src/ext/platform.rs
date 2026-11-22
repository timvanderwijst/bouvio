//! Platform: updates, plugins, file dialogs for backups.
//!
//! App methods (through `app_call`):
//! - `app_info` → `AppInfo` (version, whether this build can update itself)
//! - `plugins_list` → `PluginInfo[]`, `plugin_source {id}` → the entry's JS text,
//!   `plugins_dir {open?}` → the folder (and opens it), `plugin_set_enabled {id, enabled}`,
//!   `plugin_create` → scaffolds an example plugin
//! - `dialog_save {name?, filters?}` / `dialog_open {filters?}` → a path or null

use crate::App;
use anyhow::{bail, Context, Result};
use cuna_protocol::platform::{AppInfo, PluginInfo, PluginManifest, PluginPermission};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

static HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// The `pubkey` in tauri.conf.json until a maintainer runs `pnpm tauri signer generate`.
const PLACEHOLDER: &str = "REPLACE_WITH_UPDATER_PUBLIC_KEY";

pub async fn call(app: &Arc<App>, method: &str, params: &Value) -> Option<Result<Value>> {
    let dir = || app.runner.store().dir().to_path_buf();
    let out = match method {
        "app_info" => app_info(),
        "plugins_list" => to_value(list(&dir())),
        "plugin_source" => source(&dir(), params).map(Value::String),
        "plugins_dir" => (|| {
            let d = plugins_dir(&dir())?;
            if params["open"].as_bool().unwrap_or(false) {
                tauri_plugin_opener::open_path(&d, None::<&str>).context("open the plugins folder")?;
            }
            Ok(Value::String(d.to_string_lossy().into_owned()))
        })(),
        "plugin_set_enabled" => (|| {
            let id = params["id"].as_str().context("param `id`")?;
            let on = params["enabled"].as_bool().context("param `enabled`")?;
            set_enabled(&dir(), id, on)?;
            Ok(Value::Null)
        })(),
        "plugin_create" => create(&dir()).and_then(to_value),
        "dialog_save" => dialog(params, true).await,
        "dialog_open" => dialog(params, false).await,
        _ => return None,
    };
    Some(out)
}

pub fn setup(_app: &Arc<App>, handle: &tauri::AppHandle) {
    let _ = HANDLE.set(handle.clone());
}

pub fn plugins<R: tauri::Runtime>(b: tauri::Builder<R>) -> tauri::Builder<R> {
    b.plugin(tauri_plugin_updater::Builder::new().build()).plugin(tauri_plugin_process::init())
}

fn to_value<T: serde::Serialize>(v: T) -> Result<Value> {
    Ok(serde_json::to_value(v)?)
}

fn handle() -> Result<&'static AppHandle> {
    HANDLE.get().context("the app is still starting")
}

// ---- updates ----------------------------------------------------------------------------

fn app_info() -> Result<Value> {
    let h = handle()?;
    let pubkey = h.config().plugins.0.get("updater").and_then(|u| u.get("pubkey")).and_then(|k| k.as_str()).unwrap_or("");
    to_value(AppInfo { version: h.package_info().version.to_string(), updater: updater_configured(pubkey) })
}

fn updater_configured(pubkey: &str) -> bool {
    let k = pubkey.trim();
    !k.is_empty() && !k.contains(PLACEHOLDER)
}

// ---- plugins -----------------------------------------------------------------------------

fn plugins_dir(data: &Path) -> Result<PathBuf> {
    let d = data.join("plugins");
    std::fs::create_dir_all(&d)?;
    Ok(d)
}

fn state_path(data: &Path) -> PathBuf {
    data.join("plugins.json")
}

#[derive(Default, serde::Serialize, Deserialize)]
struct PluginState {
    #[serde(default)]
    enabled: Vec<String>,
}

fn state(data: &Path) -> PluginState {
    std::fs::read(state_path(data)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn set_enabled(data: &Path, id: &str, on: bool) -> Result<()> {
    valid_id(id)?;
    let mut s = state(data);
    s.enabled.retain(|x| x != id);
    if on {
        s.enabled.push(id.to_string());
    }
    std::fs::write(state_path(data), serde_json::to_vec_pretty(&s)?)?;
    Ok(())
}

fn valid_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        bail!("a plugin id uses letters, digits, - and _");
    }
    Ok(())
}

/// Every folder in the plugins dir, readable or not, so people see broken ones too.
fn list(data: &Path) -> Vec<PluginInfo> {
    let Ok(dir) = plugins_dir(data) else { return vec![] };
    let enabled = state(data).enabled;
    let mut out: Vec<PluginInfo> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| {
            let folder = e.file_name().to_string_lossy().into_owned();
            let path = e.path();
            let read = || -> Result<PluginManifest> {
                let raw = std::fs::read(path.join("plugin.json")).context("no plugin.json")?;
                let m: PluginManifest = serde_json::from_slice(&raw).context("plugin.json is not valid")?;
                if m.id != folder {
                    bail!("the id in plugin.json must match the folder name");
                }
                safe_entry(&m.entry)?;
                Ok(m)
            };
            match read() {
                Ok(m) => PluginInfo { enabled: enabled.contains(&m.id), manifest: m, path: path.to_string_lossy().into_owned(), error: None },
                Err(err) => PluginInfo {
                    manifest: PluginManifest { id: folder.clone(), name: folder, version: String::new(), description: String::new(), entry: "index.js".into(), permissions: vec![] },
                    enabled: false,
                    path: path.to_string_lossy().into_owned(),
                    error: Some(format!("{err:#}")),
                },
            }
        })
        .collect();
    out.sort_by_key(|p| p.manifest.name.to_lowercase());
    out
}

fn safe_entry(entry: &str) -> Result<()> {
    let ok = !entry.is_empty() && Path::new(entry).components().all(|c| matches!(c, Component::Normal(_)));
    if !ok {
        bail!("the entry must be a file inside the plugin folder");
    }
    Ok(())
}

fn source(data: &Path, params: &Value) -> Result<String> {
    let id = params["id"].as_str().context("param `id`")?;
    valid_id(id)?;
    let p = list(data).into_iter().find(|p| p.manifest.id == id).context("no such plugin")?;
    if let Some(e) = p.error {
        bail!("{e}");
    }
    std::fs::read_to_string(Path::new(&p.path).join(&p.manifest.entry)).context("cannot read the plugin's entry file")
}

/// An example plugin to start from: a rail page and a palette command.
fn create(data: &Path) -> Result<PluginInfo> {
    let dir = plugins_dir(data)?;
    let id = (1..100).map(|n| if n == 1 { "hello".to_string() } else { format!("hello-{n}") }).find(|id| !dir.join(id).exists()).context("too many example plugins")?;
    let folder = dir.join(&id);
    std::fs::create_dir_all(&folder)?;
    let manifest = PluginManifest {
        id: id.clone(),
        name: if id == "hello" { "Hello".into() } else { format!("Hello {}", &id[6..]) },
        version: "0.1.0".into(),
        description: "An example: a page in the rail and a command in Ctrl+K.".into(),
        entry: "index.js".into(),
        permissions: vec![PluginPermission::Rpc],
    };
    std::fs::write(folder.join("plugin.json"), serde_json::to_vec_pretty(&manifest)?)?;
    std::fs::write(folder.join("index.js"), EXAMPLE.replace("{{name}}", &manifest.name))?;
    set_enabled(data, &id, true)?;
    list(data).into_iter().find(|p| p.manifest.id == id).context("the new plugin did not load")
}

const EXAMPLE: &str = r#"// A Cuna plugin is an ES module. Cuna calls activate(api) when the plugin
// is enabled and deactivate() when it is turned off. See docs/plugins.md.

export function activate(api) {
  const { React } = api;
  const h = React.createElement;

  function Hello() {
    const [threads, setThreads] = React.useState(null);
    React.useEffect(() => {
      const ws = api.workspaceId();
      if (!ws) return;
      api.rpc("list_threads", { workspace_id: ws }).then((list) => setThreads(list.length)).catch(() => setThreads(null));
    }, []);
    return h(
      "div",
      { className: "page" },
      h("h1", { className: "page-title" }, "{{name}}"),
      h("p", { className: "page-note" }, threads === null ? "Open a workspace to count its threads." : `This workspace has ${threads} threads.`),
      h("button", { className: "btn", onClick: () => api.toast("Hello from a plugin") }, "Say hello"),
    );
  }

  api.registerArea({
    pages: [{ id: "page", place: "rail", label: "{{name}}", icon: api.icons.Smile, component: Hello }],
    commands: [{ id: "hello", label: "Say hello", icon: api.icons.Smile, run: () => api.toast("Hello from a plugin") }],
  });
}

export function deactivate() {}
"#;

// ---- file dialogs for backups ------------------------------------------------------------

#[derive(Deserialize)]
struct Filter {
    name: String,
    extensions: Vec<String>,
}

async fn dialog(params: &Value, save: bool) -> Result<Value> {
    let h = handle()?;
    let filters: Vec<Filter> = params.get("filters").cloned().map(serde_json::from_value).transpose()?.unwrap_or_default();
    let mut d = h.dialog().file();
    for f in &filters {
        let ext: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
        d = d.add_filter(&f.name, &ext);
    }
    if let Some(name) = params["name"].as_str() {
        d = d.set_file_name(name);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let done = move |f: Option<tauri_plugin_dialog::FilePath>| {
        let _ = tx.send(f.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()));
    };
    if save {
        d.save_file(done);
    } else {
        d.pick_file(done);
    }
    Ok(json!(rx.await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_key_means_no_updates() {
        assert!(!updater_configured(""));
        assert!(!updater_configured(PLACEHOLDER));
        assert!(updater_configured("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk="));
    }

    #[test]
    fn plugins_scaffold_list_enable_and_read() {
        let dir = std::env::temp_dir().join(format!("cuna-plugins-{}", uuid::Uuid::new_v4()));
        let made = create(&dir).unwrap();
        assert_eq!(made.manifest.id, "hello");
        assert!(made.enabled);
        assert!(source(&dir, &json!({ "id": "hello" })).unwrap().contains("activate"));
        set_enabled(&dir, "hello", false).unwrap();
        assert!(!list(&dir)[0].enabled);
        assert_eq!(create(&dir).unwrap().manifest.id, "hello-2");
        std::fs::create_dir_all(dir.join("plugins").join("broken")).unwrap();
        assert!(list(&dir).iter().any(|p| p.manifest.id == "broken" && p.error.is_some()));
        assert!(source(&dir, &json!({ "id": "../x" })).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
