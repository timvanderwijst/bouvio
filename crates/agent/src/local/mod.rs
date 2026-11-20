//! Models on the user's own machine: chat through Ollama, LM Studio or any
//! OpenAI-compatible server; whisper.cpp, Piper and ComfyUI for media.
//!
//! The app loads [`LocalConfig`] from a small JSON file and hands it over with
//! [`set_config`]; downloaded whisper models and Piper voices go to
//! [`models_dir`] (set it with [`set_models_dir`]). Nothing here needs a key.

pub(crate) mod media;

use crate::provider::{base_override, http};
use anyhow::{anyhow, bail, Context, Result};
pub use bouvio_protocol::local::*;
use bouvio_protocol::{ModelInfo, ProviderKind};
use futures::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

// ---- configuration --------------------------------------------------------------------

fn cfg_lock() -> &'static RwLock<LocalConfig> {
    static C: OnceLock<RwLock<LocalConfig>> = OnceLock::new();
    C.get_or_init(|| RwLock::new(LocalConfig::default()))
}

fn dir_lock() -> &'static RwLock<Option<PathBuf>> {
    static D: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();
    D.get_or_init(|| RwLock::new(None))
}

/// The current settings (defaults until the app sets them).
pub fn config() -> LocalConfig {
    cfg_lock().read().unwrap().clone()
}

/// Apply settings; detection and routing start over.
pub fn set_config(c: LocalConfig) {
    *cfg_lock().write().unwrap() = normalize(c);
    probe_state().lock().unwrap().at = None;
    routes().lock().unwrap().clear();
}

/// Where downloaded whisper models and Piper voices live.
pub fn set_models_dir(dir: impl Into<PathBuf>) {
    *dir_lock().write().unwrap() = Some(dir.into());
}

/// `set_models_dir`, else `$BOUVIO_DATA/local`, else `~/.bouvio/local`.
pub fn models_dir() -> PathBuf {
    if let Some(d) = dir_lock().read().unwrap().clone() {
        return d;
    }
    let data = std::env::var_os("BOUVIO_DATA").map(PathBuf::from).unwrap_or_else(|| {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        home.join(".bouvio")
    });
    data.join("local")
}

/// Read settings from a JSON file; a missing or damaged file gives the defaults.
pub fn load_config(path: &Path) -> LocalConfig {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).map(normalize).unwrap_or_default()
}

pub fn save_config(path: &Path, c: &LocalConfig) -> Result<()> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    std::fs::write(path, serde_json::to_vec_pretty(c)?).with_context(|| format!("Cannot write {}", path.display()))
}

fn trim_url(s: &str) -> String {
    s.trim().trim_end_matches('/').to_string()
}

/// Empty URLs fall back to the defaults; trailing slashes go.
pub(crate) fn normalize(mut c: LocalConfig) -> LocalConfig {
    let d = LocalConfig::default();
    let fix = |s: &mut String, def: &str| {
        *s = trim_url(s);
        if s.is_empty() {
            *s = def.to_string();
        }
    };
    fix(&mut c.ollama_url, &d.ollama_url);
    fix(&mut c.lmstudio_url, &d.lmstudio_url);
    fix(&mut c.comfyui_url, &d.comfyui_url);
    c.ollama_url = c.ollama_url.trim_end_matches("/v1").to_string();
    c.lmstudio_url = c.lmstudio_url.trim_end_matches("/v1").to_string();
    c.custom_url = trim_url(&c.custom_url);
    c.whisper_bin = c.whisper_bin.trim().to_string();
    c.piper_bin = c.piper_bin.trim().to_string();
    c.default_model = c.default_model.trim().to_string();
    fix(&mut c.whisper_size, &d.whisper_size);
    fix(&mut c.piper_voice, &d.piper_voice);
    fix(&mut c.embed_model, &d.embed_model);
    c
}

fn ollama_root() -> String {
    base_override("ollama").unwrap_or_else(|| config().ollama_url)
}

fn lmstudio_root() -> String {
    base_override("lmstudio").unwrap_or_else(|| config().lmstudio_url)
}

pub(crate) fn comfyui_root() -> String {
    base_override("comfyui").unwrap_or_else(|| config().comfyui_url)
}

