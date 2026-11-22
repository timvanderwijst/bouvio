//! Chat storage and REST: channels, history, thread replies, reactions, pins.
//! The realtime side (sending, reacting, pinning) lives in `ws.rs`.

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use cuna_protocol::comms::{ChatChannel, ReplySummary};
use cuna_protocol::{ChatMessage, HubUser, Role};
use chrono::DateTime;
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::db::{from_ms, now_ms, Db};
use crate::error::{ApiError, ApiResult};
use crate::workspaces::require_role;
use crate::AppState;

pub const GENERAL: &str = "general";
/// Distinct emoji on one message; more is noise.
const MAX_EMOJI_PER_MESSAGE: i64 = 24;

// ---- storage -------------------------------------------------------------------

type MsgRow = (
    String,
    String,
    String,
    i64,
    Option<String>,
    bool,
    String,
    String,
    String,
    Option<String>,
);

const SELECT: &str = "SELECT c.id, c.channel, c.text, c.at, c.parent_id, c.pinned, u.id, u.name, u.email, u.avatar_url
     FROM chat_messages c JOIN users u ON u.id = c.author_id";

fn parse_uuid(s: &str) -> Uuid {
    Uuid::parse_str(s).unwrap_or_default()
}

fn from_row(ws: Uuid, r: MsgRow) -> ChatMessage {
    let (id, channel, text, at, parent, pinned, uid, name, email, avatar) = r;
    ChatMessage {
        id: parse_uuid(&id),
        workspace_id: ws,
        channel,
        author: HubUser {
            id: parse_uuid(&uid),
            name,
            email,
            avatar_url: avatar,
        },
        text,
        at: from_ms(at),
        parent: parent.as_deref().map(parse_uuid),
        reactions: vec![],
        pinned,
    }
}

/// Fills in reactions, grouped per emoji in the order they were first used.
async fn with_reactions(db: &Db, mut msgs: Vec<ChatMessage>) -> sqlx::Result<Vec<ChatMessage>> {
    if msgs.is_empty() {
        return Ok(msgs);
    }
    let mut by_msg: HashMap<Uuid, Vec<(String, Vec<Uuid>)>> = HashMap::new();
    // SQLite allows 32766 parameters; pages are at most 200 messages.
    for chunk in msgs.chunks(500) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT message_id, emoji, user_id FROM chat_reactions WHERE message_id IN ({marks}) ORDER BY at, rowid"
        );
        let mut q = sqlx::query_as::<_, (String, String, String)>(&sql);
        for m in chunk {
            q = q.bind(m.id.to_string());
        }
        for (mid, emoji, uid) in q.fetch_all(db).await? {
            let list = by_msg.entry(parse_uuid(&mid)).or_default();
            let uid = parse_uuid(&uid);
            match list.iter_mut().find(|(e, _)| *e == emoji) {
                Some((_, users)) => users.push(uid),
                None => list.push((emoji, vec![uid])),
            }
        }
    }
    for m in &mut msgs {
        if let Some(r) = by_msg.remove(&m.id) {
            m.reactions = r;
        }
    }
    Ok(msgs)
}

pub async fn insert(db: &Db, msg: &ChatMessage) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO chat_messages (id, workspace_id, channel, author_id, text, at, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(msg.id.to_string())
    .bind(msg.workspace_id.to_string())
    .bind(&msg.channel)
    .bind(msg.author.id.to_string())
    .bind(&msg.text)
    .bind(msg.at.timestamp_millis())
    .bind(msg.parent.map(|p| p.to_string()))
    .execute(db)
    .await?;
    Ok(())
}

/// One message of a workspace, with its reactions.
pub async fn message(db: &Db, ws: Uuid, id: Uuid) -> sqlx::Result<Option<ChatMessage>> {
    let row: Option<MsgRow> =
        sqlx::query_as(&format!("{SELECT} WHERE c.workspace_id = ? AND c.id = ?"))
            .bind(ws.to_string())
            .bind(id.to_string())
            .fetch_optional(db)
            .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(with_reactions(db, vec![from_row(ws, row)]).await?.pop())
}

