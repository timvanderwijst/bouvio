//! OpenAI-compatible chat completions with tools: OpenRouter, OpenAI, Google's
//! OpenAI-compatible endpoint, and local servers (Ollama, LM Studio, others).

use super::{base_url, send_json, Message, Part, Reply, Request, Role, Stop, Usage};
use anyhow::{bail, Result};
use bouvio_protocol::ProviderKind;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

pub(crate) async fn complete(
    provider: ProviderKind,
    model: &str,
    key: &str,
    req: &Request<'_>,
    cancel: &CancellationToken,
) -> Result<Reply> {
    let mut body = build_request(provider, model, req);
    let base = if provider == ProviderKind::Local { crate::local::chat_base(model) } else { base_url(provider) };
    let url = format!("{base}/chat/completions");
    let send = |body: &Value| {
        let body = body.clone();
        let url = url.clone();
        async move {
            send_json(
                provider,
                || {
                    let mut b = super::http().post(&url).json(&body);
                    // Local servers usually take no key.
                    if !key.is_empty() {
                        b = b.bearer_auth(key);
                    }
                    if provider == ProviderKind::OpenRouter {
                        b = b.header("HTTP-Referer", "https://github.com/bouvio/bouvio").header("X-Title", "Bouvio");
                    }
                    b
                },
                cancel,
            )
            .await
        }
    };
    let v = match send(&body).await {
        // Some local models cannot call tools; answer without them rather than fail.
        Err(e) if provider == ProviderKind::Local && body.get("tools").is_some() && no_tool_support(&e) => {
            tracing::info!("{model} does not support tools; continuing without them");
            body.as_object_mut().map(|o| o.remove("tools"));
            send(&body).await?
        }
        r => r?,
    };
    let mut reply = parse_response(&v)?;
    if provider == ProviderKind::Local {
        for p in &mut reply.parts {
            if let Part::Text { text } = p {
                *text = crate::oneshot::strip_think(text);
            }
        }
        reply.parts.retain(|p| !matches!(p, Part::Text { text } if text.is_empty()));
    }
    Ok(reply)
}

fn no_tool_support(e: &anyhow::Error) -> bool {
    let s = e.to_string().to_ascii_lowercase();
    s.contains("does not support tools") || s.contains("tools are not supported") || s.contains("tool use is not supported")
}

fn nonempty(s: &str) -> &str {
    if s.is_empty() {
        "(no output)"
    } else {
        s
    }
}

pub(crate) fn build_request(provider: ProviderKind, model: &str, req: &Request<'_>) -> Value {
    let mut messages = vec![json!({ "role": "system", "content": req.system })];
    for m in req.messages {
        push_message(provider, m, &mut messages);
    }
    let mut body = json!({ "model": model, "messages": messages });
    if !req.tools.is_empty() {
        body["tools"] = req
            .tools
            .iter()
            .map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.schema } }))
            .collect();
    }
    if provider == ProviderKind::OpenRouter {
        // OpenRouter reports what the call cost in `usage.cost`.
        body["usage"] = json!({ "include": true });
    }
    body
}

