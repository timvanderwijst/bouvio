//! The Anthropic Messages API: `x-api-key`, `anthropic-version`, content blocks
//! with `tool_use` / `tool_result`.

use super::{base_url, send_json, Part, Reply, Request, Role, Stop, Usage};
use anyhow::{bail, Result};
use bouvio_protocol::ProviderKind;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

pub(crate) const VERSION: &str = "2023-06-01";
/// Non-streaming requests: high enough for long edits, low enough to stay under timeouts.
const MAX_TOKENS: u32 = 16000;

pub(crate) async fn complete(model: &str, key: &str, req: &Request<'_>, cancel: &CancellationToken) -> Result<Reply> {
    let body = build_request(model, req);
    let url = format!("{}/messages", base_url(ProviderKind::Anthropic));
    let v = send_json(
        ProviderKind::Anthropic,
        || super::http().post(&url).header("x-api-key", key).header("anthropic-version", VERSION).json(&body),
        cancel,
    )
    .await?;
    parse_response(&v)
}

pub(crate) fn build_request(model: &str, req: &Request<'_>) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    for m in req.messages {
        let mut blocks = Vec::new();
        match m.role {
            Role::User => {
                // tool_result blocks go first in a user turn.
                for p in &m.parts {
                    if let Part::ToolResult { id, output, is_error } = p {
                        let content = if output.is_empty() { "(no output)" } else { output.as_str() };
                        blocks.push(json!({ "type": "tool_result", "tool_use_id": id, "content": content, "is_error": is_error }));
                    }
                }
                for p in &m.parts {
                    if let Part::Text { text } = p {
                        if !text.trim().is_empty() {
                            blocks.push(json!({ "type": "text", "text": text }));
                        }
                    }
                }
            }
            Role::Assistant => {
                for p in &m.parts {
                    match p {
                        Part::Text { text } if !text.trim().is_empty() => blocks.push(json!({ "type": "text", "text": text })),
                        Part::ToolCall { id, name, input, .. } => {
                            let input = if input.is_object() { input.clone() } else { json!({}) };
                            blocks.push(json!({ "type": "tool_use", "id": id, "name": name, "input": input }));
                        }
                        Part::Opaque { provider, value } if provider == "anthropic" => blocks.push(value.clone()),
                        _ => {}
                    }
                }
            }
        }
        if blocks.is_empty() {
            continue;
        }
        let role = match m.role {
            Role::User => "user",
            Role::Assistant => "assistant",
        };
        match messages.last_mut() {
            Some(last) if last["role"] == role => {
                if let Some(c) = last["content"].as_array_mut() {
                    c.extend(blocks);
                }
            }
            _ => messages.push(json!({ "role": role, "content": blocks })),
        }
    }
    // Cache the conversation so far: each step of a turn re-sends it, and reads
    // cost a tenth of fresh input.
    if let Some(block) = messages.last_mut().and_then(|m| m["content"].as_array_mut()).and_then(|c| c.last_mut()) {
        block["cache_control"] = json!({ "type": "ephemeral" });
    }
    let mut body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": [{ "type": "text", "text": req.system, "cache_control": { "type": "ephemeral" } }],
        "messages": messages,
    });
    if !req.tools.is_empty() {
        body["tools"] = req
            .tools
            .iter()
            .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.schema }))
            .collect();
    }
    body
}

pub(crate) fn parse_response(v: &Value) -> Result<Reply> {
    if v["type"] == "error" {
        bail!("Anthropic returned an error: {}", super::error_message(v).unwrap_or_default());
    }
    let mut parts = Vec::new();
    for b in v["content"].as_array().into_iter().flatten() {
        match b["type"].as_str() {
            Some("text") => parts.push(Part::Text { text: b["text"].as_str().unwrap_or_default().to_string() }),
            Some("tool_use") => parts.push(Part::ToolCall {
                id: b["id"].as_str().unwrap_or_default().to_string(),
                name: b["name"].as_str().unwrap_or_default().to_string(),
                input: b["input"].clone(),
                extra: None,
            }),
            // thinking, redacted_thinking, server tool blocks: keep and send back as is.
            _ => parts.push(Part::Opaque { provider: "anthropic".into(), value: b.clone() }),
        }
    }
    let stop = match v["stop_reason"].as_str() {
        Some("end_turn") | Some("stop_sequence") => Stop::EndTurn,
        Some("tool_use") => Stop::ToolUse,
        Some("max_tokens") | Some("model_context_window_exceeded") => Stop::MaxTokens,
        Some("pause_turn") => Stop::Pause,
        Some("refusal") => Stop::Refusal(
            v["stop_details"]["explanation"].as_str().unwrap_or("The model declined this request").to_string(),
        ),
        Some(other) => Stop::Other(other.to_string()),
        None => Stop::Other("unknown".into()),
    };
    let u = &v["usage"];
    let usage = Usage {
        input: u["input_tokens"].as_u64().unwrap_or(0),
        output: u["output_tokens"].as_u64().unwrap_or(0),
        cache_read: u["cache_read_input_tokens"].as_u64().unwrap_or(0),
        cache_write: u["cache_creation_input_tokens"].as_u64().unwrap_or(0),
        cost: None,
    };
    Ok(Reply { parts, stop, usage })
}

