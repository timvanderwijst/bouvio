//! A tiny mock of the provider endpoints, and helpers to drive a turn.
#![allow(dead_code)]

use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
use bouvio_agent::{Agent, AgentOut, CancellationToken};
use bouvio_protocol::ThreadEvent;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct Mock {
    pub base: String,
    replies: Arc<Mutex<VecDeque<Value>>>,
    pub requests: Arc<Mutex<Vec<(HeaderMap, Value)>>>,
}

impl Mock {
    pub fn requests(&self) -> Vec<(HeaderMap, Value)> {
        self.requests.lock().unwrap().clone()
    }
}

async fn reply(State(m): State<Mock>, headers: HeaderMap, Json(body): Json<Value>) -> Json<Value> {
    m.requests.lock().unwrap().push((headers, body));
    let next = m.replies.lock().unwrap().pop_front();
    Json(next.unwrap_or_else(|| serde_json::json!({ "error": { "message": "mock has no more replies" } })))
}

/// Serve `replies` in order on POST `path`, and point the provider's base URL at it.
pub async fn start(env_var: &str, path: &str, replies: Vec<Value>) -> Mock {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut m = Mock { replies: Arc::new(Mutex::new(replies.into())), ..Default::default() };
    m.base = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().route(path, post(reply)).with_state(m.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    std::env::set_var(env_var, &m.base);
    m
}

/// Run one turn; answer approvals with `approve` (None drops the reply).
pub async fn run_turn(agent: &mut Agent, text: &str, cancel: CancellationToken, approve: Option<bool>) -> Vec<ThreadEvent> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let collect = tokio::spawn(async move {
        let mut events = Vec::new();
        while let Some(o) = rx.recv().await {
            match o {
                AgentOut::Event(e) => events.push(e),
                AgentOut::Approval { tool, reply, .. } => {
                    events.push(ThreadEvent::ApprovalRequest { id: "test".into(), tool, input: Value::Null });
                    match approve {
                        Some(a) => {
                            let _ = reply.send(a);
                        }
                        None => drop(reply),
                    }
                }
            }
        }
        events
    });
    agent.turn(text, tx, cancel).await.unwrap();
    collect.await.unwrap()
}

/// Compact, comparable form of an event sequence.
pub fn kinds(events: &[ThreadEvent]) -> Vec<String> {
    events
        .iter()
        .map(|e| match e {
            ThreadEvent::Status { status } => format!("status:{status:?}"),
            ThreadEvent::AssistantText { text } => format!("text:{text}"),
            ThreadEvent::ToolUse { name, .. } => format!("tool_use:{name}"),
            ThreadEvent::ToolResult { is_error, .. } => format!("tool_result:{}", if *is_error { "error" } else { "ok" }),
            ThreadEvent::TurnComplete { .. } => "turn_complete".into(),
            ThreadEvent::Error { message } => format!("error:{message}"),
            ThreadEvent::ApprovalRequest { tool, .. } => format!("approval:{tool}"),
            other => format!("{other:?}"),
        })
        .collect()
}

pub fn cost(events: &[ThreadEvent]) -> Option<f64> {
    events.iter().find_map(|e| match e {
        ThreadEvent::TurnComplete { cost_usd, .. } => Some(*cost_usd),
        _ => None,
    })?
}

pub fn tool_output(events: &[ThreadEvent]) -> String {
    events
        .iter()
        .find_map(|e| match e {
            ThreadEvent::ToolResult { output, .. } => Some(output.clone()),
            _ => None,
        })
        .unwrap()
}

pub fn chat_tool_call(id: &str, name: &str, args: Value, usage: Value) -> Value {
    serde_json::json!({
        "choices": [{ "index": 0, "finish_reason": "tool_calls", "message": {
            "role": "assistant", "content": null,
            "tool_calls": [{ "id": id, "type": "function", "function": { "name": name, "arguments": args.to_string() } }]
        }}],
        "usage": usage
    })
}

pub fn chat_text(text: &str, usage: Value) -> Value {
    serde_json::json!({
        "choices": [{ "index": 0, "finish_reason": "stop", "message": { "role": "assistant", "content": text } }],
        "usage": usage
    })
}