// ---- chat routing -------------------------------------------------------------------------

/// Model name → OpenAI-compatible base, learned when listing in `Auto` mode.
fn routes() -> &'static Mutex<HashMap<String, String>> {
    static R: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// The OpenAI-compatible base URL (with `/v1`) that serves `model`.
/// `BOUVIO_LOCAL_BASE_URL` overrides everything (tests).
pub(crate) fn chat_base(model: &str) -> String {
    if let Some(b) = base_override("local") {
        return b;
    }
    let c = config();
    match c.chat_server {
        LocalChatServer::Ollama => format!("{}/v1", ollama_root()),
        LocalChatServer::LmStudio => format!("{}/v1", lmstudio_root()),
        LocalChatServer::Custom if !c.custom_url.is_empty() => c.custom_url,
        LocalChatServer::Custom => format!("{}/v1", ollama_root()),
        LocalChatServer::Auto => routes().lock().unwrap().get(model).cloned().unwrap_or_else(|| format!("{}/v1", ollama_root())),
    }
}

// ---- reachability, cached ---------------------------------------------------------------------

#[derive(Default)]
struct Probe {
    at: Option<Instant>,
    up: bool,
    running: bool,
}

fn probe_state() -> &'static Mutex<Probe> {
    static P: OnceLock<Mutex<Probe>> = OnceLock::new();
    P.get_or_init(Default::default)
}

const PROBE_TTL: Duration = Duration::from_secs(15);
const CONNECT: Duration = Duration::from_millis(300);

/// Roots of the chat servers in use, for detection.
fn chat_roots() -> Vec<String> {
    if let Some(b) = base_override("local") {
        return vec![b];
    }
    let c = config();
    match c.chat_server {
        LocalChatServer::Auto => vec![ollama_root(), lmstudio_root()],
        LocalChatServer::Ollama => vec![ollama_root()],
        LocalChatServer::LmStudio => vec![lmstudio_root()],
        LocalChatServer::Custom if !c.custom_url.is_empty() => vec![c.custom_url],
        LocalChatServer::Custom => vec![],
    }
}

/// A TCP connect to the server's port, bounded by [`CONNECT`].
fn port_open(url: &str) -> bool {
    use std::net::{TcpStream, ToSocketAddrs};
    let Ok(u) = reqwest::Url::parse(url) else { return false };
    let (Some(host), Some(port)) = (u.host_str(), u.port_or_known_default()) else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let Ok(addrs) = (host, port).to_socket_addrs() else { return false };
    addrs.into_iter().any(|a| TcpStream::connect_timeout(&a, CONNECT).is_ok())
}

fn record(up: bool) {
    let mut p = probe_state().lock().unwrap();
    p.at = Some(Instant::now());
    p.up = up;
    p.running = false;
}

/// Whether a local chat server answers. Never blocks for more than about
/// 300 ms: the answer is cached for 15 s and refreshed on a background thread.
pub fn reachable_cached() -> bool {
    let (first, stale, up) = {
        let mut p = probe_state().lock().unwrap();
        let stale = p.at.is_none_or(|t| t.elapsed() > PROBE_TTL);
        let start = stale && !p.running;
        if start {
            p.running = true;
        }
        (p.at.is_none() && start, start, p.up)
    };
    if !stale {
        return up;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let up = chat_roots().iter().any(|r| port_open(r));
        record(up);
        let _ = tx.send(up);
    });
    if first {
        return rx.recv_timeout(CONNECT + Duration::from_millis(50)).unwrap_or(false);
    }
    up
}

/// Probe now (HTTP, short timeout) and update the cache.
pub async fn reachable() -> bool {
    let roots = chat_roots();
    let checks = roots.iter().map(|r| async move { http().get(r).timeout(Duration::from_millis(1500)).send().await.is_ok() });
    let up = futures::future::join_all(checks).await.into_iter().any(|x| x);
    record(up);
    up
}

// ---- listing ------------------------------------------------------------------------------------

const LIST_TIMEOUT: Duration = Duration::from_secs(4);

