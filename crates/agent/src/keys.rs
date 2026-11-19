//! API keys. They belong to the user and live in the OS keychain (service
//! `bouvio`, account = provider id); environment variables are a fallback.

use anyhow::{Context, Result};
use bouvio_protocol::{ProviderInfo, ProviderKind};
use std::collections::HashMap;

pub trait KeyStore: Send + Sync {
    fn get(&self, p: ProviderKind) -> Option<String>;
}

const SERVICE: &str = "bouvio";

/// Environment variables read when the keychain has no key.
pub fn env_vars(p: ProviderKind) -> &'static [&'static str] {
    match p {
        ProviderKind::OpenRouter => &["OPENROUTER_API_KEY"],
        ProviderKind::Anthropic => &["ANTHROPIC_API_KEY"],
        ProviderKind::OpenAi => &["OPENAI_API_KEY"],
        ProviderKind::Google => &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        ProviderKind::Fal => &["FAL_KEY"],
        ProviderKind::Replicate => &["REPLICATE_API_TOKEN"],
        ProviderKind::ElevenLabs => &["ELEVENLABS_API_KEY"],
    }
}

fn from_env(p: ProviderKind) -> Option<String> {
    env_vars(p)
        .iter()
        .filter_map(|v| std::env::var(v).ok())
        .map(|v| v.trim().to_string())
        .find(|v| !v.is_empty())
}

/// The OS keychain: Windows Credential Manager, macOS Keychain, Secret Service on Linux.
/// Reads block briefly (the OS call); call from `spawn_blocking` if that matters.
#[derive(Debug, Clone, Copy, Default)]
pub struct KeyringStore;

impl KeyringStore {
    fn entry(p: ProviderKind) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, p.id()).context("open the system keychain")
    }

    pub fn set(p: ProviderKind, key: &str) -> Result<()> {
        let key = key.trim();
        anyhow::ensure!(!key.is_empty(), "The key is empty");
        Self::entry(p)?.set_password(key).context("save the key in the system keychain")
    }

    pub fn delete(p: ProviderKind) -> Result<()> {
        match Self::entry(p)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e).context("remove the key from the system keychain"),
        }
    }

    /// Every provider and whether a key is available for it (keychain or env).
    pub fn configured() -> Vec<ProviderInfo> {
        let store = KeyringStore;
        ProviderKind::ALL.into_iter().map(|kind| ProviderInfo { kind, configured: store.get(kind).is_some() }).collect()
    }
}

impl KeyStore for KeyringStore {
    fn get(&self, p: ProviderKind) -> Option<String> {
        let stored = Self::entry(p).ok().and_then(|e| match e.get_password() {
            Ok(k) => Some(k),
            Err(keyring::Error::NoEntry) => None,
            Err(e) => {
                tracing::debug!("keychain read for {} failed: {e}", p.id());
                None
            }
        });
        stored.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()).or_else(|| from_env(p))
    }
}

/// Fixed keys, for tests and for callers that resolve keys themselves.
#[derive(Debug, Clone, Default)]
pub struct StaticKeys(pub HashMap<ProviderKind, String>);

impl StaticKeys {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn with(mut self, p: ProviderKind, key: &str) -> Self {
        self.0.insert(p, key.to_string());
        self
    }
}

impl KeyStore for StaticKeys {
    fn get(&self, p: ProviderKind) -> Option<String> {
        self.0.get(&p).cloned()
    }
}