fn push_message(provider: ProviderKind, m: &Message, out: &mut Vec<Value>) {
    let texts: Vec<&str> = m
        .parts
        .iter()
        .filter_map(|p| match p {
            Part::Text { text } if !text.trim().is_empty() => Some(text.as_str()),
            _ => None,
        })
        .collect();
    match m.role {
        Role::User => {
            // Tool results must directly follow the assistant message that asked for them.
            for p in &m.parts {
                if let Part::ToolResult { id, output, .. } = p {
                    out.push(json!({ "role": "tool", "tool_call_id": id, "content": nonempty(output) }));
                }
            }
            if !texts.is_empty() {
                out.push(json!({ "role": "user", "content": texts.join("\n\n") }));
            }
        }
        Role::Assistant => {
            let calls: Vec<Value> = m
                .parts
                .iter()
                .filter_map(|p| match p {
                    Part::ToolCall { id, name, input, extra } => {
                        let arguments = match input {
                            Value::String(raw) => raw.clone(),
                            other => other.to_string(),
                        };
                        let mut c = json!({ "id": id, "type": "function", "function": { "name": name, "arguments": arguments } });
                        if let Some(extra) = extra {
                            c["extra_content"] = extra.clone();
                        }
                        Some(c)
                    }
                    _ => None,
                })
                .collect();
            if texts.is_empty() && calls.is_empty() {
                return;
            }
            let mut msg = json!({
                "role": "assistant",
                "content": if texts.is_empty() { Value::Null } else { Value::String(texts.join("\n\n")) },
            });
            if !calls.is_empty() {
                msg["tool_calls"] = Value::Array(calls);
            }
            if provider == ProviderKind::OpenRouter {
                for p in &m.parts {
                    if let Part::Opaque { provider, value } = p {
                        if provider == "openrouter" {
                            msg["reasoning_details"] = value.clone();
                        }
                    }
                }
            }
            out.push(msg);
        }
    }
}