async fn get_json(url: &str) -> Result<Value> {
    let resp = http().get(url).timeout(LIST_TIMEOUT).send().await?;
    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        bail!("{url} returned {status}: {}", crate::provider::clip(&text, 200));
    }
    Ok(serde_json::from_str(&text)?)
}

fn embedding_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.contains("embed") || n.contains("bge-") || n.contains("minilm")
}

/// Ollama `/api/tags`.
pub(crate) fn parse_ollama_tags(v: &Value) -> Vec<LocalModel> {
    v["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let name = m["name"].as_str().or(m["model"].as_str())?.to_string();
            let d = &m["details"];
            let families: Vec<&str> = d["families"].as_array().into_iter().flatten().filter_map(|f| f.as_str()).collect();
            let family = d["family"].as_str().unwrap_or("");
            let bert = family.contains("bert") || families.iter().any(|f| f.contains("bert"));
            let detail = [d["parameter_size"].as_str(), d["quantization_level"].as_str()]
                .into_iter()
                .flatten()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            Some(LocalModel {
                id: format!("local:{name}"),
                embedding: bert || embedding_name(&name),
                size: m["size"].as_u64(),
                detail: (!detail.is_empty()).then_some(detail),
                name,
            })
        })
        .collect()
}

/// Context length out of Ollama `/api/show`: `model_info["<arch>.context_length"]`.
pub(crate) fn parse_ollama_context(v: &Value) -> Option<u32> {
    let info = v["model_info"].as_object()?;
    let arch = info.get("general.architecture").and_then(|a| a.as_str());
    let by_arch = arch.and_then(|a| info.get(&format!("{a}.context_length"))).and_then(|c| c.as_u64());
    by_arch
        .or_else(|| info.iter().find(|(k, _)| k.ends_with(".context_length")).and_then(|(_, c)| c.as_u64()))
        .map(|c| c.min(u32::MAX as u64) as u32)
}

/// LM Studio `/api/v0/models` (with type and context) or `/v1/models` (ids only),
/// also used for any OpenAI-compatible server. Returns models with their context.
pub(crate) fn parse_openai_models(v: &Value) -> Vec<(LocalModel, Option<u32>)> {
    v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let name = m["id"].as_str()?.to_string();
            let embedding = m["type"].as_str().map(|t| t.contains("embed")).unwrap_or_else(|| embedding_name(&name));
            let detail = [m["arch"].as_str(), m["quantization"].as_str(), m["state"].as_str()]
                .into_iter()
                .flatten()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            let ctx = m["max_context_length"].as_u64().or(m["context_length"].as_u64()).map(|c| c.min(u32::MAX as u64) as u32);
            Some((LocalModel { id: format!("local:{name}"), name, size: None, detail: (!detail.is_empty()).then_some(detail), embedding }, ctx))
        })
        .collect()
}

async fn ollama_models() -> Result<Vec<LocalModel>> {
    Ok(parse_ollama_tags(&get_json(&format!("{}/api/tags", ollama_root())).await?))
}

async fn ollama_context(name: &str) -> Option<u32> {
    let resp = http().post(format!("{}/api/show", ollama_root())).json(&json!({ "model": name })).timeout(LIST_TIMEOUT).send().await.ok()?;
    parse_ollama_context(&resp.json::<Value>().await.ok()?)
}

/// LM Studio's richer list first, the OpenAI one as fallback.
async fn lmstudio_models() -> Result<Vec<(LocalModel, Option<u32>)>> {
    let root = lmstudio_root();
    match get_json(&format!("{root}/api/v0/models")).await {
        Ok(v) => Ok(parse_openai_models(&v)),
        Err(_) => Ok(parse_openai_models(&get_json(&format!("{root}/v1/models")).await?)),
    }
}

fn to_info(m: &LocalModel, context: Option<u32>) -> ModelInfo {
    ModelInfo { id: m.id.clone(), name: m.name.clone(), provider: ProviderKind::Local, context, price_in: None, price_out: None }
}

