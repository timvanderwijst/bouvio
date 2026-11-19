//! Model providers behind two wire formats: OpenAI-compatible chat completions
//! (OpenRouter, OpenAI, Google) and the Anthropic Messages API.
//!
//! The agent keeps its history in a neutral form ([`Message`] / [`Part`]); each
//! wire module translates it to a request body and the response back.

pub(crate) mod anthropic;
pub(crate) mod openai;

use anyhow::{anyhow, bail, Result};
use bouvio_protocol::ProviderKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

// ---- neutral history ------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum Part {
    Text {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        input: Value,
        /// Provider data that must travel back with the call (Gemini thought signatures).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        extra: Option<Value>,
    },
    ToolResult {
        id: String,
        output: String,
        is_error: bool,
    },
    /// A provider-specific block (Anthropic thinking, OpenRouter reasoning details)
    /// replayed unchanged to the same provider and dropped for others.
    Opaque {
        provider: String,
        value: Value,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Message {
    pub role: Role,
    pub parts: Vec<Part>,
}

impl Message {
    pub fn user_text(text: &str) -> Self {
        Self { role: Role::User, parts: vec![Part::Text { text: text.to_string() }] }
    }
}

pub(crate) struct ToolSpec {
    pub name: String,
    pub description: String,
    pub schema: Value,
}

pub(crate) struct Request<'a> {
    pub system: &'a str,
    pub messages: &'a [Message],
    pub tools: &'a [ToolSpec],
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Stop {
    EndTurn,
    ToolUse,
    MaxTokens,
    /// Anthropic `pause_turn`: send the conversation again to let it continue.
    Pause,
    Refusal(String),
    Other(String),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// Cost the provider reported itself (OpenRouter).
    pub cost: Option<f64>,
}

#[derive(Debug, Clone)]
pub(crate) struct Reply {
    pub parts: Vec<Part>,
    pub stop: Stop,
    pub usage: Usage,
}

// ---- models and endpoints --------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ModelRef {
    pub provider: ProviderKind,
    pub model: String,
}

impl ModelRef {
    /// `openrouter:anthropic/claude-sonnet-4.5`, `anthropic:claude-sonnet-4-5`, …
    /// Without a prefix the provider is guessed from the name.
    pub fn parse(s: &str) -> Result<Self> {
        let s = s.trim();
        if s.is_empty() {
            bail!("No model chosen for this thread");
        }
        if let Some((prefix, rest)) = s.split_once(':') {
            if let Some(p) = provider_from_id(prefix) {
                if !matches!(p, ProviderKind::OpenRouter | ProviderKind::Anthropic | ProviderKind::OpenAi | ProviderKind::Google) {
                    bail!("{} does not offer chat models", provider_name(p));
                }
                if rest.trim().is_empty() {
                    bail!("Model name missing in {s:?}");
                }
                return Ok(Self { provider: p, model: rest.trim().to_string() });
            }
        }
        let provider = if s.contains('/') {
            ProviderKind::OpenRouter
        } else if s.starts_with("claude") {
            ProviderKind::Anthropic
        } else if s.starts_with("gemini") {
            ProviderKind::Google
        } else if s.starts_with("gpt") || s.starts_with("o1") || s.starts_with("o3") || s.starts_with("o4") || s.starts_with("chatgpt") {
            ProviderKind::OpenAi
        } else {
            ProviderKind::OpenRouter
        };
        Ok(Self { provider, model: s.to_string() })
    }
}

pub(crate) fn provider_from_id(id: &str) -> Option<ProviderKind> {
    ProviderKind::ALL.into_iter().find(|p| p.id().eq_ignore_ascii_case(id.trim()))
}

pub(crate) fn provider_name(p: ProviderKind) -> &'static str {
    match p {
        ProviderKind::OpenRouter => "OpenRouter",
        ProviderKind::Anthropic => "Anthropic",
        ProviderKind::OpenAi => "OpenAI",
        ProviderKind::Google => "Google",
        ProviderKind::Fal => "fal",
        ProviderKind::Replicate => "Replicate",
        ProviderKind::ElevenLabs => "ElevenLabs",
    }
}

