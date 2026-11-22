//! A local control socket, so helpers the runner starts (the MCP server inside
//! Claude Code) can talk back to it: ask for approval, spawn threads.
//!
//! Line-delimited JSON on 127.0.0.1, guarded by a random token per runner.

use crate::Runner;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use uuid::Uuid;

#[derive(Clone)]
pub struct ControlAddr {
    pub port: u16,
    pub token: String,
}

pub async fn serve(runner: Arc<Runner>) -> Result<ControlAddr> {
    let listener = TcpListener::bind("127.0.0.1:0").await.context("bind control socket")?;
    let port = listener.local_addr()?.port();
    let token = Uuid::new_v4().simple().to_string();
    let addr = ControlAddr { port, token: token.clone() };
    tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            let r = runner.clone();
            let t = token.clone();
            tokio::spawn(async move {
                if let Err(e) = handle(r, sock, &t).await {
                    tracing::debug!("control: {e:#}");
                }
            });
        }
    });
    Ok(addr)
}

async fn handle(runner: Arc<Runner>, sock: TcpStream, token: &str) -> Result<()> {
    let (rd, mut wr) = sock.into_split();
    let mut lines = BufReader::new(rd).lines();
    while let Some(line) = lines.next_line().await? {
        let req: Value = serde_json::from_str(&line)?;
        let reply = if req["token"] != token {
            json!({ "err": "bad token" })
        } else {
            let thread: Uuid = serde_json::from_value(req["thread_id"].clone()).unwrap_or_default();
            match runner.control_call(thread, req["method"].as_str().unwrap_or(""), req["params"].clone()).await {
                Ok(v) => json!({ "ok": v }),
                Err(e) => json!({ "err": format!("{e:#}") }),
            }
        };
        wr.write_all(format!("{reply}\n").as_bytes()).await?;
    }
    Ok(())
}

/// Client side, used by the MCP helper process.
pub async fn call(port: u16, token: &str, thread_id: &str, method: &str, params: Value) -> Result<Value> {
    let sock = TcpStream::connect(("127.0.0.1", port)).await.context("connect to Cuna runner")?;
    let (rd, mut wr) = sock.into_split();
    let req = json!({ "token": token, "thread_id": thread_id, "method": method, "params": params });
    wr.write_all(format!("{req}\n").as_bytes()).await?;
    let mut lines = BufReader::new(rd).lines();
    let line = lines.next_line().await?.context("runner closed the connection")?;
    let v: Value = serde_json::from_str(&line)?;
    if let Some(e) = v["err"].as_str() {
        anyhow::bail!("{e}");
    }
    Ok(v["ok"].clone())
}