/// Chat models on the configured local servers, for the model picker. A server
/// that is not running is skipped quietly.
pub async fn list_chat_models() -> Vec<ModelInfo> {
    if let Some(base) = base_override("local") {
        return match get_json(&format!("{base}/models")).await {
            Ok(v) => parse_openai_models(&v).iter().filter(|(m, _)| !m.embedding).map(|(m, c)| to_info(m, *c)).collect(),
            Err(_) => vec![],
        };
    }
    let c = config();
    let want_ollama = matches!(c.chat_server, LocalChatServer::Auto | LocalChatServer::Ollama);
    let want_lms = matches!(c.chat_server, LocalChatServer::Auto | LocalChatServer::LmStudio);
    let (ol, lm, custom) = futures::join!(
        async {
            if !want_ollama {
                return vec![];
            }
            let Ok(models) = ollama_models().await else { return vec![] };
            let chat: Vec<LocalModel> = models.into_iter().filter(|m| !m.embedding).collect();
            let ctx = futures::future::join_all(chat.iter().map(|m| ollama_context(&m.name))).await;
            chat.into_iter().zip(ctx).collect::<Vec<_>>()
        },
        async {
            if !want_lms {
                return vec![];
            }
            lmstudio_models().await.unwrap_or_default().into_iter().filter(|(m, _)| !m.embedding).collect()
        },
        async {
            if c.chat_server != LocalChatServer::Custom || c.custom_url.is_empty() {
                return vec![];
            }
            match get_json(&format!("{}/models", c.custom_url)).await {
                Ok(v) => parse_openai_models(&v).into_iter().filter(|(m, _)| !m.embedding).collect(),
                Err(_) => vec![],
            }
        },
    );
    let mut out = Vec::new();
    let mut r = routes().lock().unwrap();
    for (m, ctx) in &lm {
        r.insert(m.name.clone(), format!("{}/v1", lmstudio_root()));
        out.push(to_info(m, *ctx));
    }
    // Ollama wins a name both have.
    for (m, ctx) in &ol {
        r.insert(m.name.clone(), format!("{}/v1", ollama_root()));
        out.retain(|x: &ModelInfo| x.id != m.id);
        out.push(to_info(m, *ctx));
    }
    for (m, ctx) in &custom {
        out.push(to_info(m, *ctx));
    }
    drop(r);
    record(!ol.is_empty() || !lm.is_empty() || !custom.is_empty() || reachable_cached());
    out
}

/// The local model to use when nothing is chosen: the first tool-friendly one
/// from the recommended list that is installed, else the first installed.
pub async fn default_chat_model() -> Option<String> {
    let models = list_chat_models().await;
    let rec = recommended();
    rec.iter()
        .filter(|r| matches!(r.use_, LocalModelUse::Chat | LocalModelUse::Code))
        .find_map(|r| models.iter().find(|m| m.name == r.name || m.name == format!("{}:latest", r.name)))
        .or_else(|| models.first())
        .map(|m| m.id.clone())
}

// ---- status ----------------------------------------------------------------------------------------

/// Executables found on PATH or in the usual install folders (GUI apps on macOS
/// do not get the shell's PATH).
pub(crate) fn which(name: &str) -> Option<PathBuf> {
    let p = Path::new(name);
    if p.components().count() > 1 {
        return p.is_file().then(|| p.to_path_buf());
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        dirs.push(PathBuf::from(extra));
    }
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(&home).join(".local/bin"));
    }
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat", ""] } else { &[""] };
    dirs.iter().find_map(|d| exts.iter().map(|e| d.join(format!("{name}{e}"))).find(|f| f.is_file()))
}

