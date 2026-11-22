//! The agent against mock provider servers: tool call, then a final answer.
//! Each test uses a different provider, so their base-URL env vars don't clash.

mod common;

use cuna_agent::{Agent, AgentConfig, CancellationToken, StaticKeys};
use cuna_protocol::{ApprovalLevel, ProviderKind, ThreadEvent};
use common::*;
use serde_json::json;
use std::sync::Arc;

fn agent(dir: &std::path::Path, model: &str, keys: StaticKeys, approval: ApprovalLevel) -> Agent {
    let mut cfg = AgentConfig::new(dir, model, Arc::new(keys));
    cfg.approval = approval;
    cfg.instructions = Some("Be brief.".into());
    Agent::new(cfg)
}

#[tokio::test]
async fn openai_tool_call_then_answer() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("hello.txt"), "hi there\n").unwrap();
    let mock = start(
        "CUNA_OPENAI_BASE_URL",
        "/chat/completions",
        vec![
            chat_tool_call("call_1", "read_file", json!({"file_path":"hello.txt"}), json!({"prompt_tokens":1000,"completion_tokens":50})),
            chat_text("The file says hi there.", json!({"prompt_tokens":1200,"completion_tokens":10})),
        ],
    )
    .await;
    let keys = StaticKeys::new().with(ProviderKind::OpenAi, "test-key");
    let mut a = agent(dir.path(), "openai:gpt-4.1", keys, ApprovalLevel::AskRisky);
    let events = run_turn(&mut a, "What does hello.txt say?", CancellationToken::new(), Some(false)).await;

    assert_eq!(
        kinds(&events),
        [
            "status:Working",
            "tool_use:Read",
            "tool_result:ok",
            "text:The file says hi there.",
            "turn_complete",
            "status:Idle"
        ]
    );
    assert!(matches!(&events[1], ThreadEvent::ToolUse { id, input, .. } if id == "call_1" && input["file_path"] == "hello.txt"));
    assert_eq!(tool_output(&events), "     1\thi there\n");
    // gpt-4.1: $2 in / $8 out per million.
    let want = (2200.0 * 2.0 + 60.0 * 8.0) / 1e6;
    assert!((cost(&events).unwrap() - want).abs() < 1e-12);

    let reqs = mock.requests();
    assert_eq!(reqs.len(), 2);
    assert_eq!(reqs[0].0["authorization"], "Bearer test-key");
    let first = &reqs[0].1;
    assert_eq!(first["model"], "gpt-4.1");
    assert_eq!(first["tools"].as_array().unwrap().len(), 8);
    let system = first["messages"][0]["content"].as_str().unwrap();
    assert!(system.contains("Working directory:") && system.ends_with("Be brief."));
    assert_eq!(first["messages"][1], json!({"role":"user","content":"What does hello.txt say?"}));
    let second = reqs[1].1["messages"].as_array().unwrap();
    assert_eq!(second[2]["tool_calls"][0]["id"], "call_1");
    assert_eq!(second[3], json!({"role":"tool","tool_call_id":"call_1","content":"     1\thi there\n"}));

    // The saved history resumes and the next turn sends all of it.
    let saved = a.save();
    assert_eq!(saved["messages"].as_array().unwrap().len(), 4);
}

#[tokio::test]
async fn openrouter_risky_tool_denied() {
    let dir = tempfile::tempdir().unwrap();
    let mock = start(
        "CUNA_OPENROUTER_BASE_URL",
        "/chat/completions",
        vec![
            chat_tool_call("call_9", "bash", json!({"command":"echo ran > ran.txt"}), json!({"prompt_tokens":10,"completion_tokens":5,"cost":0.01})),
            chat_text("Okay, I won't.", json!({"prompt_tokens":20,"completion_tokens":5,"cost":0.02})),
        ],
    )
    .await;
    let keys = StaticKeys::new().with(ProviderKind::OpenRouter, "or-key");
    let mut a = agent(dir.path(), "openrouter:anthropic/claude-sonnet-4.5", keys, ApprovalLevel::AskRisky);
    let events = run_turn(&mut a, "Make ran.txt", CancellationToken::new(), Some(false)).await;
    assert_eq!(
        kinds(&events),
        [
            "status:Working",
            "tool_use:Bash",
            "status:Blocked",
            "approval:Bash",
            "status:Working",
            "tool_result:error",
            "text:Okay, I won't.",
            "turn_complete",
            "status:Idle"
        ]
    );
    assert!(tool_output(&events).starts_with("Denied by the user"));
    assert!(!dir.path().join("ran.txt").exists());
    assert!((cost(&events).unwrap() - 0.03).abs() < 1e-12);
    let reqs = mock.requests();
    assert_eq!(reqs[0].1["usage"], json!({"include": true}));
    assert_eq!(reqs[0].0["x-title"], "Cuna");
    assert!(reqs[1].1["messages"][3]["content"].as_str().unwrap().starts_with("Denied by the user"));
}

