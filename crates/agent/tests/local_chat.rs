//! Local models through an OpenAI-compatible server (what Ollama and LM Studio
//! serve), against a mock. One test, so the base-URL env var is set once.

mod common;

use axum::{extract::State, http::{HeaderMap, StatusCode}, routing::{get, post}, Json, Router};
use bouvio_agent::{Agent, AgentConfig, CancellationToken, StaticKeys};
use bouvio_protocol::{ApprovalLevel, ProviderKind, ThreadEvent};
use common::{chat_text, chat_tool_call, cost, kinds, run_turn};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Mock {
    replies: Arc<Mutex<VecDeque<(u16, Value)>>>,
    requests: Arc<Mutex<Vec<(HeaderMap, Value)>>>,
}

async fn chat(State(m): State<Mock>, headers: HeaderMap, Json(body): Json<Value>) -> (StatusCode, Json<Value>) {
    m.requests.lock().unwrap().push((headers, body));
    let (status, v) = m.replies.lock().unwrap().pop_front().unwrap_or((500, json!({"error":"no more replies"})));
    (StatusCode::from_u16(status).unwrap(), Json(v))
}

async fn models() -> Json<Value> {
    Json(json!({"object":"list","data":[{"id":"qwen3:8b","object":"model"},{"id":"nomic-embed-text:latest","object":"model"}]}))
}

#[tokio::test]
async fn local_chat_models() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let mock = Mock::default();
    let app = Router::new().route("/v1/chat/completions", post(chat)).route("/v1/models", get(models)).with_state(mock.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    std::env::set_var("BOUVIO_LOCAL_BASE_URL", &base);
    let push = |status: u16, v: Value| mock.replies.lock().unwrap().push_back((status, v));

    // Listing: chat models only, free, provider Local.
    let listed = bouvio_agent::local::list_chat_models().await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, "local:qwen3:8b");
    assert_eq!(listed[0].provider, ProviderKind::Local);
    assert_eq!(listed[0].price_in, None);

    // An agent turn with a tool call, no key at all.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("hello.txt"), "hi there\n").unwrap();
    push(200, chat_tool_call("call_1", "read_file", json!({"file_path":"hello.txt"}), json!({"prompt_tokens":900,"completion_tokens":20})));
    push(200, chat_text("<think>\nThe file is short.\n</think>\n\nThe file says hi there.", json!({"prompt_tokens":950,"completion_tokens":12})));
    let mut cfg = AgentConfig::new(dir.path(), "local:qwen3:8b", Arc::new(StaticKeys::new()));
    cfg.approval = ApprovalLevel::AskRisky;
    let mut agent = Agent::new(cfg);
    let events = run_turn(&mut agent, "What does hello.txt say?", CancellationToken::new(), Some(false)).await;
    assert_eq!(
        kinds(&events),
        ["status:Working", "tool_use:Read", "tool_result:ok", "text:The file says hi there.", "turn_complete", "status:Idle"]
    );
    assert_eq!(cost(&events), Some(0.0));
    let reqs = mock.requests.lock().unwrap().clone();
    assert_eq!(reqs.len(), 2);
    assert!(reqs[0].0.get("authorization").is_none(), "no key is sent to a local server");
    assert_eq!(reqs[0].1["model"], "qwen3:8b");
    assert_eq!(reqs[0].1["tools"].as_array().unwrap().len(), 8);

    // A model without tool support: the request goes again without tools.
    push(400, json!({"error":{"message":"registry.ollama.ai/library/gemma3:4b does not support tools","type":"api_error"}}));
    push(200, chat_text("Hello!", json!({"prompt_tokens":10,"completion_tokens":2})));
    let mut agent = Agent::new(AgentConfig::new(dir.path(), "local:gemma3:4b", Arc::new(StaticKeys::new())));
    let events = run_turn(&mut agent, "Hi", CancellationToken::new(), None).await;
    assert_eq!(kinds(&events), ["status:Working", "text:Hello!", "turn_complete", "status:Idle"]);
    let reqs = mock.requests.lock().unwrap().clone();
    assert!(reqs[2].1.get("tools").is_some());
    assert!(reqs[3].1.get("tools").is_none());

    // One-shot completion.
    push(200, chat_text("A short brief.", json!({})));
    let text = bouvio_agent::complete(&StaticKeys::new(), Some("local:qwen3:8b"), "Summarize.", "Long text").await.unwrap();
    assert_eq!(text, "A short brief.");
    let last = mock.requests.lock().unwrap().last().unwrap().1.clone();
    assert_eq!(last["messages"][0], json!({"role":"system","content":"Summarize."}));
    assert!(last.get("tools").is_none());

    // With nothing chosen, the local model is the default.
    push(200, chat_text("ok", json!({})));
    assert_eq!(bouvio_agent::resolve_model(&StaticKeys::new(), None).await.unwrap(), "local:qwen3:8b");
    assert_eq!(bouvio_agent::complete(&StaticKeys::new(), None, "s", "u").await.unwrap(), "ok");

    // A server error (not retried) surfaces as a turn error.
    push(400, json!({"error":"model runner crashed"}));
    let mut agent = Agent::new(AgentConfig::new(dir.path(), "local:qwen3:8b", Arc::new(StaticKeys::new())));
    let events = run_turn(&mut agent, "Hi", CancellationToken::new(), None).await;
    assert!(events.iter().any(|e| matches!(e, ThreadEvent::Error { message } if message.contains("model runner crashed"))));
}
