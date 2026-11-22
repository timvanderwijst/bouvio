//! One-shot completions and embeddings for the rest of the app (briefs,
//! summaries, search, evals). Local models come first, so this works without keys.

use crate::keys::KeyStore;
use crate::local;
use crate::provider::{self, Message, ModelRef, Part, Request};
use anyhow::{anyhow, bail, Result};
use cuna_protocol::ProviderKind;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

/// A cheap, capable model per provider for one-shot work.
const FALLBACKS: &[(ProviderKind, &str)] = &[
    (ProviderKind::Anthropic, "anthropic:claude-haiku-4-5"),
    (ProviderKind::OpenAi, "openai:gpt-4.1-mini"),
    (ProviderKind::Google, "google:gemini-2.5-flash"),
    (ProviderKind::OpenRouter, "openrouter:google/gemini-2.5-flash"),
];

/// The model a one-shot call uses: the one asked for, else the configured
/// default, else a local model when one runs, else any provider with a key.
pub async fn resolve_model(keys: &dyn KeyStore, model: Option<&str>) -> Result<String> {
    if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
        return Ok(m.to_string());
    }
    let configured = local::config().default_model;
    if !configured.is_empty() {
        return Ok(configured);
    }
    if let Some(m) = local::default_chat_model().await {
        return Ok(m);
    }
    FALLBACKS
        .iter()
        .find(|(p, _)| keys.get(*p).is_some())
        .map(|(_, m)| m.to_string())
        .ok_or_else(|| anyhow!("No model to use: start Ollama or LM Studio on this computer (free), or add a key in Settings"))
}

/// The key for a provider; local servers usually need none.
pub(crate) fn key_for(keys: &dyn KeyStore, p: ProviderKind) -> Result<String> {
    match keys.get(p) {
        Some(k) => Ok(k),
        None if p == ProviderKind::Local => Ok(String::new()),
        None => Err(anyhow!(provider::missing_key(p))),
    }
}

/// Drop `<think>…</think>` blocks some local reasoning models put in their text.
pub(crate) fn strip_think(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("<think>") {
        out.push_str(&rest[..i]);
        match rest[i..].find("</think>") {
            Some(j) => rest = &rest[i + j + "</think>".len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// One prompt, one answer, no tools. `model: None` picks as [`resolve_model`] does.
pub async fn complete(keys: &dyn KeyStore, model: Option<&str>, system: &str, user: &str) -> Result<String> {
    let id = resolve_model(keys, model).await?;
    let m = ModelRef::parse(&id)?;
    let key = key_for(keys, m.provider)?;
    let messages = [Message::user_text(user)];
    let req = Request { system, messages: &messages, tools: &[] };
    let reply = provider::complete(&m, &key, &req, &CancellationToken::new()).await?;
    let text: Vec<&str> = reply
        .parts
        .iter()
        .filter_map(|p| match p {
            Part::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    let text = strip_think(&text.join("\n"));
    if text.is_empty() {
        bail!("{id} sent an empty answer");
    }
    Ok(text)
}

/// Embed texts: Ollama (`nomic-embed-text`, pulled on first use) when it runs,
/// else OpenAI `text-embedding-3-small` with a key. Vectors of different
/// sources do not mix; callers that store them should note which they used.
pub async fn embed(keys: &dyn KeyStore, texts: &[String]) -> Result<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(vec![]);
    }
    if local::ollama_up().await {
        return local::ollama_embed(texts).await;
    }
    if let Some(k) = keys.get(ProviderKind::OpenAi) {
        return openai_embed(&k, texts).await;
    }
    bail!("No embedding model: start Ollama on this computer (free) or add an OpenAI key in Settings")
}

async fn openai_embed(key: &str, texts: &[String]) -> Result<Vec<Vec<f32>>> {
    let url = format!("{}/embeddings", provider::base_url(ProviderKind::OpenAi));
    let mut out = Vec::with_capacity(texts.len());
    for chunk in texts.chunks(256) {
        let body = json!({ "model": "text-embedding-3-small", "input": chunk });
        let v = provider::send_json(ProviderKind::OpenAi, || provider::http().post(&url).bearer_auth(key).json(&body), &CancellationToken::new()).await?;
        out.extend(parse_openai_embeddings(&v, chunk.len())?);
    }
    Ok(out)
}

/// `{"data":[{"index":0,"embedding":[…]}…]}`, put back in input order.
pub(crate) fn parse_openai_embeddings(v: &Value, want: usize) -> Result<Vec<Vec<f32>>> {
    let mut items: Vec<(usize, Vec<f32>)> = v["data"]
        .as_array()
        .ok_or_else(|| anyhow!("OpenAI sent no embeddings"))?
        .iter()
        .enumerate()
        .map(|(i, d)| {
            let idx = d["index"].as_u64().map(|x| x as usize).unwrap_or(i);
            (idx, d["embedding"].as_array().into_iter().flatten().filter_map(|x| x.as_f64()).map(|x| x as f32).collect())
        })
        .collect();
    items.sort_by_key(|(i, _)| *i);
    if items.len() != want {
        bail!("Asked for {want} embeddings, got {}", items.len());
    }
    Ok(items.into_iter().map(|(_, e)| e).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::StaticKeys;

    #[test]
    fn strips_think_blocks() {
        assert_eq!(strip_think("<think>\nhmm\n</think>\n\nHello"), "Hello");
        assert_eq!(strip_think("A <think>x</think>B<think>y</think> C"), "A B C");
        assert_eq!(strip_think("<think>never closed"), "");
        assert_eq!(strip_think("plain"), "plain");
    }

    #[test]
    fn local_needs_no_key() {
        let keys = StaticKeys::new();
        assert_eq!(key_for(&keys, ProviderKind::Local).unwrap(), "");
        assert_eq!(key_for(&keys, ProviderKind::OpenAi).unwrap_err().to_string(), "Add an OpenAI key in Settings");
    }

    #[tokio::test]
    async fn explicit_model_wins() {
        let keys = StaticKeys::new();
        assert_eq!(resolve_model(&keys, Some(" openai:gpt-4.1 ")).await.unwrap(), "openai:gpt-4.1");
    }

    #[test]
    fn orders_openai_embeddings() {
        let v = json!({"data":[{"index":1,"embedding":[2.0]},{"index":0,"embedding":[1.0]}]});
        assert_eq!(parse_openai_embeddings(&v, 2).unwrap(), vec![vec![1.0f32], vec![2.0]]);
        assert!(parse_openai_embeddings(&v, 1).is_err());
    }
}