/// "Add an OpenRouter key in Settings"
pub(crate) fn missing_key(p: ProviderKind) -> String {
    let name = provider_name(p);
    let article = if name.starts_with(['A', 'E', 'I', 'O', 'U']) { "an" } else { "a" };
    format!("Add {article} {name} key in Settings")
}

fn default_base(p: ProviderKind) -> &'static str {
    match p {
        ProviderKind::OpenRouter => "https://openrouter.ai/api/v1",
        ProviderKind::Anthropic => "https://api.anthropic.com/v1",
        ProviderKind::OpenAi => "https://api.openai.com/v1",
        ProviderKind::Google => "https://generativelanguage.googleapis.com/v1beta/openai",
        ProviderKind::Fal => "https://fal.run",
        ProviderKind::Replicate => "https://api.replicate.com/v1",
        ProviderKind::ElevenLabs => "https://api.elevenlabs.io/v1",
    }
}

/// Base URL for a provider. `BOUVIO_<PROVIDER>_BASE_URL` (e.g. `BOUVIO_OPENAI_BASE_URL`)
/// overrides it; meant for tests against a local mock server.
pub(crate) fn base_url(p: ProviderKind) -> String {
    base_override(p.id()).unwrap_or_else(|| default_base(p).to_string())
}

pub(crate) fn base_override(id: &str) -> Option<String> {
    let var = format!("BOUVIO_{}_BASE_URL", id.to_ascii_uppercase());
    std::env::var(var).ok().filter(|v| !v.trim().is_empty()).map(|v| v.trim().trim_end_matches('/').to_string())
}

pub(crate) fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("Bouvio/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(20))
            // Non-streaming completions can take minutes on long answers.
            .timeout(Duration::from_secs(600))
            .build()
            .expect("http client")
    })
}

pub(crate) async fn complete(m: &ModelRef, key: &str, req: &Request<'_>, cancel: &CancellationToken) -> Result<Reply> {
    match m.provider {
        ProviderKind::Anthropic => anthropic::complete(&m.model, key, req, cancel).await,
        p => openai::complete(p, &m.model, key, req, cancel).await,
    }
}

// ---- HTTP with retry ----------------------------------------------------------------

/// Marker error: the turn was cancelled while waiting.
#[derive(Debug)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("cancelled")
    }
}
impl std::error::Error for Cancelled {}

pub(crate) fn is_cancelled(e: &anyhow::Error) -> bool {
    e.downcast_ref::<Cancelled>().is_some()
}

const MAX_ATTEMPTS: u32 = 4;

fn retryable(status: u16) -> bool {
    matches!(status, 408 | 409 | 429 | 500 | 502 | 503 | 504 | 529)
}

fn backoff(attempt: u32) -> Duration {
    Duration::from_millis(1000 * 2u64.pow(attempt.saturating_sub(1)))
}

async fn pause(d: Duration, cancel: &CancellationToken) -> Result<()> {
    tokio::select! {
        _ = cancel.cancelled() => Err(Cancelled.into()),
        _ = tokio::time::sleep(d) => Ok(()),
    }
}

/// Send a request (rebuilt for every attempt) and parse the JSON answer. Retries
/// 429/5xx and connection failures a few times with a short backoff.
pub(crate) async fn send_json(
    provider: ProviderKind,
    build: impl Fn() -> reqwest::RequestBuilder,
    cancel: &CancellationToken,
) -> Result<Value> {
    let name = provider_name(provider);
    let mut attempt = 0;
    loop {
        attempt += 1;
        let res = tokio::select! {
            _ = cancel.cancelled() => return Err(Cancelled.into()),
            r = build().send() => r,
        };
        let resp = match res {
            Ok(r) => r,
            Err(e) if attempt < MAX_ATTEMPTS && e.is_connect() => {
                tracing::warn!("{name} request failed (attempt {attempt}): {e}");
                pause(backoff(attempt), cancel).await?;
                continue;
            }
            Err(e) => bail!("Could not reach {name}: {e}"),
        };
        let status = resp.status().as_u16();
        let retry_after = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        let text = tokio::select! {
            _ = cancel.cancelled() => return Err(Cancelled.into()),
            t = resp.text() => t.map_err(|e| anyhow!("Reading the {name} response failed: {e}"))?,
        };
        if (200..300).contains(&status) {
            return serde_json::from_str(&text)
                .map_err(|e| anyhow!("{name} sent a response that is not JSON ({e}): {}", clip(&text, 300)));
        }
        if retryable(status) && attempt < MAX_ATTEMPTS {
            let wait = retry_after.unwrap_or_else(|| backoff(attempt)).min(Duration::from_secs(20));
            tracing::warn!("{name} returned {status}, retrying in {wait:?}");
            pause(wait, cancel).await?;
            continue;
        }
        bail!(api_error(provider, status, &text));
    }
}

