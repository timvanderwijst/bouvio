//! Live state: who is connected, which connection hosts which workspace, and
//! RPCs in flight. Everything here is in memory and rebuilt as clients reconnect.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use std::time::{Duration, Instant};

use axum::extract::ws::{Message, Utf8Bytes};
use cuna_protocol::comms::HuddleState;
use cuna_protocol::{HubUser, Presence, Role, ServerMsg};
use chrono::{DateTime, Utc};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, Notify};
use uuid::Uuid;

use crate::db::{self, Db};

pub type ConnId = u64;

/// Signals a connection may send in a burst, and per second after that.
const SIGNAL_BURST: f64 = 400.0;
const SIGNAL_RATE: f64 = 100.0;

/// Why a hub-internal call to a hosting runner failed.
#[derive(Debug)]
pub enum CallError {
    Offline,
    Timeout,
    Remote(String),
}

struct Conn {
    user: HubUser,
    tx: mpsc::Sender<Message>,
    /// Tells the connection's task to hang up (it fell too far behind).
    kick: Arc<Notify>,
}

/// Where an RPC's answer goes: a member's connection, or a task inside the hub
/// (public forms).
pub enum Reply {
    Conn { asker: ConnId, asker_id: u64 },
    Local(oneshot::Sender<Result<Value, String>>),
}

impl Reply {
    fn asker(&self) -> Option<ConnId> {
        match self {
            Reply::Conn { asker, .. } => Some(*asker),
            Reply::Local(_) => None,
        }
    }
}

struct Pending {
    reply: Reply,
    host: ConnId,
}

/// A workspace's huddle: who joined it, on which connection, and since when.
#[derive(Default)]
struct Huddle {
    since: Option<DateTime<Utc>>,
    conns: Vec<(ConnId, HubUser)>,
}

/// Token bucket for signalling, per connection: WebRTC ICE comes in bursts.
struct Bucket {
    tokens: f64,
    at: Instant,
    warned: bool,
}

#[derive(Default)]
struct Inner {
    conns: HashMap<ConnId, Conn>,
    by_user: HashMap<Uuid, HashSet<ConnId>>,
    hosts: HashMap<Uuid, ConnId>,
    pending: HashMap<u64, Pending>,
    presence: HashMap<ConnId, HashSet<Uuid>>,
    /// workspace -> user -> role, loaded lazily from the database.
    members: HashMap<Uuid, Arc<HashMap<Uuid, Role>>>,
    /// Bumped on every invalidation so a load that raced one is not cached.
    members_gen: u64,
    huddles: HashMap<Uuid, Huddle>,
    signal_budget: HashMap<ConnId, Bucket>,
}

/// Who not to send a broadcast to.
#[derive(Clone, Copy)]
pub enum Except {
    Nobody,
    Conn(ConnId),
    User(Uuid),
}

pub struct Hub {
    db: Db,
    inner: Mutex<Inner>,
    next_conn: AtomicU64,
    next_rpc: AtomicU64,
}