#[cfg(test)]
mod tests {
    use super::super::{Message, ToolSpec};
    use super::*;

    #[test]
    fn builds_request() {
        let h = vec![
            Message::user_text("Run the tests"),
            Message {
                role: Role::Assistant,
                parts: vec![
                    Part::Opaque { provider: "anthropic".into(), value: json!({"type":"thinking","thinking":"","signature":"s"}) },
                    Part::Opaque { provider: "openrouter".into(), value: json!([]) },
                    Part::Text { text: "Running.".into() },
                    Part::ToolCall { id: "toolu_1".into(), name: "bash".into(), input: json!({"command":"cargo test"}), extra: None },
                ],
            },
            Message {
                role: Role::User,
                parts: vec![Part::ToolResult { id: "toolu_1".into(), output: "ok".into(), is_error: false }],
            },
            // An empty assistant message is skipped and the user turns merge.
            Message { role: Role::Assistant, parts: vec![] },
            Message::user_text("Thanks"),
        ];
        let tools = vec![ToolSpec { name: "bash".into(), description: "Run".into(), schema: json!({"type":"object"}) }];
        let body = build_request("claude-sonnet-4-5", &Request { system: "sys", messages: &h, tools: &tools });
        assert_eq!(body["max_tokens"], 16000);
        assert_eq!(body["system"][0]["text"], "sys");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        let m = body["messages"].as_array().unwrap();
        assert_eq!(m.len(), 3);
        assert_eq!(m[0]["content"][0], json!({"type":"text","text":"Run the tests"}));
        let a = m[1]["content"].as_array().unwrap();
        assert_eq!(a.len(), 3);
        assert_eq!(a[0]["type"], "thinking");
        assert_eq!(a[2], json!({"type":"tool_use","id":"toolu_1","name":"bash","input":{"command":"cargo test"}}));
        let u = m[2]["content"].as_array().unwrap();
        assert_eq!(u[0]["type"], "tool_result");
        assert_eq!(u[0]["tool_use_id"], "toolu_1");
        assert_eq!(u[1]["text"], "Thanks");
        assert_eq!(u[1]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn parses_tool_use_fixture() {
        let v: Value = serde_json::from_str(include_str!("fixtures/anthropic_tool_use.json")).unwrap();
        let r = parse_response(&v).unwrap();
        assert_eq!(r.stop, Stop::ToolUse);
        assert!(matches!(&r.parts[0], Part::Opaque { provider, value } if provider == "anthropic" && value["type"] == "thinking"));
        assert_eq!(r.parts[1], Part::Text { text: "I'll run the tests.".into() });
        assert!(matches!(&r.parts[2], Part::ToolCall { id, name, input, .. } if id == "toolu_01A" && name == "bash" && input["command"] == "cargo test"));
        assert!(matches!(&r.parts[3], Part::ToolCall { name, .. } if name == "read_file"));
        assert_eq!(r.usage, Usage { input: 2000, output: 150, cache_read: 10000, cache_write: 1000, cost: None });
    }

    #[test]
    fn parses_refusal_fixture() {
        let v: Value = serde_json::from_str(include_str!("fixtures/anthropic_refusal.json")).unwrap();
        assert_eq!(parse_response(&v).unwrap().stop, Stop::Refusal("This request was declined.".into()));
        let e = json!({"type":"error","error":{"type":"invalid_request_error","message":"bad"}});
        assert!(parse_response(&e).is_err());
    }
}