async fn run_quiet(bin: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args).stdin(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let out = tokio::time::timeout(Duration::from_secs(5), cmd.output()).await.ok()?.ok()?;
    Some(format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
}

/// whisper.cpp's CLI: the configured path, else `whisper-cli`, `whisper-cpp`, or a
/// `whisper` that is whisper.cpp (not OpenAI's Python `whisper`).
pub(crate) async fn find_whisper() -> Option<PathBuf> {
    let c = config();
    if !c.whisper_bin.is_empty() {
        return which(&c.whisper_bin);
    }
    for name in ["whisper-cli", "whisper-cpp", "whisper"] {
        if let Some(p) = which(name) {
            if name != "whisper" {
                return Some(p);
            }
            let help = run_quiet(&p, &["--help"]).await.unwrap_or_default();
            if help.contains("--no-timestamps") || help.contains("-nt,") {
                return Some(p);
            }
        }
    }
    None
}

pub(crate) fn find_piper() -> Option<PathBuf> {
    let c = config();
    which(if c.piper_bin.is_empty() { "piper" } else { &c.piper_bin })
}

fn first_version(text: &str) -> Option<String> {
    let re = regex::Regex::new(r"\d+\.\d+(?:\.\d+)?").ok()?;
    re.find(text).map(|m| m.as_str().to_string())
}

fn engine(kind: LocalEngineKind) -> LocalEngine {
    LocalEngine { kind, ready: false, version: None, location: None, models: vec![], error: None }
}

async fn ollama_status() -> LocalEngine {
    let root = ollama_root();
    let mut e = engine(LocalEngineKind::Ollama);
    e.location = Some(root.clone());
    if let Ok(v) = get_json(&format!("{root}/api/version")).await {
        e.ready = true;
        e.version = v["version"].as_str().map(str::to_string);
        match ollama_models().await {
            Ok(m) => e.models = m,
            Err(err) => e.error = Some(format!("{err:#}")),
        }
    }
    if !e.ready && which("ollama").is_some() {
        e.error = Some("installed, not running".into());
    }
    e
}

async fn openai_server_status(kind: LocalEngineKind, base: String) -> LocalEngine {
    let mut e = engine(kind);
    e.location = Some(base.clone());
    let models = if kind == LocalEngineKind::LmStudio { lmstudio_models().await } else { get_json(&format!("{base}/models")).await.map(|v| parse_openai_models(&v)) };
    if let Ok(m) = models {
        e.ready = true;
        e.models = m.into_iter().map(|(m, _)| m).collect();
    }
    e
}

fn files_in(dir: &Path, ext: &str) -> Vec<(String, u64)> {
    let mut out: Vec<(String, u64)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|f| {
            let name = f.file_name().to_string_lossy().to_string();
            let stem = name.strip_suffix(ext)?.to_string();
            Some((stem, f.metadata().map(|m| m.len()).unwrap_or(0)))
        })
        .collect();
    out.sort();
    out
}

async fn whisper_status() -> LocalEngine {
    let mut e = engine(LocalEngineKind::Whisper);
    if let Some(bin) = find_whisper().await {
        e.ready = true;
        e.location = Some(bin.display().to_string());
        e.version = run_quiet(&bin, &["--version"]).await.and_then(|t| first_version(&t));
    }
    e.models = files_in(&models_dir().join("whisper"), ".bin")
        .into_iter()
        .filter_map(|(stem, size)| {
            let size_name = stem.strip_prefix("ggml-")?.to_string();
            Some(LocalModel { id: format!("local:whisper-{size_name}"), name: size_name, size: Some(size), detail: None, embedding: false })
        })
        .collect();
    e
}

async fn piper_status() -> LocalEngine {
    let mut e = engine(LocalEngineKind::Piper);
    if let Some(bin) = find_piper() {
        e.ready = true;
        e.location = Some(bin.display().to_string());
        e.version = run_quiet(&bin, &["--version"]).await.and_then(|t| first_version(&t));
    }
    e.models = files_in(&models_dir().join("piper"), ".onnx")
        .into_iter()
        .map(|(voice, size)| LocalModel { id: format!("local:piper/{voice}"), name: voice, size: Some(size), detail: None, embedding: false })
        .collect();
    e
}

/// Checkpoint names out of ComfyUI `/object_info/CheckpointLoaderSimple`, in
/// the old (`[[names], {}]`) and the newer (`["COMBO", {"options": [names]}]`) shape.
pub(crate) fn parse_comfy_checkpoints(v: &Value) -> Vec<String> {
    let spec = &v["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"];
    let list = if spec[0].is_array() { &spec[0] } else { &spec[1]["options"] };
    list.as_array().into_iter().flatten().filter_map(|n| n.as_str().map(str::to_string)).collect()
}

pub(crate) async fn comfy_checkpoints() -> Result<Vec<String>> {
    Ok(parse_comfy_checkpoints(&get_json(&format!("{}/object_info/CheckpointLoaderSimple", comfyui_root())).await?))
}