impl Hub {
    pub fn new(db: Db) -> Self {
        Hub {
            db,
            inner: Mutex::default(),
            next_conn: AtomicU64::new(1),
            next_rpc: AtomicU64::new(1),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn register(&self, user: HubUser, tx: mpsc::Sender<Message>) -> (ConnId, Arc<Notify>) {
        let id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        let kick = Arc::new(Notify::new());
        let mut inner = self.lock();
        inner.by_user.entry(user.id).or_default().insert(id);
        inner.conns.insert(
            id,
            Conn {
                user,
                tx,
                kick: kick.clone(),
            },
        );
        (id, kick)
    }

    /// Removes a connection and tells everyone affected.
    pub async fn disconnect(&self, conn: ConnId) {
        let (user, hosted, failed, left, huddles) = {
            let mut inner = self.lock();
            let Some(c) = inner.conns.remove(&conn) else {
                return;
            };
            inner.signal_budget.remove(&conn);
            let mut huddles = Vec::new();
            inner.huddles.retain(|ws, h| {
                let before = h.conns.len();
                h.conns.retain(|(c, _)| *c != conn);
                if h.conns.len() != before {
                    huddles.push(*ws);
                }
                !h.conns.is_empty()
            });
            if let Some(set) = inner.by_user.get_mut(&c.user.id) {
                set.remove(&conn);
                if set.is_empty() {
                    inner.by_user.remove(&c.user.id);
                }
            }
            let hosted: Vec<Uuid> = inner
                .hosts
                .iter()
                .filter(|(_, h)| **h == conn)
                .map(|(ws, _)| *ws)
                .collect();
            for ws in &hosted {
                inner.hosts.remove(ws);
            }
            let mut failed = Vec::new();
            let ids: Vec<u64> = inner
                .pending
                .iter()
                .filter(|(_, p)| p.host == conn || p.reply.asker() == Some(conn))
                .map(|(id, _)| *id)
                .collect();
            for id in ids {
                if let Some(p) = inner.pending.remove(&id) {
                    if p.host == conn && p.reply.asker() != Some(conn) {
                        failed.push(p.reply);
                    }
                }
            }
            // Only say someone left a workspace if no other tab of theirs is still there.
            let mut left: Vec<Uuid> = inner
                .presence
                .remove(&conn)
                .unwrap_or_default()
                .into_iter()
                .collect();
            let others = inner.by_user.get(&c.user.id).cloned().unwrap_or_default();
            left.retain(|ws| {
                !others
                    .iter()
                    .any(|o| inner.presence.get(o).is_some_and(|s| s.contains(ws)))
            });
            (c.user, hosted, failed, left, huddles)
        };
        for reply in failed {
            self.answer(reply, None, Some("host offline".into()));
        }
        // Leaving the huddle by hanging up: tell the others, as if they had said so.
        for ws in huddles {
            let msg = ServerMsg::Signal {
                workspace_id: ws,
                from: user.clone(),
                kind: "leave".into(),
                payload: serde_json::json!({ "conn": conn }),
            };
            self.broadcast(ws, &msg, Except::Nobody).await;
        }
        for ws in hosted {
            self.broadcast(
                ws,
                &ServerMsg::HostStatus {
                    workspace_id: ws,
                    online: false,
                },
                Except::Nobody,
            )
            .await;
        }
        for ws in left {
            let presence = Presence {
                workspace_id: ws,
                user: user.clone(),
                viewing: None,
                cursor: None,
            };
            self.broadcast(
                ws,
                &ServerMsg::Presence {
                    presence,
                    online: false,
                },
                Except::User(user.id),
            )
            .await;
        }
    }

    /// Queues a message for one connection. A connection whose queue is full is
    /// dropped instead of slowing everyone else down.
    pub fn send(&self, conn: ConnId, msg: &ServerMsg) {
        let text = encode(msg);
        let inner = self.lock();
        if let Some(c) = inner.conns.get(&conn) {
            push(conn, c, text);
        }
    }

    pub async fn broadcast(&self, ws: Uuid, msg: &ServerMsg, except: Except) {
        let members = self.members(ws).await;
        let text = encode(msg);
        let inner = self.lock();
        for user in members.keys() {
            if matches!(except, Except::User(u) if u == *user) {
                continue;
            }
            for conn in inner.by_user.get(user).into_iter().flatten() {
                if matches!(except, Except::Conn(c) if c == *conn) {
                    continue;
                }
                if let Some(c) = inner.conns.get(conn) {
                    push(*conn, c, text.clone());
                }
            }
        }
    }

    pub fn is_online(&self, user: Uuid) -> bool {
        self.lock().by_user.contains_key(&user)
    }

    pub fn host_of(&self, ws: Uuid) -> Option<ConnId> {
        self.lock().hosts.get(&ws).copied()
    }

    pub fn set_host(&self, ws: Uuid, conn: ConnId) {
        self.lock().hosts.insert(ws, conn);
    }

    pub fn add_presence(&self, conn: ConnId, ws: Uuid) {
        self.lock().presence.entry(conn).or_default().insert(ws);
    }

    /// Registers an RPC in flight and returns the hub-unique id to forward it under.
    pub fn start_rpc(&self, reply: Reply, host: ConnId) -> u64 {
        let id = self.next_rpc.fetch_add(1, Ordering::Relaxed);
        self.lock().pending.insert(id, Pending { reply, host });
        id
    }

    /// Takes an RPC in flight. With `from`, only if that connection is the host
    /// it was sent to.
    pub fn finish_rpc(&self, id: u64, from: Option<ConnId>) -> Option<Reply> {
        let mut inner = self.lock();
        if from.is_some_and(|f| inner.pending.get(&id).is_some_and(|p| p.host != f)) {
            return None;
        }
        inner.pending.remove(&id).map(|p| p.reply)
    }

    /// Delivers an RPC's answer to whoever asked.
    pub fn answer(&self, reply: Reply, ok: Option<Value>, err: Option<String>) {
        match reply {
            Reply::Conn { asker, asker_id } => self.send(
                asker,
                &ServerMsg::RpcResult {
                    id: asker_id,
                    ok,
                    err,
                },
            ),
            Reply::Local(tx) => {
                let _ = tx.send(match err {
                    Some(e) => Err(e),
                    None => Ok(ok.unwrap_or(Value::Null)),
                });
            }
        }
    }

    /// Calls a method on the runner hosting `ws` on behalf of `from`, from inside
    /// the hub (public forms). Nobody's role is checked here; the caller decides.
    pub async fn call_host(
        &self,
        ws: Uuid,
        method: &str,
        params: Value,
        from: HubUser,
        role: Role,
        timeout: Duration,
    ) -> Result<Value, CallError> {
        let host = self.host_of(ws).ok_or(CallError::Offline)?;
        let (tx, rx) = oneshot::channel();
        let id = self.start_rpc(Reply::Local(tx), host);
        self.send(
            host,
            &ServerMsg::Rpc {
                id,
                workspace_id: ws,
                method: method.into(),
                params,
                from,
                role,
            },
        );
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) if e == "host offline" => Err(CallError::Offline),
            Ok(Ok(Err(e))) => Err(CallError::Remote(e)),
            Ok(Err(_)) => Err(CallError::Offline),
            Err(_) => {
                self.finish_rpc(id, None);
                Err(CallError::Timeout)
            }
        }
    }

