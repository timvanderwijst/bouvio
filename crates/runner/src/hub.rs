//! Connection to a Bouvio hub over WebSocket.
//!
//! One connection does two jobs: it *hosts* this runner's shared workspaces
//! (answers members' RPCs, publishes events) and it lets this app *join*
//! workspaces others host (sends RPCs, receives their events).

use crate::{terminal::TerminalOut, Runner};
use anyhow::{Context, Result};
use bouvio_protocol::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

pub struct HubClient {
    out: mpsc::UnboundedSender<ClientMsg>,
    pending: Pending,
    next: AtomicU64,
    /// Everything the hub sends that is not an RPC answer: events, chat, presence.
    pub inbound: broadcast::Sender<ServerMsg>,
    pub connected: Arc<std::sync::atomic::AtomicBool>,
    /// Shared workspaces this runner hosts.
    hosted: Arc<Mutex<HashSet<Uuid>>>,
    pub user: Arc<Mutex<Option<HubUser>>>,
    /// Hub base URL and token, for the few REST calls the runner makes itself.
    base: String,
    token: String,
}

impl HubClient {
    /// Connect and keep reconnecting with backoff until dropped.
    pub fn connect(runner: Arc<Runner>, url: String, token: String) -> Arc<Self> {
        let (out, rx) = mpsc::unbounded_channel();
        let (inbound, _) = broadcast::channel(1024);
        let me = Arc::new(Self {
            out,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: AtomicU64::new(1),
            inbound,
            connected: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            hosted: Arc::new(Mutex::new(HashSet::new())),
            user: Arc::new(Mutex::new(None)),
            base: url.trim_end_matches('/').to_string(),
            token: token.clone(),
        });
        me.refresh_hosted(&runner);
        tokio::spawn(run(me.clone(), runner.clone(), url, token, rx));
        tokio::spawn(publish_loop(me.clone(), runner));
        me
    }

    /// Re-announce which workspaces this runner hosts (after sharing one).
    pub fn refresh_hosted(&self, runner: &Runner) {
        let ids: Vec<Uuid> = runner.workspaces().into_iter().filter(|w| w.kind == WorkspaceKind::Shared && w.role.is_none()).map(|w| w.id).collect();
        *self.hosted.lock().unwrap() = ids.iter().copied().collect();
        let _ = self.out.send(ClientMsg::Host { workspace_ids: ids });
    }

    pub async fn rpc(&self, workspace_id: Uuid, method: &str, params: Value) -> Result<Value> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.out.send(ClientMsg::Rpc { id, workspace_id, method: method.into(), params }).context("hub connection closed")?;
        match tokio::time::timeout(Duration::from_secs(90), rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => anyhow::bail!(e),
            _ => {
                self.pending.lock().unwrap().remove(&id);
                anyhow::bail!("the hub did not answer")
            }
        }
    }

    pub fn send(&self, msg: ClientMsg) {
        let _ = self.out.send(msg);
    }

    pub(crate) fn hosts(&self, ws: Uuid) -> bool {
        self.hosted.lock().unwrap().contains(&ws)
    }

    /// The signed-in hub user of this connection, once the hub welcomed it.
    pub fn me(&self) -> Option<HubUser> {
        self.user.lock().unwrap().clone()
    }

    /// Members of a shared workspace with their roles (`GET /workspaces/:id/members`).
    pub async fn members(&self, workspace_id: Uuid) -> Result<Vec<Member>> {
        let url = format!("{}/workspaces/{workspace_id}/members", self.base);
        let res = reqwest::Client::new()
            .get(url)
            .bearer_auth(&self.token)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .context("reaching the hub")?;
        if !res.status().is_success() {
            anyhow::bail!("the hub answered {}", res.status());
        }
        Ok(res.json().await?)
    }
}

fn ws_url(base: &str, token: &str) -> String {
    let b = base.trim_end_matches('/');
    let b = b.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1);
    format!("{b}/ws?token={token}")
}