/// Error text out of a provider's error body, whichever shape it has.
pub(crate) fn error_message(v: &Value) -> Option<String> {
    let e = if v.is_array() { &v[0]["error"] } else { &v["error"] };
    match e {
        Value::String(s) => Some(s.clone()),
        Value::Object(_) => e["message"].as_str().map(str::to_string).or_else(|| Some(e.to_string())),
        _ => v["detail"].as_str().or(v["message"].as_str()).map(str::to_string),
    }
}

pub(crate) fn api_error(provider: ProviderKind, status: u16, body: &str) -> String {
    let name = provider_name(provider);
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| error_message(&v))
        .unwrap_or_else(|| clip(body.trim(), 500));
    match status {
        401 | 403 => format!("{name} rejected the key ({status}): {msg}. Check it in Settings."),
        402 => format!("{name} says the account is out of credit (402): {msg}"),
        429 => format!("{name} is rate limiting this key (429): {msg}"),
        _ => format!("{name} returned {status}: {msg}"),
    }
}

pub(crate) fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_model_refs() {
        let m = ModelRef::parse("openrouter:anthropic/claude-sonnet-4.5").unwrap();
        assert_eq!((m.provider, m.model.as_str()), (ProviderKind::OpenRouter, "anthropic/claude-sonnet-4.5"));
        let m = ModelRef::parse("anthropic:claude-sonnet-4-5").unwrap();
        assert_eq!(m.provider, ProviderKind::Anthropic);
        assert_eq!(ModelRef::parse("google:gemini-2.5-pro").unwrap().provider, ProviderKind::Google);
        assert_eq!(ModelRef::parse("openai:gpt-4.1").unwrap().model, "gpt-4.1");
        assert_eq!(ModelRef::parse("gpt-4.1").unwrap().provider, ProviderKind::OpenAi);
        assert_eq!(ModelRef::parse("meta/llama").unwrap().provider, ProviderKind::OpenRouter);
        assert!(ModelRef::parse("fal:flux").is_err());
        assert!(ModelRef::parse("").is_err());
    }

    #[test]
    fn missing_key_text() {
        assert_eq!(missing_key(ProviderKind::OpenRouter), "Add an OpenRouter key in Settings");
        assert_eq!(missing_key(ProviderKind::Google), "Add a Google key in Settings");
    }

    #[test]
    fn error_shapes() {
        let v: Value = serde_json::from_str(r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#).unwrap();
        assert_eq!(error_message(&v).unwrap(), "Overloaded");
        let v: Value = serde_json::from_str(r#"[{"error":{"code":400,"message":"bad"}}]"#).unwrap();
        assert_eq!(error_message(&v).unwrap(), "bad");
        assert!(api_error(ProviderKind::Anthropic, 401, r#"{"error":{"message":"invalid x-api-key"}}"#).contains("Check it in Settings"));
    }

    #[tokio::test]
    async fn retries_429_then_succeeds() {
        use axum::{http::StatusCode, response::IntoResponse, routing::post, Router};
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::sync::Arc;
        let hits = Arc::new(AtomicU32::new(0));
        let h = hits.clone();
        let app = Router::new().route(
            "/x",
            post(move || {
                let h = h.clone();
                async move {
                    if h.fetch_add(1, Ordering::SeqCst) == 0 {
                        (StatusCode::TOO_MANY_REQUESTS, [("retry-after", "0")], "{}").into_response()
                    } else {
                        (StatusCode::OK, r#"{"ok":true}"#).into_response()
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let url = format!("http://{addr}/x");
        let v = send_json(ProviderKind::OpenAi, || http().post(&url).body("{}"), &CancellationToken::new()).await.unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }
}