async fn comfy_status() -> LocalEngine {
    let root = comfyui_root();
    let mut e = engine(LocalEngineKind::Comfyui);
    e.location = Some(root.clone());
    if let Ok(v) = get_json(&format!("{root}/system_stats")).await {
        e.ready = true;
        e.version = v["system"]["comfyui_version"].as_str().map(str::to_string);
        e.models = comfy_checkpoints()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|n| LocalModel { id: format!("comfyui:{n}"), name: n, size: None, detail: None, embedding: false })
            .collect();
    }
    e
}

/// Every engine: running or installed, version, models on this machine.
pub async fn status() -> LocalStatus {
    let c = config();
    let custom = async {
        if c.custom_url.is_empty() {
            None
        } else {
            Some(openai_server_status(LocalEngineKind::Custom, c.custom_url.clone()).await)
        }
    };
    let (ol, lm, cu, wh, pi, co) =
        futures::join!(ollama_status(), openai_server_status(LocalEngineKind::LmStudio, lmstudio_root()), custom, whisper_status(), piper_status(), comfy_status());
    record(ol.ready || lm.ready || cu.as_ref().is_some_and(|e| e.ready));
    let mut engines = vec![ol, lm];
    engines.extend(cu);
    engines.extend([wh, pi, co]);
    LocalStatus { engines, models_dir: models_dir().display().to_string() }
}

// ---- pulls and downloads ------------------------------------------------------------------------

/// Calls `on` at most every 150 ms unless the status changes or it is the end.
struct Throttle<F: FnMut(LocalProgress)> {
    on: F,
    last: Option<(Instant, String)>,
}

impl<F: FnMut(LocalProgress)> Throttle<F> {
    fn send(&mut self, p: LocalProgress) {
        let due = match &self.last {
            None => true,
            Some((t, s)) => p.done || *s != p.status || t.elapsed() >= Duration::from_millis(150),
        };
        if due {
            self.last = Some((Instant::now(), p.status.clone()));
            (self.on)(p);
        }
    }
}

fn progress(kind: &str, name: &str, status: &str, completed: Option<u64>, total: Option<u64>) -> LocalProgress {
    LocalProgress { kind: kind.into(), name: name.into(), status: status.into(), completed, total, done: false, error: None }
}

/// One line of Ollama's `/api/pull` stream.
pub(crate) fn parse_pull_line(name: &str, line: &str) -> Option<Result<LocalProgress>> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if let Some(e) = v["error"].as_str() {
        return Some(Err(anyhow!("Ollama could not pull {name}: {e}")));
    }
    let status = v["status"].as_str().unwrap_or("").to_string();
    let mut p = progress("ollama", name, &status, v["completed"].as_u64(), v["total"].as_u64());
    p.done = status == "success";
    Some(Ok(p))
}

fn valid_ollama_name(name: &str) -> bool {
    !name.is_empty() && name.len() < 200 && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-:/".contains(c))
}

/// Pull a model into Ollama, reporting progress. Returns when it is there.
pub async fn pull(name: &str, on: impl FnMut(LocalProgress)) -> Result<()> {
    let name = name.trim().strip_prefix("local:").unwrap_or(name.trim());
    if !valid_ollama_name(name) {
        bail!("{name:?} is not an Ollama model name");
    }
    let mut t = Throttle { on, last: None };
    let resp = http()
        .post(format!("{}/api/pull", ollama_root()))
        .json(&json!({ "model": name, "stream": true }))
        .timeout(Duration::from_secs(6 * 3600))
        .send()
        .await
        .map_err(|e| anyhow!("Could not reach Ollama at {}: {e}. Is it running?", ollama_root()))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        bail!("Ollama could not pull {name} ({status}): {}", crate::provider::clip(body.trim(), 300));
    }
    let mut stream = resp.bytes_stream();
    let mut buf = Vec::new();
    let mut ok = false;
    while let Some(chunk) = stream.next().await {
        buf.extend_from_slice(&chunk?);
        while let Some(i) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=i).collect();
            match parse_pull_line(name, &String::from_utf8_lossy(&line)) {
                Some(Ok(p)) => {
                    ok |= p.done;
                    t.send(p);
                }
                Some(Err(e)) => return Err(e),
                None => {}
            }
        }
    }
    if let Some(Ok(p)) = parse_pull_line(name, &String::from_utf8_lossy(&buf)) {
        ok |= p.done;
        t.send(p);
    }
    if !ok {
        bail!("Ollama stopped before {name} was complete");
    }
    record(true);
    Ok(())
}