    /// Queues a message for every connection of one user.
    pub fn send_user(&self, user: Uuid, msg: &ServerMsg, except: Option<ConnId>) {
        let text = encode(msg);
        let inner = self.lock();
        for conn in inner.by_user.get(&user).into_iter().flatten() {
            if Some(*conn) == except {
                continue;
            }
            if let Some(c) = inner.conns.get(conn) {
                push(*conn, c, text.clone());
            }
        }
    }

    /// Takes one signal from the connection's budget. `Err(true)` the first time
    /// it runs dry (worth telling the sender), `Err(false)` after that.
    pub fn take_signal(&self, conn: ConnId) -> Result<(), bool> {
        let mut inner = self.lock();
        let now = Instant::now();
        let b = inner.signal_budget.entry(conn).or_insert(Bucket {
            tokens: SIGNAL_BURST,
            at: now,
            warned: false,
        });
        b.tokens =
            (b.tokens + now.duration_since(b.at).as_secs_f64() * SIGNAL_RATE).min(SIGNAL_BURST);
        b.at = now;
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            b.warned = false;
            Ok(())
        } else {
            Err(!std::mem::replace(&mut b.warned, true))
        }
    }

    /// Records who is in a workspace's huddle, from their `join` and `leave` signals.
    pub fn huddle_join(&self, ws: Uuid, conn: ConnId, user: HubUser) {
        let mut inner = self.lock();
        let h = inner.huddles.entry(ws).or_default();
        if h.conns.is_empty() {
            h.since = Some(Utc::now());
        }
        if !h.conns.iter().any(|(c, _)| *c == conn) {
            h.conns.push((conn, user));
        }
    }

    pub fn huddle_leave(&self, ws: Uuid, conn: ConnId) {
        let mut inner = self.lock();
        if let Some(h) = inner.huddles.get_mut(&ws) {
            h.conns.retain(|(c, _)| *c != conn);
            if h.conns.is_empty() {
                inner.huddles.remove(&ws);
            }
        }
    }

    pub fn huddle(&self, ws: Uuid) -> HuddleState {
        let inner = self.lock();
        let h = inner.huddles.get(&ws);
        let mut participants: Vec<HubUser> = Vec::new();
        for (_, u) in h.map(|h| h.conns.as_slice()).unwrap_or_default() {
            if !participants.iter().any(|p| p.id == u.id) {
                participants.push(u.clone());
            }
        }
        HuddleState {
            workspace_id: ws,
            participants,
            since: h.and_then(|h| h.since),
        }
    }

    pub async fn role(&self, ws: Uuid, user: Uuid) -> Option<Role> {
        self.members(ws).await.get(&user).copied()
    }

    pub async fn members(&self, ws: Uuid) -> Arc<HashMap<Uuid, Role>> {
        let gen = {
            let inner = self.lock();
            if let Some(m) = inner.members.get(&ws) {
                return m.clone();
            }
            inner.members_gen
        };
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT user_id, role FROM members WHERE workspace_id = ?")
                .bind(ws.to_string())
                .fetch_all(&self.db)
                .await
                .unwrap_or_else(|e| {
                    tracing::error!("loading members of {ws}: {e}");
                    Vec::new()
                });
        let map: Arc<HashMap<Uuid, Role>> = Arc::new(
            rows.into_iter()
                .filter_map(|(u, r)| Some((Uuid::parse_str(&u).ok()?, db::parse_role(&r))))
                .collect(),
        );
        let mut inner = self.lock();
        if inner.members_gen == gen {
            inner.members.insert(ws, map.clone());
        }
        map
    }

    /// Call after any change to a workspace's members.
    pub fn invalidate(&self, ws: Uuid) {
        let mut inner = self.lock();
        inner.members.remove(&ws);
        inner.members_gen += 1;
    }
}

pub fn rpc_err(id: u64, err: impl Into<String>) -> ServerMsg {
    ServerMsg::RpcResult {
        id,
        ok: None,
        err: Some(err.into()),
    }
}

fn encode(msg: &ServerMsg) -> Utf8Bytes {
    serde_json::to_string(msg)
        .expect("ServerMsg serializes")
        .into()
}

fn push(id: ConnId, conn: &Conn, text: Utf8Bytes) {
    if let Err(mpsc::error::TrySendError::Full(_)) = conn.tx.try_send(Message::Text(text)) {
        tracing::warn!(conn = id, user = %conn.user.email, "dropping slow connection");
        conn.kick.notify_one();
    }
}
