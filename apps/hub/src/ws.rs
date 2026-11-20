//! `GET /ws?token=…`: one socket per desktop app or runner.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
/// Runner methods and notices that reveal what the host's keys spend.
const COST_METHODS: &[&str] = &["cost_summary", "list_budgets"];
const COST_NOTICES: &[&str] = &["personal-budgets", "personal-eval"];

use bouvio_protocol::{required_role, ChatMessage, ClientMsg, HubUser, Presence, Role, ServerMsg};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::auth::authenticate;
use crate::db::{self, role_str};

use crate::chat;
use crate::error::ApiResult;
use crate::hub::{rpc_err, ConnId, Except, Hub, Reply};
use crate::AppState;

/// Messages queued per connection before it counts as too slow and is dropped.
const QUEUE: usize = 512;
const PING_EVERY: Duration = Duration::from_secs(25);
const RPC_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_CHAT_LEN: usize = 8000;
/// SDP offers with many codecs run to ~10 KB; leave room.
const MAX_SIGNAL_LEN: usize = 64 * 1024;

#[derive(Deserialize)]
pub struct WsQuery {
    token: String,
}

pub async fn upgrade(
    State(st): State<AppState>,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    let user = authenticate(&st.db, &q.token).await?;
    Ok(ws
        .max_message_size(16 << 20)
        .on_upgrade(move |socket| run(socket, st, user)))
}