const WHISPER_SIZES: &[&str] = &["tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en", "large-v3-turbo"];

fn hf_base() -> String {
    base_override("hf").unwrap_or_else(|| "https://huggingface.co".into())
}

pub(crate) fn whisper_url(size: &str) -> Result<String> {
    if !WHISPER_SIZES.contains(&size) {
        bail!("Unknown whisper size {size:?}; use tiny, base, small or medium");
    }
    Ok(format!("{}/ggerganov/whisper.cpp/resolve/main/ggml-{size}.bin", hf_base()))
}

pub(crate) fn whisper_path(size: &str) -> PathBuf {
    models_dir().join("whisper").join(format!("ggml-{size}.bin"))
}

/// `en_US-lessac-medium` → `…/en/en_US/lessac/medium/en_US-lessac-medium.onnx`
pub(crate) fn piper_url(voice: &str) -> Result<String> {
    let bad = || anyhow!("{voice:?} is not a Piper voice name like en_US-lessac-medium");
    let mut parts = voice.splitn(3, '-');
    let (locale, speaker, quality) = (parts.next().ok_or_else(bad)?, parts.next().ok_or_else(bad)?, parts.next().ok_or_else(bad)?);
    let lang = locale.split_once('_').map(|(l, _)| l).ok_or_else(bad)?;
    let ok_locale = lang.len() >= 2 && lang.len() <= 3 && lang.chars().all(|c| c.is_ascii_lowercase()) && locale.len() == lang.len() + 3;
    let ok_speaker = !speaker.is_empty() && speaker.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !ok_locale || !ok_speaker || !["x_low", "low", "medium", "high"].contains(&quality) {
        return Err(bad());
    }
    Ok(format!("{}/rhasspy/piper-voices/resolve/main/{lang}/{locale}/{speaker}/{quality}/{voice}.onnx", hf_base()))
}

pub(crate) fn piper_path(voice: &str) -> PathBuf {
    models_dir().join("piper").join(format!("{voice}.onnx"))
}

/// Stream a URL into `dest` (through a `.part` file), reporting progress.
async fn fetch_to(url: &str, dest: &Path, kind: &str, name: &str, t: &mut Throttle<impl FnMut(LocalProgress)>) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    if let Some(p) = dest.parent() {
        tokio::fs::create_dir_all(p).await?;
    }
    let resp = http().get(url).timeout(Duration::from_secs(3 * 3600)).send().await.with_context(|| format!("Downloading {url} failed"))?;
    if !resp.status().is_success() {
        bail!("Downloading {url} failed: {}", resp.status());
    }
    let total = resp.content_length();
    let part = dest.with_extension(format!("{}.part", dest.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default()));
    let mut f = tokio::fs::File::create(&part).await.with_context(|| format!("Cannot write {}", part.display()))?;
    let mut done = 0u64;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| format!("Downloading {url} was interrupted"))?;
        f.write_all(&chunk).await?;
        done += chunk.len() as u64;
        t.send(progress(kind, name, "downloading", Some(done), total));
    }
    f.flush().await?;
    drop(f);
    tokio::fs::rename(&part, dest).await?;
    Ok(())
}