/// Top-level messages of a channel before `before_ms`, oldest first.
pub async fn page(
    db: &Db,
    ws: Uuid,
    channel: &str,
    before_ms: i64,
    limit: i64,
) -> sqlx::Result<Vec<ChatMessage>> {
    let rows: Vec<MsgRow> = sqlx::query_as(&format!(
        "{SELECT} WHERE c.workspace_id = ? AND c.channel = ? AND c.parent_id IS NULL AND c.at < ?
         ORDER BY c.at DESC, c.rowid DESC LIMIT ?"
    ))
    .bind(ws.to_string())
    .bind(channel)
    .bind(before_ms)
    .bind(limit)
    .fetch_all(db)
    .await?;
    let msgs = rows.into_iter().rev().map(|r| from_row(ws, r)).collect();
    with_reactions(db, msgs).await
}

/// Replies under `parent`, oldest first.
pub async fn replies(
    db: &Db,
    ws: Uuid,
    parent: Uuid,
    before_ms: i64,
    limit: i64,
) -> sqlx::Result<Vec<ChatMessage>> {
    let rows: Vec<MsgRow> = sqlx::query_as(&format!(
        "{SELECT} WHERE c.workspace_id = ? AND c.parent_id = ? AND c.at < ?
         ORDER BY c.at DESC, c.rowid DESC LIMIT ?"
    ))
    .bind(ws.to_string())
    .bind(parent.to_string())
    .bind(before_ms)
    .bind(limit)
    .fetch_all(db)
    .await?;
    let msgs = rows.into_iter().rev().map(|r| from_row(ws, r)).collect();
    with_reactions(db, msgs).await
}

pub async fn pinned(db: &Db, ws: Uuid, channel: Option<&str>) -> sqlx::Result<Vec<ChatMessage>> {
    let rows: Vec<MsgRow> = sqlx::query_as(&format!(
        "{SELECT} WHERE c.workspace_id = ? AND c.pinned = 1 AND (? IS NULL OR c.channel = ?)
         ORDER BY c.at DESC LIMIT 200"
    ))
    .bind(ws.to_string())
    .bind(channel)
    .bind(channel)
    .fetch_all(db)
    .await?;
    let msgs = rows.into_iter().map(|r| from_row(ws, r)).collect();
    with_reactions(db, msgs).await
}

/// Adds the reaction, or removes it when this person already reacted so.
pub async fn toggle_reaction(db: &Db, msg: Uuid, user: Uuid, emoji: &str) -> sqlx::Result<bool> {
    let removed = sqlx::query(
        "DELETE FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
    )
    .bind(msg.to_string())
    .bind(user.to_string())
    .bind(emoji)
    .execute(db)
    .await?
    .rows_affected();
    if removed > 0 {
        return Ok(true);
    }
    let (distinct,): (i64,) = sqlx::query_as(
        "SELECT COUNT(DISTINCT emoji) FROM chat_reactions WHERE message_id = ? AND emoji != ?",
    )
    .bind(msg.to_string())
    .bind(emoji)
    .fetch_one(db)
    .await?;
    if distinct >= MAX_EMOJI_PER_MESSAGE {
        return Ok(false);
    }
    sqlx::query("INSERT INTO chat_reactions (message_id, user_id, emoji, at) VALUES (?, ?, ?, ?)")
        .bind(msg.to_string())
        .bind(user.to_string())
        .bind(emoji)
        .bind(now_ms())
        .execute(db)
        .await?;
    Ok(true)
}

pub async fn set_pinned(db: &Db, msg: Uuid, pinned: bool) -> sqlx::Result<()> {
    sqlx::query("UPDATE chat_messages SET pinned = ? WHERE id = ?")
        .bind(pinned)
        .bind(msg.to_string())
        .execute(db)
        .await?;
    Ok(())
}