async fn run(me: Arc<HubClient>, runner: Arc<Runner>, url: String, token: String, mut rx: mpsc::UnboundedReceiver<ClientMsg>) {
    let mut backoff = 1u64;
    loop {
        match tokio_tungstenite::connect_async(ws_url(&url, &token)).await {
            Ok((ws, _)) => {
                backoff = 1;
                me.connected.store(true, Ordering::SeqCst);
                let (mut sink, mut stream) = ws.split();
                // Announce hosted workspaces on every (re)connect.
                let ids: Vec<Uuid> = me.hosted.lock().unwrap().iter().copied().collect();
                let _ = sink.send(Message::text(serde_json::to_string(&ClientMsg::Host { workspace_ids: ids }).unwrap())).await;
                loop {
                    tokio::select! {
                        msg = rx.recv() => {
                            let Some(msg) = msg else { return };
                            if sink.send(Message::text(serde_json::to_string(&msg).unwrap())).await.is_err() { break }
                        }
                        frame = stream.next() => {
                            let Some(Ok(frame)) = frame else { break };
                            let Message::Text(text) = frame else { continue };
                            let Ok(msg) = serde_json::from_str::<ServerMsg>(&text) else { continue };
                            handle(&me, &runner, msg).await;
                        }
                    }
                }
                me.connected.store(false, Ordering::SeqCst);
                // Answer everyone still waiting.
                for (_, tx) in me.pending.lock().unwrap().drain() {
                    let _ = tx.send(Err("lost the connection to the hub".into()));
                }
            }
            Err(e) => tracing::info!("hub: {e}"),
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30);
    }
}

async fn handle(me: &Arc<HubClient>, runner: &Arc<Runner>, msg: ServerMsg) {
    match msg {
        ServerMsg::Welcome { user } => {
            *me.user.lock().unwrap() = Some(user.clone());
            let _ = me.inbound.send(ServerMsg::Welcome { user });
        }
        ServerMsg::RpcResult { id, ok, err } => {
            if let Some(tx) = me.pending.lock().unwrap().remove(&id) {
                let _ = tx.send(match err {
                    Some(e) => Err(e),
                    None => Ok(ok.unwrap_or(Value::Null)),
                });
            }
        }
        ServerMsg::Chat { message } => {
            // `@Lead do this` in a workspace this runner hosts starts a thread.
            if message.parent.is_none() && me.hosts(message.workspace_id) {
                crate::ext::comms::on_chat(runner, me, &message);
            }
            let _ = me.inbound.send(ServerMsg::Chat { message });
        }
        ServerMsg::Rpc { id, workspace_id, method, params, from, role: _ } => {
            // A member asks this runner to do something in a workspace it hosts.
            let me = me.clone();
            let runner = runner.clone();
            tokio::spawn(async move {
                let r = if me.hosts(workspace_id) {
                    runner.call_scoped(workspace_id, &method, params, &from.name).await
                } else {
                    Err(anyhow::anyhow!("this runner does not host that workspace"))
                };
                let msg = match r {
                    Ok(v) => ClientMsg::RpcResult { id, ok: Some(v), err: None },
                    Err(e) => ClientMsg::RpcResult { id, ok: None, err: Some(format!("{e:#}")) },
                };
                me.send(msg);
            });
        }
        other => {
            let _ = me.inbound.send(other);
        }
    }
}

/// Publish what happens in hosted workspaces to their members.
async fn publish_loop(me: Arc<HubClient>, runner: Arc<Runner>) {
    let mut ev = runner.subscribe_events();
    let mut th = runner.subscribe_threads();
    let mut no = runner.subscribe_notices();
    let mut te = runner.terminals.subscribe();
    let ws_of_thread = |id: Uuid| runner.thread(id).map(|t| t.workspace_id);
    loop {
        let (ws, kind, payload) = tokio::select! {
            Ok(e) = ev.recv() => match ws_of_thread(e.thread_id) { Some(w) => (w, "thread-event", serde_json::to_value(&e).unwrap()), None => continue },
            Ok(t) = th.recv() => (t.workspace_id, "thread-changed", serde_json::to_value(&t).unwrap()),
            Ok(n) = no.recv() => (n.workspace_id, "notice", serde_json::to_value(&n).unwrap()),
            Ok(o) = te.recv() => {
                // Terminals are published to every hosted workspace's members only when
                // they were opened for one of its threads.
                let (id, kind, payload) = match o {
                    TerminalOut::Chunk(c) => (c.terminal_id, "terminal-chunk", serde_json::to_value(&c).unwrap()),
                    TerminalOut::Exit(x) => (x.terminal_id, "terminal-exit", serde_json::to_value(&x).unwrap()),
                };
                match runner.terminals.workspace_of(id) { Some(w) => (w, kind, payload), None => continue }
            }
            else => return,
        };
        if me.hosts(ws) {
            me.send(ClientMsg::Publish { workspace_id: ws, kind: kind.into(), payload });
        }
    }
}
