//! Models the agent can use, from each provider's list endpoint.

use crate::keys::KeyStore;
use crate::pricing::price;
use crate::provider::{base_override, base_url, http, provider_name};
use anyhow::{bail, Result};
use bouvio_protocol::{ModelInfo, ProviderKind};
use serde_json::Value;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(15);

/// OpenRouter's catalog works without a key; Anthropic, OpenAI and Google are
/// listed only when a key exists; local models when a local server runs. A
/// provider that fails is skipped, never the whole list. OpenRouter models without tool support are left out, since the
/// agent needs tools.
pub async fn list_models(keys: &dyn KeyStore) -> Vec<ModelInfo> {
    let or_key = keys.get(ProviderKind::OpenRouter);
    let an_key = keys.get(ProviderKind::Anthropic);
    let oa_key = keys.get(ProviderKind::OpenAi);
    let go_key = keys.get(ProviderKind::Google);
    let (a, b, c, d, local) = futures::join!(
        openrouter(or_key.as_deref()),
        async {
            match &an_key {
                Some(k) => anthropic(k).await,
                None => Ok(vec![]),
            }
        },
        async {
            match &oa_key {
                Some(k) => openai(k).await,
                None => Ok(vec![]),
            }
        },
        async {
            match &go_key {
                Some(k) => google(k).await,
                None => Ok(vec![]),
            }
        },
        crate::local::list_chat_models(),
    );
    let mut all = local;
    for (p, r) in [
        (ProviderKind::OpenRouter, a),
        (ProviderKind::Anthropic, b),
        (ProviderKind::OpenAi, c),
        (ProviderKind::Google, d),
    ] {
        match r {
            Ok(mut v) => all.append(&mut v),
            Err(e) => tracing::warn!("Listing {} models failed: {e:#}", provider_name(p)),
        }
    }
    all
}

async fn get(p: ProviderKind, req: reqwest::RequestBuilder) -> Result<Value> {
    let resp = req.timeout(TIMEOUT).send().await?;
    let status = resp.status().as_u16();
    let text = resp.text().await?;
    if !(200..300).contains(&status) {
        bail!(crate::provider::api_error(p, status, &text));
    }
    Ok(serde_json::from_str(&text)?)
}

fn per_million(v: &Value) -> Option<f64> {
    let per_token = match v {
        Value::String(s) => s.parse::<f64>().ok()?,
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    (per_token >= 0.0).then_some(per_token * 1_000_000.0)
}

async fn openrouter(key: Option<&str>) -> Result<Vec<ModelInfo>> {
    let mut req = http().get(format!("{}/models", base_url(ProviderKind::OpenRouter)));
    if let Some(k) = key {
        req = req.bearer_auth(k);
    }
    Ok(parse_openrouter(&get(ProviderKind::OpenRouter, req).await?))
}

pub(crate) fn parse_openrouter(v: &Value) -> Vec<ModelInfo> {
    v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| {
            m["supported_parameters"].as_array().is_none_or(|ps| ps.iter().any(|p| p == "tools"))
        })
        .filter_map(|m| {
            let id = m["id"].as_str()?;
            Some(ModelInfo {
                id: format!("openrouter:{id}"),
                name: m["name"].as_str().unwrap_or(id).to_string(),
                provider: ProviderKind::OpenRouter,
                context: m["context_length"].as_u64().map(|c| c as u32),
                price_in: per_million(&m["pricing"]["prompt"]),
                price_out: per_million(&m["pricing"]["completion"]),
            })
        })
        .collect()
}

async fn anthropic(key: &str) -> Result<Vec<ModelInfo>> {
    let req = http()
        .get(format!("{}/models?limit=1000", base_url(ProviderKind::Anthropic)))
        .header("x-api-key", key)
        .header("anthropic-version", crate::provider::anthropic::VERSION);
    let v = get(ProviderKind::Anthropic, req).await?;
    Ok(v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m["id"].as_str()?;
            let p = price(ProviderKind::Anthropic, id);
            Some(ModelInfo {
                id: format!("anthropic:{id}"),
                name: m["display_name"].as_str().unwrap_or(id).to_string(),
                provider: ProviderKind::Anthropic,
                context: m["max_input_tokens"].as_u64().map(|c| c as u32),
                price_in: p.map(|p| p.0),
                price_out: p.map(|p| p.1),
            })
        })
        .collect())
}

