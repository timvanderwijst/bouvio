//! Cancelling a turn and dropping an approval, against a mock server.

mod common;

use bouvio_agent::{Agent, AgentConfig, CancellationToken, StaticKeys};
#[cfg(unix)]
use bouvio_protocol::ApprovalLevel;
use bouvio_protocol::ProviderKind;
use common::*;
use serde_json::json;
use std::sync::Arc;
#[cfg(unix)]
use std::time::{Duration, Instant};

#[cfg(unix)]
#[tokio::test]
async fn cancel_stops_a_running_command() {
    let dir = tempfile::tempdir().unwrap();
    let mock = start(
        "BOUVIO_OPENAI_BASE_URL",
        "/chat/completions",
        vec![chat_tool_call("call_1", "bash", json!({"command":"sleep 30"}), json!({"prompt_tokens":10,"completion_tokens":5}))],
    )
    .await;
    let mut cfg = AgentConfig::new(dir.path(), "openai:gpt-4.1", Arc::new(StaticKeys::new().with(ProviderKind::OpenAi, "k")));
    cfg.approval = ApprovalLevel::Free;
    let mut a = Agent::new(cfg);
    let cancel = CancellationToken::new();
    let c = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        c.cancel();
    });
    let t = Instant::now();
    let events = run_turn(&mut a, "sleep", cancel, None).await;
    assert!(t.elapsed() < Duration::from_secs(10));
    assert_eq!(kinds(&events), ["status:Working", "tool_use:Bash", "tool_result:error", "turn_complete", "status:Idle"]);
    assert!(tool_output(&events).starts_with("Cancelled"));
    assert_eq!(mock.requests().len(), 1);
    // History stays valid: the call has its result.
    let saved = a.save();
    let last = saved["messages"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(last["role"], "user");
    assert_eq!(last["parts"][0]["type"], "tool_result");
}

#[tokio::test]
async fn dropped_approval_counts_as_denied() {
    let dir = tempfile::tempdir().unwrap();
    start(
        "BOUVIO_OPENROUTER_BASE_URL",
        "/chat/completions",
        vec![
            chat_tool_call("call_1", "web_fetch", json!({"url":"https://example.com"}), json!({"cost":0.001})),
            chat_text("Fine.", json!({"cost":0.001})),
        ],
    )
    .await;
    let cfg = AgentConfig::new(dir.path(), "openrouter:openai/gpt-4.1", Arc::new(StaticKeys::new().with(ProviderKind::OpenRouter, "k")));
    let mut a = Agent::new(cfg);
    let events = run_turn(&mut a, "fetch", CancellationToken::new(), None).await;
    assert_eq!(
        kinds(&events),
        [
            "status:Working",
            "tool_use:WebFetch",
            "status:Blocked",
            "approval:WebFetch",
            "status:Working",
            "tool_result:error",
            "text:Fine.",
            "turn_complete",
            "status:Idle"
        ]
    );
    assert!(tool_output(&events).starts_with("Denied by the user"));
}
