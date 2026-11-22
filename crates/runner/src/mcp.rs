//! A minimal MCP server (stdio, JSON-RPC 2.0) that Claude Code loads as
//! `bouvio`. It gives agents fleet tools and routes permission prompts to the
//! people in the thread.
//!
//! Started by the runner as `<own exe> mcp` with BOUVIO_CONTROL, BOUVIO_TOKEN
//! and BOUVIO_THREAD in the environment.

use crate::control;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub fn tools() -> Value {
    json!([
        {
            "name": "approve",
            "description": "Bouvio permission prompt: asks the people in this thread whether a tool call may run.",
            "inputSchema": { "type": "object", "properties": {
                "tool_name": { "type": "string" }, "input": { "type": "object" }, "tool_use_id": { "type": "string" }
            }, "required": ["tool_name", "input"] }
        },
        {
            "name": "spawn_thread",
            "description": "Start a new thread for a separate piece of work. It runs in parallel, in its own git worktree, under the same lead. Use this to split a task into independent parts. Returns the new thread id.",
            "inputSchema": { "type": "object", "properties": {
                "title": { "type": "string", "description": "Short title, like an issue title" },
                "prompt": { "type": "string", "description": "Complete instructions; the new thread has no other context" },
                "isolate": { "type": "boolean", "description": "Own worktree and branch (default true)" }
            }, "required": ["title", "prompt"] }
        },
        {
            "name": "list_threads",
            "description": "List the threads in this workspace with their status (working, blocked, idle, error) and branch.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "thread_status",
            "description": "Status and latest reply of one thread. Use it to follow up on threads you spawned.",
            "inputSchema": { "type": "object", "properties": { "thread_id": { "type": "string" } }, "required": ["thread_id"] }
        },
        {
            "name": "create_issue",
            "description": "File an issue in the workspace tracker. Returns its key, like BOU-12.",
            "inputSchema": { "type": "object", "properties": {
                "title": { "type": "string" }, "body": { "type": "string" }
            }, "required": ["title"] }
        },
        {
            "name": "remember",
            "description": "Add a fact to the workspace memory, which every agent in this workspace reads. Use for durable decisions and conventions, not for task progress.",
            "inputSchema": { "type": "object", "properties": { "fact": { "type": "string" } }, "required": ["fact"] }
        }
    ])
}

pub async fn serve_stdio() -> Result<()> {
    let port: u16 = std::env::var("BOUVIO_CONTROL").context("BOUVIO_CONTROL")?.parse()?;
    let token = std::env::var("BOUVIO_TOKEN").context("BOUVIO_TOKEN")?;
    let thread = std::env::var("BOUVIO_THREAD").context("BOUVIO_THREAD")?;

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = req.get("id").cloned() else { continue }; // notifications need no answer
        let result = match req["method"].as_str().unwrap_or("") {
            "initialize" => Ok(json!({
                "protocolVersion": req["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "bouvio", "version": env!("CARGO_PKG_VERSION") }
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tools() })),
            "tools/call" => {
                let name = req["params"]["name"].as_str().unwrap_or("");
                let args = req["params"]["arguments"].clone();
                Ok(match control::call(port, &token, &thread, name, args).await {
                    Ok(v) => {
                        let text = if let Some(s) = v.as_str() { s.to_string() } else { v.to_string() };
                        json!({ "content": [{ "type": "text", "text": text }] })
                    }
                    Err(e) => json!({ "content": [{ "type": "text", "text": format!("{e:#}") }], "isError": true }),
                })
            }
            m => Err(json!({ "code": -32601, "message": format!("unknown method {m}") })),
        };
        let resp = match result {
            Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
            Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
        };
        out.write_all(format!("{resp}\n").as_bytes()).await?;
        out.flush().await?;
    }
    Ok(())
}