/// Download a whisper model (`kind = "whisper"`, name = size) or a Piper voice
/// (`kind = "piper"`) into [`models_dir`]; returns its path. Already there = no-op.
pub async fn download(kind: &str, name: &str, on: impl FnMut(LocalProgress)) -> Result<PathBuf> {
    let name = name.trim();
    let mut t = Throttle { on, last: None };
    let path = match kind {
        "whisper" => {
            let url = whisper_url(name)?;
            let path = whisper_path(name);
            if !path.is_file() {
                fetch_to(&url, &path, kind, name, &mut t).await?;
            }
            path
        }
        "piper" => {
            let url = piper_url(name)?;
            let path = piper_path(name);
            let cfg = PathBuf::from(format!("{}.json", path.display()));
            if !cfg.is_file() {
                fetch_to(&format!("{url}.json"), &cfg, kind, name, &mut t).await?;
            }
            if !path.is_file() {
                fetch_to(&url, &path, kind, name, &mut t).await?;
            }
            path
        }
        other => bail!("Unknown download kind {other:?}; use whisper or piper"),
    };
    let mut p = progress(kind, name, "success", None, None);
    p.done = true;
    t.send(p);
    Ok(path)
}

/// Good small models to start with. Sizes are the download, roughly.
pub fn recommended() -> Vec<LocalRecommended> {
    let r = |name: &str, label: &str, use_, size_mb, ram_gb, tools| LocalRecommended { name: name.into(), label: label.into(), use_, size_mb, ram_gb, tools };
    use LocalModelUse::*;
    vec![
        r("qwen3:8b", "Qwen3 8B", Chat, 5200, Some(10.0), true),
        r("qwen3:4b", "Qwen3 4B", Chat, 2600, Some(6.0), true),
        r("llama3.2:3b", "Llama 3.2 3B", Chat, 2000, Some(4.0), true),
        r("qwen2.5-coder:7b", "Qwen2.5 Coder 7B", Code, 4700, Some(8.0), true),
        r("gpt-oss:20b", "gpt-oss 20B", Chat, 14000, Some(16.0), true),
        r("gemma3:4b", "Gemma 3 4B", Chat, 3300, Some(6.0), false),
        r("nomic-embed-text", "Nomic Embed", Embed, 274, Some(1.0), false),
        r("base", "Whisper base", Whisper, 142, Some(1.0), false),
        r("small", "Whisper small", Whisper, 466, Some(2.0), false),
        r("en_US-lessac-medium", "Lessac (English)", Piper, 63, None, false),
        r("nl_NL-mls-medium", "MLS (Nederlands)", Piper, 63, None, false),
    ]
}

// ---- embeddings ----------------------------------------------------------------------------------

/// Embed with Ollama, pulling the model on first use.
pub(crate) async fn ollama_embed(texts: &[String]) -> Result<Vec<Vec<f32>>> {
    let model = config().embed_model;
    let url = format!("{}/api/embed", ollama_root());
    let call = || async {
        let resp = http().post(&url).json(&json!({ "model": model, "input": texts })).send().await?;
        let status = resp.status().as_u16();
        let v: Value = resp.json().await.unwrap_or(Value::Null);
        Ok::<_, anyhow::Error>((status, v))
    };
    let (mut status, mut v) = call().await?;
    let missing = |s: u16, v: &Value| s == 404 || v["error"].as_str().is_some_and(|e| e.contains("not found"));
    if missing(status, &v) {
        tracing::info!("pulling {model} for embeddings");
        pull(&model, |_| {}).await?;
        (status, v) = call().await?;
    }
    if !(200..300).contains(&status) {
        bail!("Ollama embeddings failed ({status}): {}", v["error"].as_str().unwrap_or("no details"));
    }
    parse_embeddings(&v["embeddings"], texts.len())
}

/// `[[f32…]…]`, one per input.
pub(crate) fn parse_embeddings(v: &Value, want: usize) -> Result<Vec<Vec<f32>>> {
    let out: Vec<Vec<f32>> = v
        .as_array()
        .ok_or_else(|| anyhow!("No embeddings in the answer"))?
        .iter()
        .map(|e| e.as_array().into_iter().flatten().filter_map(|x| x.as_f64()).map(|x| x as f32).collect())
        .collect();
    if out.len() != want {
        bail!("Asked for {want} embeddings, got {}", out.len());
    }
    Ok(out)
}

/// Whether Ollama answers right now (short timeout).
pub(crate) async fn ollama_up() -> bool {
    http().get(format!("{}/api/version", ollama_root())).timeout(Duration::from_millis(1500)).send().await.is_ok_and(|r| r.status().is_success())
}

#[cfg(test)]
mod tests;