async fn run(socket: WebSocket, st: AppState, user: HubUser) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Message>(QUEUE);
    let (conn, kick) = st.hub.register(user.clone(), tx);
    tracing::debug!(conn, user = %user.email, "connected");
    st.hub
        .send(conn, &ServerMsg::Welcome { user: user.clone() });

    let writer = tokio::spawn(async move {
        let mut ping =
            tokio::time::interval_at(tokio::time::Instant::now() + PING_EVERY, PING_EVERY);
        loop {
            let msg = tokio::select! {
                m = rx.recv() => match m { Some(m) => m, None => break },
                _ = ping.tick() => Message::Ping(Default::default()),
            };
            if sink.send(msg).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let ctx = Ctx {
        st: &st,
        conn,
        user: &user,
    };
    loop {
        tokio::select! {
            _ = kick.notified() => break,
            m = stream.next() => match m {
                Some(Ok(Message::Text(text))) => match serde_json::from_str::<ClientMsg>(&text) {
                    Ok(msg) => ctx.handle(msg).await,
                    Err(e) => ctx.error(format!("bad message: {e}")),
                },
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
        }
    }

    st.hub.disconnect(conn).await;
    // The hub dropped its sender, so the writer drains its queue and stops.
    let abort = writer.abort_handle();
    if tokio::time::timeout(Duration::from_secs(5), writer)
        .await
        .is_err()
    {
        abort.abort();
    }
    tracing::debug!(conn, user = %user.email, "disconnected");
}

struct Ctx<'a> {
    st: &'a AppState,
    conn: ConnId,
    user: &'a HubUser,
}

impl Ctx<'_> {
    fn hub(&self) -> &Arc<Hub> {
        &self.st.hub
    }

    fn error(&self, message: impl Into<String>) {
        self.hub().send(
            self.conn,
            &ServerMsg::Error {
                message: message.into(),
            },
        );
    }

    async fn role(&self, ws: Uuid) -> Option<Role> {
        self.hub().role(ws, self.user.id).await
    }

    async fn handle(&self, msg: ClientMsg) {
        match msg {
            ClientMsg::Host { workspace_ids } => self.host(workspace_ids).await,
            ClientMsg::Rpc {
                id,
                workspace_id,
                method,
                params,
            } => self.rpc(id, workspace_id, method, params).await,
            ClientMsg::RpcResult { id, ok, err } => {
                if let Some(reply) = self.hub().finish_rpc(id, Some(self.conn)) {
                    self.hub().answer(reply, ok, err);
                }
            }
            ClientMsg::Publish {
                workspace_id,
                kind,
                payload,
            } => {
                if self.hub().host_of(workspace_id) != Some(self.conn) {
                    return self.error(format!(
                        "only the connection hosting {workspace_id} may publish to it"
                    ));
                }
                let costly = kind == "notice" && payload["kind"].as_str().is_some_and(|k| COST_NOTICES.contains(&k));
                let msg = ServerMsg::Event {
                    workspace_id,
                    kind,
                    payload,
                };
                if costly {
                    // Spend reaches only the people allowed to see it.
                    if let Ok(members) = db::members(&self.st.db, workspace_id).await {
                        for m in members.iter().filter(|m| m.role >= Role::Admin || m.see_costs) {
                            self.hub().send_user(m.user.id, &msg, Some(self.conn));
                        }
                    }
                } else {
                    self.hub()
                        .broadcast(workspace_id, &msg, Except::Conn(self.conn))
                        .await;
                }
            }
            ClientMsg::Chat {
                workspace_id,
                channel,
                text,
            } => self.chat(workspace_id, channel, text).await,
            ClientMsg::Presence {
                workspace_id,
                viewing,
                cursor,
            } => {
                if self.role(workspace_id).await.is_none() {
                    return self.error(format!("not a member of {workspace_id}"));
                }
                self.hub().add_presence(self.conn, workspace_id);
                let presence = Presence {
                    workspace_id,
                    user: self.user.clone(),
                    viewing,
                    cursor,
                };
                let msg = ServerMsg::Presence {
                    presence,
                    online: true,
                };
                self.hub()
                    .broadcast(workspace_id, &msg, Except::User(self.user.id))
                    .await;
            }
            ClientMsg::ChatReply {
                workspace_id,
                parent,
                text,
            } => self.chat_reply(workspace_id, parent, text).await,
            ClientMsg::React {
                workspace_id,
                message_id,
                emoji,
            } => self.react(workspace_id, message_id, emoji).await,
            ClientMsg::Pin {
                workspace_id,
                message_id,
                pinned,
            } => self.pin(workspace_id, message_id, pinned).await,
            ClientMsg::Signal {
                workspace_id,
                to,
                kind,
                payload,
            } => self.signal(workspace_id, to, kind, payload).await,
        }
    }

    async fn host(&self, workspace_ids: Vec<Uuid>) {
        for ws in workspace_ids {
            match db::workspace(&self.st.db, ws).await {
                Ok(Some(row)) if row.host.id == self.user.id => {
                    self.hub().set_host(ws, self.conn);
                    let msg = ServerMsg::HostStatus {
                        workspace_id: ws,
                        online: true,
                    };
                    self.hub().broadcast(ws, &msg, Except::Nobody).await;
                }
                Ok(_) => self.error(format!("you do not host workspace {ws}")),
                Err(e) => {
                    tracing::error!("host {ws}: {e}");
                    self.error("database error");
                }
            }
        }
    }

    async fn sees_costs(&self, ws: Uuid) -> bool {
        db::members(&self.st.db, ws)
            .await
            .map(|m| m.iter().any(|m| m.user.id == self.user.id && m.see_costs))
            .unwrap_or(false)
    }

    async fn rpc(&self, id: u64, ws: Uuid, method: String, params: serde_json::Value) {
        let hub = self.hub();
        let Some(role) = self.role(ws).await else {
            return hub.send(self.conn, &rpc_err(id, "not a member of this workspace"));
        };
        let needed = required_role(&method);
        if role < needed {
            let err = format!(
                "forbidden: {method} needs role {}, you are {}",
                role_str(needed),
                role_str(role)
            );
            return hub.send(self.conn, &rpc_err(id, err));
        }
        // What the host's keys cost is visible only to admins and to members given `see_costs`.
        if COST_METHODS.contains(&method.as_str()) && role < Role::Admin && !self.sees_costs(ws).await {
            return hub.send(self.conn, &rpc_err(id, "forbidden: costs are not shared with you"));
        }
        let Some(host) = hub.host_of(ws) else {
            return hub.send(self.conn, &rpc_err(id, "host offline"));
        };
        let hub_id = hub.start_rpc(
            Reply::Conn {
                asker: self.conn,
                asker_id: id,
            },
            host,
        );
        let msg = ServerMsg::Rpc {
            id: hub_id,
            workspace_id: ws,
            method,
            params,
            from: self.user.clone(),
            role,
        };
        hub.send(host, &msg);

        let hub = hub.clone();
        tokio::spawn(async move {
            tokio::time::sleep(RPC_TIMEOUT).await;
            if let Some(reply) = hub.finish_rpc(hub_id, None) {
                hub.answer(
                    reply,
                    None,
                    Some("timeout: the host did not answer within 60 s".into()),
                );
            }
        });
    }

    async fn chat(&self, ws: Uuid, channel: String, text: String) {
        match self.role(ws).await {
            None => return self.error(format!("not a member of {ws}")),
            Some(r) if r < Role::Commenter => return self.error("chat needs role commenter"),
            Some(_) => {}
        }
        let channel = channel.trim();
        let text = text.trim();
        if channel.is_empty() || channel.len() > 64 || text.is_empty() || text.len() > MAX_CHAT_LEN
        {
            return self.error("chat needs a channel (max 64 chars) and text (max 8000 chars)");
        }
        let message = ChatMessage {
            id: Uuid::new_v4(),
            workspace_id: ws,
            channel: channel.to_string(),
            author: self.user.clone(),
            text: text.to_string(),
            at: Utc::now(),
            parent: None,
            reactions: vec![],
            pinned: false,
        };
        if let Err(e) = chat::insert(&self.st.db, &message).await {
            tracing::error!("chat insert: {e}");
            return self.error("could not save the message");
        }
        self.hub()
            .broadcast(ws, &ServerMsg::Chat { message }, Except::Nobody)
            .await;
    }

    /// Checks membership and a minimum role; on failure tells the sender and returns None.
    async fn allowed(&self, ws: Uuid, min: Role, what: &str) -> Option<Role> {
        match self.role(ws).await {
            None => {
                self.error(format!("not a member of {ws}"));
                None
            }
            Some(r) if r < min => {
                self.error(format!("{what} needs role {}", role_str(min)));
                None
            }
            Some(r) => Some(r),
        }
    }

    async fn chat_reply(&self, ws: Uuid, parent: Uuid, text: String) {
        if self
            .allowed(ws, Role::Commenter, "replying")
            .await
            .is_none()
        {
            return;
        }
        let text = text.trim();
        if text.is_empty() || text.len() > MAX_CHAT_LEN {
            return self.error("a reply needs text (max 8000 chars)");
        }
        let root = match chat::message(&self.st.db, ws, parent).await {
            Ok(Some(m)) => m,
            Ok(None) => return self.error("that message does not exist"),
            Err(e) => {
                tracing::error!("chat reply: {e}");
                return self.error("database error");
            }
        };
        // Threads are one level deep: a reply to a reply goes under the same root.
        let root_id = root.parent.unwrap_or(root.id);
        let message = ChatMessage {
            id: Uuid::new_v4(),
            workspace_id: ws,
            channel: root.channel,
            author: self.user.clone(),
            text: text.to_string(),
            at: Utc::now(),
            parent: Some(root_id),
            reactions: vec![],
            pinned: false,
        };
        if let Err(e) = chat::insert(&self.st.db, &message).await {
            tracing::error!("chat reply insert: {e}");
            return self.error("could not save the reply");
        }
        self.hub()
            .broadcast(ws, &ServerMsg::Chat { message }, Except::Nobody)
            .await;
    }

    async fn react(&self, ws: Uuid, id: Uuid, emoji: String) {
        if self
            .allowed(ws, Role::Commenter, "reacting")
            .await
            .is_none()
        {
            return;
        }
        let emoji = emoji.trim();
        if emoji.is_empty() || emoji.len() > 32 || emoji.chars().any(char::is_whitespace) {
            return self.error("a reaction is one emoji or a short :name:");
        }
        let result = async {
            if chat::message(&self.st.db, ws, id).await?.is_none() {
                return Ok(None);
            }
            if !chat::toggle_reaction(&self.st.db, id, self.user.id, emoji).await? {
                return Ok(Some(None));
            }
            Ok::<_, sqlx::Error>(Some(chat::message(&self.st.db, ws, id).await?))
        }
        .await;
        match result {
            Ok(Some(Some(message))) => {
                self.hub()
                    .broadcast(ws, &ServerMsg::ChatUpdated { message }, Except::Nobody)
                    .await
            }
            Ok(Some(None)) => {
                self.error("this message has as many different reactions as it can take")
            }
            Ok(None) => self.error("that message does not exist"),
            Err(e) => {
                tracing::error!("react: {e}");
                self.error("database error")
            }
        }
    }

    async fn pin(&self, ws: Uuid, id: Uuid, pinned: bool) {
        if self.allowed(ws, Role::Operator, "pinning").await.is_none() {
            return;
        }
        let result = async {
            if chat::message(&self.st.db, ws, id).await?.is_none() {
                return Ok(None);
            }
            chat::set_pinned(&self.st.db, id, pinned).await?;
            chat::message(&self.st.db, ws, id).await
        }
        .await;
        match result {
            Ok(Some(message)) => {
                self.hub()
                    .broadcast(ws, &ServerMsg::ChatUpdated { message }, Except::Nobody)
                    .await
            }
            Ok(None) => self.error("that message does not exist"),
            Err(e) => {
                tracing::error!("pin: {e}");
                self.error("database error")
            }
        }
    }

    /// Huddle signalling: relayed to one member's connections, or to every member
    /// but this connection. `join` and `leave` without a target also update who is
    /// in the workspace's huddle.
    async fn signal(&self, ws: Uuid, to: Option<Uuid>, kind: String, payload: serde_json::Value) {
        if let Err(first) = self.hub().take_signal(self.conn) {
            if first {
                self.error("too many signals; slow down");
            }
            return;
        }
        if self
            .allowed(ws, Role::Commenter, "a huddle")
            .await
            .is_none()
        {
            return;
        }
        if kind.is_empty() || kind.len() > 32 {
            return self.error("a signal needs a kind (max 32 chars)");
        }
        if payload.to_string().len() > MAX_SIGNAL_LEN {
            return self.error("signal payload too large");
        }
        // Each tab is its own peer: tell the others which connection this is.
        let mut payload = payload;
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("conn".into(), self.conn.into());
        }
        let msg = ServerMsg::Signal {
            workspace_id: ws,
            from: self.user.clone(),
            kind: kind.clone(),
            payload,
        };
        match to {
            Some(user) => {
                if self.hub().role(ws, user).await.is_none() {
                    return self.error("that person is not a member of this workspace");
                }
                self.hub().send_user(user, &msg, Some(self.conn));
            }
            None => {
                match kind.as_str() {
                    "join" => self.hub().huddle_join(ws, self.conn, self.user.clone()),
                    "leave" => self.hub().huddle_leave(ws, self.conn),
                    _ => {}
                }
                self.hub()
                    .broadcast(ws, &msg, Except::Conn(self.conn))
                    .await;
            }
        }
    }
}