pub async fn reply_summaries(db: &Db, ws: Uuid, channel: &str) -> sqlx::Result<Vec<ReplySummary>> {
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT parent_id, COUNT(*), MAX(at) FROM chat_messages
         WHERE workspace_id = ? AND channel = ? AND parent_id IS NOT NULL
         GROUP BY parent_id ORDER BY MAX(at) DESC LIMIT 1000",
    )
    .bind(ws.to_string())
    .bind(channel)
    .fetch_all(db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for (parent, count, last) in rows {
        let authors: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
            "SELECT u.id, u.name, u.email, u.avatar_url FROM chat_messages c JOIN users u ON u.id = c.author_id
             WHERE c.parent_id = ? GROUP BY u.id ORDER BY MAX(c.at) DESC LIMIT 5",
        )
        .bind(&parent)
        .fetch_all(db)
        .await?;
        out.push(ReplySummary {
            parent: parse_uuid(&parent),
            count: count as u32,
            last_at: from_ms(last),
            authors: authors
                .into_iter()
                .map(|(id, name, email, avatar_url)| HubUser {
                    id: parse_uuid(&id),
                    name,
                    email,
                    avatar_url,
                })
                .collect(),
        });
    }
    Ok(out)
}

/// `general`, then created channels and any channel that has messages, by name.
pub async fn channels(db: &Db, ws: Uuid) -> sqlx::Result<Vec<ChatChannel>> {
    let rows: Vec<(String, Option<String>, i64)> = sqlx::query_as(
        "SELECT name, created_by, created_at FROM chat_channels WHERE workspace_id = ?
         UNION ALL
         SELECT channel, NULL, MIN(at) FROM chat_messages WHERE workspace_id = ?
           AND channel NOT IN (SELECT name FROM chat_channels WHERE workspace_id = ?)
           GROUP BY channel",
    )
    .bind(ws.to_string())
    .bind(ws.to_string())
    .bind(ws.to_string())
    .fetch_all(db)
    .await?;
    let mut out: Vec<ChatChannel> = rows
        .into_iter()
        .filter(|(n, _, _)| n != GENERAL)
        .map(|(name, by, at)| ChatChannel {
            name,
            created_at: from_ms(at),
            created_by: by.as_deref().map(parse_uuid),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out.insert(
        0,
        ChatChannel {
            name: GENERAL.into(),
            created_at: from_ms(0),
            created_by: None,
        },
    );
    Ok(out)
}

/// `Design Review!` -> `design-review`. None when nothing usable is left.
pub fn channel_name(raw: &str) -> Option<String> {
    let mut out = String::new();
    for c in raw.trim().trim_start_matches('#').chars() {
        if c.is_alphanumeric() || c == '_' {
            out.extend(c.to_lowercase());
        } else if (c == '-' || c.is_whitespace()) && !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out: String = out.trim_end_matches('-').chars().take(64).collect();
    (!out.is_empty()).then_some(out)
}

// ---- REST ----------------------------------------------------------------------

#[derive(Deserialize)]
pub struct HistoryQuery {
    channel: Option<String>,
    parent: Option<Uuid>,
    before: Option<String>,
    limit: Option<i64>,
}

/// `GET /workspaces/:id/chat?channel=&before=&limit=` — top-level messages; with
/// `?parent=<id>` the replies in that message's thread instead.
pub async fn history(
    State(st): State<AppState>,
    auth: AuthUser,
    Path(ws): Path<Uuid>,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Json<Vec<ChatMessage>>> {
    require_role(&st, ws, auth.user.id, Role::Viewer).await?;
    let before = match q.before {
        // A `+` in an offset arrives as a space when the client did not encode it.
        Some(b) => DateTime::parse_from_rfc3339(&b.replace(' ', "+"))
            .map_err(|_| ApiError::bad_request("before must be an RFC 3339 time"))?
            .timestamp_millis(),
        None => i64::MAX,
    };
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    if let Some(parent) = q.parent {
        return Ok(Json(replies(&st.db, ws, parent, before, limit).await?));
    }
    let channel = q.channel.unwrap_or_else(|| GENERAL.into());
    Ok(Json(page(&st.db, ws, &channel, before, limit).await?))
}

#[derive(Deserialize)]
pub struct ChannelQuery {
    channel: Option<String>,
}

/// `GET /workspaces/:id/chat/pinned?channel=` — newest first; all channels without one.
pub async fn pinned_list(
    State(st): State<AppState>,
    auth: AuthUser,
    Path(ws): Path<Uuid>,
    Query(q): Query<ChannelQuery>,
) -> ApiResult<Json<Vec<ChatMessage>>> {
    require_role(&st, ws, auth.user.id, Role::Viewer).await?;
    Ok(Json(pinned(&st.db, ws, q.channel.as_deref()).await?))
}

/// `GET /workspaces/:id/chat/replies?channel=` — reply counts per message.
pub async fn replies_list(
    State(st): State<AppState>,
    auth: AuthUser,
    Path(ws): Path<Uuid>,
    Query(q): Query<ChannelQuery>,
) -> ApiResult<Json<Vec<ReplySummary>>> {
    require_role(&st, ws, auth.user.id, Role::Viewer).await?;
    let channel = q.channel.unwrap_or_else(|| GENERAL.into());
    Ok(Json(reply_summaries(&st.db, ws, &channel).await?))
}

pub async fn channels_list(
    State(st): State<AppState>,
    auth: AuthUser,
    Path(ws): Path<Uuid>,
) -> ApiResult<Json<Vec<ChatChannel>>> {
    require_role(&st, ws, auth.user.id, Role::Viewer).await?;
    Ok(Json(channels(&st.db, ws).await?))
}

#[derive(Deserialize)]
pub struct NewChannel {
    name: String,
}

/// `POST /workspaces/:id/channels {name}` — commenter or higher. Creating one that
/// exists returns it.
pub async fn create_channel(
    State(st): State<AppState>,
    auth: AuthUser,
    Path(ws): Path<Uuid>,
    Json(body): Json<NewChannel>,
) -> ApiResult<(StatusCode, Json<ChatChannel>)> {
    require_role(&st, ws, auth.user.id, Role::Commenter).await?;
    let name = channel_name(&body.name)
        .ok_or_else(|| ApiError::bad_request("a channel name needs letters or digits"))?;
    if name == GENERAL {
        return Ok((
            StatusCode::OK,
            Json(ChatChannel {
                name,
                created_at: from_ms(0),
                created_by: None,
            }),
        ));
    }
    let (count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM chat_channels WHERE workspace_id = ?")
            .bind(ws.to_string())
            .fetch_one(&st.db)
            .await?;
    if count >= 200 {
        return Err(ApiError::bad_request(
            "a workspace has at most 200 channels",
        ));
    }
    let now = now_ms();
    let res = sqlx::query(
        "INSERT INTO chat_channels (workspace_id, name, created_by, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace_id, name) DO NOTHING",
    )
    .bind(ws.to_string())
    .bind(&name)
    .bind(auth.user.id.to_string())
    .bind(now)
    .execute(&st.db)
    .await?;
    let status = if res.rows_affected() > 0 {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    let ch = channels(&st.db, ws)
        .await?
        .into_iter()
        .find(|c| c.name == name)
        .ok_or_else(|| ApiError::not_found("channel not found"))?;
    Ok((status, Json(ch)))
}

#[cfg(test)]
mod tests {
    use super::channel_name;

    #[test]
    fn channel_names() {
        assert_eq!(
            channel_name("#Design Review!").as_deref(),
            Some("design-review")
        );
        assert_eq!(channel_name("  a  -- b ").as_deref(), Some("a-b"));
        assert_eq!(channel_name("ops_2").as_deref(), Some("ops_2"));
        assert_eq!(channel_name("!!!"), None);
        assert_eq!(channel_name(&"x".repeat(100)).map(|s| s.len()), Some(64));
    }
}