pub(crate) fn parse_response(v: &Value) -> Result<Reply> {
    if let Some(msg) = v.get("error").and_then(|_| super::error_message(v)) {
        bail!("The model provider returned an error: {msg}");
    }
    let Some(choice) = v["choices"].get(0) else {
        bail!("The model sent no answer: {}", super::clip(&v.to_string(), 300));
    };
    let msg = &choice["message"];
    let mut parts = Vec::new();
    if let Some(rd) = msg.get("reasoning_details").filter(|r| r.as_array().is_some_and(|a| !a.is_empty())) {
        parts.push(Part::Opaque { provider: "openrouter".into(), value: rd.clone() });
    }
    let text = match &msg["content"] {
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().filter_map(|i| i["text"].as_str()).collect::<Vec<_>>().join(""),
        _ => String::new(),
    };
    if !text.is_empty() {
        parts.push(Part::Text { text });
    }
    for tc in msg["tool_calls"].as_array().into_iter().flatten() {
        let id = tc["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("call_{}", uuid::Uuid::new_v4().simple()));
        let name = tc["function"]["name"].as_str().unwrap_or_default().to_string();
        let input = match &tc["function"]["arguments"] {
            Value::String(s) if s.trim().is_empty() => json!({}),
            // Invalid JSON stays a string; the agent reports it back as a tool error.
            Value::String(s) => serde_json::from_str(s).unwrap_or_else(|_| Value::String(s.clone())),
            Value::Null => json!({}),
            other => other.clone(),
        };
        let extra = tc.get("extra_content").filter(|e| !e.is_null()).cloned();
        parts.push(Part::ToolCall { id, name, input, extra });
    }
    let stop = match choice["finish_reason"].as_str() {
        Some("stop") => Stop::EndTurn,
        Some("tool_calls") | Some("function_call") => Stop::ToolUse,
        Some("length") => Stop::MaxTokens,
        Some("content_filter") => Stop::Refusal("The provider's content filter blocked this answer".into()),
        Some(other) => Stop::Other(other.to_string()),
        None => Stop::Other("unknown".into()),
    };
    let u = &v["usage"];
    let usage = Usage {
        input: u["prompt_tokens"].as_u64().unwrap_or(0),
        output: u["completion_tokens"].as_u64().unwrap_or(0),
        cache_read: 0,
        cache_write: 0,
        cost: u["cost"].as_f64(),
    };
    Ok(Reply { parts, stop, usage })
}

#[cfg(test)]
mod tests {
    use super::super::ToolSpec;
    use super::*;

    fn history() -> Vec<Message> {
        vec![
            Message::user_text("Fix main"),
            Message {
                role: Role::Assistant,
                parts: vec![
                    Part::Text { text: "Looking.".into() },
                    Part::ToolCall { id: "call_1".into(), name: "read_file".into(), input: json!({"file_path":"a.rs"}), extra: None },
                    Part::ToolCall {
                        id: "call_2".into(),
                        name: "bash".into(),
                        input: json!({"command":"ls"}),
                        extra: Some(json!({"google":{"thought_signature":"sig"}})),
                    },
                    Part::Opaque { provider: "anthropic".into(), value: json!({"type":"thinking"}) },
                ],
            },
            Message {
                role: Role::User,
                parts: vec![
                    Part::ToolResult { id: "call_1".into(), output: "fn main(){}".into(), is_error: false },
                    Part::ToolResult { id: "call_2".into(), output: String::new(), is_error: true },
                ],
            },
        ]
    }

    #[test]
    fn builds_request() {
        let h = history();
        let tools = vec![ToolSpec { name: "read_file".into(), description: "Read".into(), schema: json!({"type":"object"}) }];
        let body = build_request(ProviderKind::OpenRouter, "anthropic/claude-sonnet-4.5", &Request { system: "sys", messages: &h, tools: &tools });
        let m = body["messages"].as_array().unwrap();
        assert_eq!(m.len(), 5);
        assert_eq!(m[0], json!({"role":"system","content":"sys"}));
        assert_eq!(m[1], json!({"role":"user","content":"Fix main"}));
        assert_eq!(m[2]["role"], "assistant");
        assert_eq!(m[2]["content"], "Looking.");
        assert_eq!(m[2]["tool_calls"][0]["function"]["arguments"], r#"{"file_path":"a.rs"}"#);
        assert_eq!(m[2]["tool_calls"][1]["extra_content"]["google"]["thought_signature"], "sig");
        assert_eq!(m[3], json!({"role":"tool","tool_call_id":"call_1","content":"fn main(){}"}));
        assert_eq!(m[4]["content"], "(no output)");
        assert_eq!(body["tools"][0]["function"]["name"], "read_file");
        assert_eq!(body["usage"]["include"], true);
        let body = build_request(ProviderKind::OpenAi, "gpt-4.1", &Request { system: "s", messages: &h, tools: &[] });
        assert!(body.get("usage").is_none());
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn parses_tool_calls_fixture() {
        let v: Value = serde_json::from_str(include_str!("fixtures/openai_tool_calls.json")).unwrap();
        let r = parse_response(&v).unwrap();
        assert_eq!(r.stop, Stop::ToolUse);
        assert_eq!(r.parts.len(), 3);
        assert_eq!(r.parts[0], Part::Text { text: "Let me look at both files.".into() });
        assert!(matches!(&r.parts[1], Part::ToolCall { id, name, input, .. } if id == "call_1" && name == "read_file" && input["file_path"] == "src/main.rs"));
        assert!(matches!(&r.parts[2], Part::ToolCall { name, .. } if name == "grep"));
        assert_eq!((r.usage.input, r.usage.output, r.usage.cost), (1200, 80, None));
    }

    #[test]
    fn parses_openrouter_cost_fixture() {
        let v: Value = serde_json::from_str(include_str!("fixtures/openrouter_final.json")).unwrap();
        let r = parse_response(&v).unwrap();
        assert_eq!(r.stop, Stop::EndTurn);
        assert_eq!(r.usage.cost, Some(0.0153));
        assert_eq!(r.parts, vec![Part::Text { text: "The tests pass now.".into() }]);
    }

    #[test]
    fn bad_arguments_and_errors() {
        let v = json!({"choices":[{"message":{"content":null,"tool_calls":[{"id":"","function":{"name":"bash","arguments":"{oops"}}]},"finish_reason":"tool_calls"}]});
        let r = parse_response(&v).unwrap();
        assert!(matches!(&r.parts[0], Part::ToolCall { id, input: Value::String(s), .. } if id.starts_with("call_") && s == "{oops"));
        let v = json!({"error":{"message":"No endpoints found","code":404}});
        assert!(parse_response(&v).unwrap_err().to_string().contains("No endpoints found"));
    }
}