#[tokio::test]
async fn google_risky_tool_allowed() {
    let dir = tempfile::tempdir().unwrap();
    start(
        "CUNA_GOOGLE_BASE_URL",
        "/chat/completions",
        vec![
            // Gemini may send an empty id; the agent makes one up.
            chat_tool_call("", "bash", json!({"command":"echo hello"}), json!({"prompt_tokens":100,"completion_tokens":10})),
            chat_text("It printed hello.", json!({"prompt_tokens":200,"completion_tokens":10})),
        ],
    )
    .await;
    let keys = StaticKeys::new().with(ProviderKind::Google, "g-key");
    let mut a = agent(dir.path(), "google:gemini-2.5-flash", keys, ApprovalLevel::AskRisky);
    let events = run_turn(&mut a, "Say hello", CancellationToken::new(), Some(true)).await;
    assert_eq!(
        kinds(&events),
        [
            "status:Working",
            "tool_use:Bash",
            "status:Blocked",
            "approval:Bash",
            "status:Working",
            "tool_result:ok",
            "text:It printed hello.",
            "turn_complete",
            "status:Idle"
        ]
    );
    assert!(tool_output(&events).contains("hello"));
    assert!(matches!(&events[1], ThreadEvent::ToolUse { id, .. } if id.starts_with("call_")));
    let want = (300.0 * 0.30 + 20.0 * 2.50) / 1e6;
    assert!((cost(&events).unwrap() - want).abs() < 1e-12);
}

#[tokio::test]
async fn anthropic_messages_flow() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "old value\n").unwrap();
    let mock = start(
        "CUNA_ANTHROPIC_BASE_URL",
        "/messages",
        vec![
            json!({
                "type": "message", "role": "assistant", "model": "claude-sonnet-4-5",
                "content": [
                    { "type": "text", "text": "Editing." },
                    { "type": "tool_use", "id": "toolu_1", "name": "edit_file",
                      "input": { "file_path": "a.txt", "old_string": "old", "new_string": "new" } }
                ],
                "stop_reason": "tool_use",
                "usage": { "input_tokens": 1000, "output_tokens": 100 }
            }),
            json!({
                "type": "message", "role": "assistant", "model": "claude-sonnet-4-5",
                "content": [{ "type": "text", "text": "Done." }],
                "stop_reason": "end_turn",
                "usage": { "input_tokens": 50, "output_tokens": 10, "cache_read_input_tokens": 1000 }
            }),
        ],
    )
    .await;
    let keys = StaticKeys::new().with(ProviderKind::Anthropic, "sk-ant-test");
    // AskAll asks even for a file edit inside the project.
    let mut a = agent(dir.path(), "anthropic:claude-sonnet-4-5", keys, ApprovalLevel::AskAll);
    let events = run_turn(&mut a, "Change old to new", CancellationToken::new(), Some(true)).await;
    assert_eq!(
        kinds(&events),
        [
            "status:Working",
            "text:Editing.",
            "tool_use:Edit",
            "status:Blocked",
            "approval:Edit",
            "status:Working",
            "tool_result:ok",
            "text:Done.",
            "turn_complete",
            "status:Idle"
        ]
    );
    assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "new value\n");
    let want = (1000.0 * 3.0 + 100.0 * 15.0 + 50.0 * 3.0 + 1000.0 * 0.3 + 10.0 * 15.0) / 1e6;
    assert!((cost(&events).unwrap() - want).abs() < 1e-12);
    let reqs = mock.requests();
    assert_eq!(reqs[0].0["x-api-key"], "sk-ant-test");
    assert_eq!(reqs[0].0["anthropic-version"], "2023-06-01");
    let msgs = reqs[1].1["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 3);
    assert_eq!(msgs[1]["content"][1]["type"], "tool_use");
    assert_eq!(msgs[2]["content"][0]["type"], "tool_result");
    assert_eq!(msgs[2]["content"][0]["tool_use_id"], "toolu_1");
    assert_eq!(msgs[2]["content"][0]["is_error"], false);
}
