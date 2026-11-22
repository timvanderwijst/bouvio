//! Local AI: Ollama/LM Studio, whisper.cpp, Piper, ComfyUI, local embeddings.
//!
//! Owned by one feature area; types here derive `TS` and export next to the others.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Which server answers `local:<model>` chat models.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum LocalChatServer {
    /// Whichever of Ollama and LM Studio has the model (Ollama first).
    #[default]
    Auto,
    Ollama,
    LmStudio,
    /// Any OpenAI-compatible server at `custom_url` (llama.cpp server, vLLM, LocalAI…).
    Custom,
}

/// Settings of the local engines, kept in `<data dir>/local.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(default)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct LocalConfig {
    pub chat_server: LocalChatServer,
    /// Ollama's root, without `/v1`.
    pub ollama_url: String,
    /// LM Studio's root, without `/v1`.
    pub lmstudio_url: String,
    /// An OpenAI-compatible base URL including `/v1`.
    pub custom_url: String,
    pub comfyui_url: String,
    /// whisper.cpp CLI; empty = look on PATH (`whisper-cli`, `whisper-cpp`, `whisper`).
    pub whisper_bin: String,
    /// Piper; empty = look on PATH.
    pub piper_bin: String,
    /// Default model for one-shot completions (briefs, summaries), provider-qualified.
    /// Empty = a local model when one is running, else any configured provider.
    pub default_model: String,
    /// `tiny`, `base`, `small` or `medium`.
    pub whisper_size: String,
    /// A Piper voice, e.g. `en_US-lessac-medium`.
    pub piper_voice: String,
    /// Ollama embedding model, pulled on first use.
    pub embed_model: String,
}

impl Default for LocalConfig {
    fn default() -> Self {
        Self {
            chat_server: LocalChatServer::Auto,
            ollama_url: "http://127.0.0.1:11434".into(),
            lmstudio_url: "http://127.0.0.1:1234".into(),
            custom_url: String::new(),
            comfyui_url: "http://127.0.0.1:8188".into(),
            whisper_bin: String::new(),
            piper_bin: String::new(),
            default_model: String::new(),
            whisper_size: "base".into(),
            piper_voice: "en_US-lessac-medium".into(),
            embed_model: "nomic-embed-text".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum LocalEngineKind {
    Ollama,
    LmStudio,
    Custom,
    Whisper,
    Piper,
    Comfyui,
}

/// A model or voice an engine has on this machine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct LocalModel {
    /// Name as the engine knows it (`qwen3:8b`, `base`, `en_US-lessac-medium`, a checkpoint file).
    pub name: String,
    /// Provider-qualified id Cuna uses (`local:qwen3:8b`, `local:whisper-base`, `comfyui:…`).
    pub id: String,
    #[ts(type = "number | null")]
    pub size: Option<u64>,
    /// Parameters, quantization, family; whatever the engine reports.
    pub detail: Option<String>,
    /// An embedding model rather than a chat model.
    pub embedding: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct LocalEngine {
    pub kind: LocalEngineKind,
    /// Server answering (Ollama, LM Studio, custom, ComfyUI) or binary found (whisper, Piper).
    pub ready: bool,
    pub version: Option<String>,
    /// URL of a server, path of a binary.
    pub location: Option<String>,
    pub models: Vec<LocalModel>,
    /// Why it is not ready, when there is more to say than "not found".
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct LocalStatus {
    pub engines: Vec<LocalEngine>,
    /// Where downloaded whisper models and Piper voices live.
    pub models_dir: String,
}

/// Progress of a pull or download, sent as the `local-progress` event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct LocalProgress {
    /// `ollama`, `whisper` or `piper`.
    pub kind: String,
    pub name: String,
    /// The engine's own status line (`pulling manifest`, `downloading`, `success`).
    pub status: String,
    #[ts(type = "number | null")]
    pub completed: Option<u64>,
    #[ts(type = "number | null")]
    pub total: Option<u64>,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum LocalModelUse {
    Chat,
    Code,
    Embed,
    Whisper,
    Piper,
}

/// A good small model to start with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct LocalRecommended {
    /// What to pull or download: an Ollama tag, a whisper size, a Piper voice.
    pub name: String,
    pub label: String,
    #[serde(rename = "use")]
    #[ts(rename = "use")]
    pub use_: LocalModelUse,
    /// Download size in MB.
    pub size_mb: u32,
    /// Memory it needs to run comfortably, in GB.
    pub ram_gb: Option<f32>,
    /// Calls tools reliably, so it can run agent threads.
    pub tools: bool,
}
