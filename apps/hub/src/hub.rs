//! Live state: who is connected, which connection hosts which workspace, and
//! RPCs in flight. Everything here is in memory and rebuilt as clients reconnect.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use axum::extract::ws::{Message, Utf8Bytes};
use bouvio_protocol::{HubUser, Presence, Role, ServerMsg};
use tokio::sync::{mpsc, Notify};
use uuid::Uuid;

use crate::db::{self, Db};

pub type ConnId = u64;

struct Conn {
    user: HubUser,
    tx: mpsc::Sender<Message>,
    /// Tells the connection's task to hang up (it fell too far behind).
    kick: Arc<Notify>,
}

struct Pending {
    asker: ConnId,
    asker_id: u64,
    host: ConnId,
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
        let (user, hosted, failed, left) = {
            let mut inner = self.lock();
            let Some(c) = inner.conns.remove(&conn) else {
                return;
            };
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
            inner.pending.retain(|_, p| {
                if p.host == conn && p.asker != conn {
                    failed.push((p.asker, p.asker_id));
                }
                p.host != conn && p.asker != conn
            });
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
            (c.user, hosted, failed, left)
        };
        for (asker, id) in failed {
            self.send(asker, &rpc_err(id, "host offline"));
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
    pub fn start_rpc(&self, asker: ConnId, asker_id: u64, host: ConnId) -> u64 {
        let id = self.next_rpc.fetch_add(1, Ordering::Relaxed);
        self.lock().pending.insert(
            id,
            Pending {
                asker,
                asker_id,
                host,
            },
        );
        id
    }

    /// Takes an RPC in flight: `(asker, asker's id)`. With `from`, only if that
    /// connection is the host it was sent to.
    pub fn finish_rpc(&self, id: u64, from: Option<ConnId>) -> Option<(ConnId, u64)> {
        let mut inner = self.lock();
        if from.is_some_and(|f| inner.pending.get(&id).is_some_and(|p| p.host != f)) {
            return None;
        }
        inner.pending.remove(&id).map(|p| (p.asker, p.asker_id))
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