pub(crate) fn openai_chat_model(id: &str) -> bool {
    let chat = ["gpt-", "o1", "o3", "o4", "chatgpt-"].iter().any(|p| id.starts_with(p));
    let other = ["audio", "realtime", "tts", "transcribe", "image", "search", "embedding", "instruct", "moderation", "codex", "dall-e"]
        .iter()
        .any(|w| id.contains(w));
    chat && !other
}

async fn openai(key: &str) -> Result<Vec<ModelInfo>> {
    let req = http().get(format!("{}/models", base_url(ProviderKind::OpenAi))).bearer_auth(key);
    let v = get(ProviderKind::OpenAi, req).await?;
    let mut out: Vec<ModelInfo> = v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m["id"].as_str())
        .filter(|id| openai_chat_model(id))
        .map(|id| {
            let p = price(ProviderKind::OpenAi, id);
            ModelInfo {
                id: format!("openai:{id}"),
                name: id.to_string(),
                provider: ProviderKind::OpenAi,
                context: None,
                price_in: p.map(|p| p.0),
                price_out: p.map(|p| p.1),
            }
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

async fn google(key: &str) -> Result<Vec<ModelInfo>> {
    // The native list has display names and context sizes; the OpenAI-compatible
    // chat endpoint accepts the same ids.
    let base = base_override("google_native").unwrap_or_else(|| "https://generativelanguage.googleapis.com/v1beta".into());
    let req = http().get(format!("{base}/models?pageSize=1000")).header("x-goog-api-key", key);
    let v = get(ProviderKind::Google, req).await?;
    Ok(v["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| {
            m["supportedGenerationMethods"].as_array().is_some_and(|ms| ms.iter().any(|x| x == "generateContent"))
        })
        .filter_map(|m| {
            let id = m["name"].as_str()?.trim_start_matches("models/");
            if !id.starts_with("gemini") || id.contains("embedding") || id.contains("image") || id.contains("tts") {
                return None;
            }
            let p = price(ProviderKind::Google, id);
            Some(ModelInfo {
                id: format!("google:{id}"),
                name: m["displayName"].as_str().unwrap_or(id).to_string(),
                provider: ProviderKind::Google,
                context: m["inputTokenLimit"].as_u64().map(|c| c as u32),
                price_in: p.map(|p| p.0),
                price_out: p.map(|p| p.1),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_openrouter_catalog() {
        let v = json!({"data":[
            {"id":"anthropic/claude-sonnet-4.5","name":"Anthropic: Claude Sonnet 4.5","context_length":1000000,
             "pricing":{"prompt":"0.000003","completion":"0.000015"},"supported_parameters":["tools","temperature"]},
            {"id":"some/no-tools","name":"No tools","pricing":{"prompt":"0","completion":"0"},"supported_parameters":["temperature"]},
            {"id":"x/variable","name":"Router","pricing":{"prompt":"-1","completion":"-1"}}
        ]});
        let m = parse_openrouter(&v);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].id, "openrouter:anthropic/claude-sonnet-4.5");
        assert_eq!(m[0].context, Some(1_000_000));
        assert!((m[0].price_in.unwrap() - 3.0).abs() < 1e-9);
        assert!((m[0].price_out.unwrap() - 15.0).abs() < 1e-9);
        assert_eq!(m[1].price_in, None);
    }

    #[test]
    fn filters_openai_models() {
        assert!(openai_chat_model("gpt-4.1"));
        assert!(openai_chat_model("o4-mini"));
        assert!(!openai_chat_model("gpt-4o-realtime-preview"));
        assert!(!openai_chat_model("text-embedding-3-small"));
        assert!(!openai_chat_model("gpt-image-1"));
    }
}
