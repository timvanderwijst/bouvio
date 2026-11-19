//! Shared workspaces, members, invites and chat history over REST.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use bouvio_protocol::{ChatMessage, HubUser, Member, Role};
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::db::{self, now_ms, role_str, WorkspaceRow};
use crate::error::{ApiError, ApiResult};
use crate::AppState;

const INVITE_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Serialize)]
pub struct WorkspaceEntry {
    id: Uuid,
    name: String,
    role: Role,
    host: HubUser,
    host_online: bool,
}

fn entry(st: &AppState, ws: WorkspaceRow, role: Role) -> WorkspaceEntry {
    let host_online = st.hub.host_of(ws.id).is_some();
    WorkspaceEntry {
        id: ws.id,
        name: ws.name,
        role,
        host: ws.host,
        host_online,
    }
}

/// The caller's role, if it is at least `min`. Non-members get a 404 so ids don't leak.
async fn require_role(st: &AppState, ws: Uuid, user: Uuid, min: Role) -> ApiResult<Role> {
    match db::role_of(&st.db, ws, user).await? {
        None => Err(ApiError::not_found("workspace not found")),
        Some(r) if r < min => Err(ApiError::forbidden(format!("needs role {}", role_str(min)))),
        Some(r) => Ok(r),
    }
}

async fn workspace_row(st: &AppState, ws: Uuid) -> ApiResult<WorkspaceRow> {
    db::workspace(&st.db, ws)
        .await?
        .ok_or_else(|| ApiError::not_found("workspace not found"))
}

#[derive(Deserialize)]
pub struct CreateWorkspace {
    id: Uuid,
    name: String,
}

pub async fn create(
    State(st): State<AppState>,
    auth: AuthUser,
    Json(body): Json<CreateWorkspace>,
) -> ApiResult<(StatusCode, Json<WorkspaceEntry>)> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("name is empty"));
    }
    // Registering again from the same host is fine (and renames); anyone else gets a conflict.
    if let Some(existing) = db::workspace(&st.db, body.id).await? {
        if existing.host.id != auth.user.id {
            return Err(ApiError::conflict(
                "a workspace with this id is already hosted by someone else",
            ));
        }
        sqlx::query("UPDATE workspaces SET name = ? WHERE id = ?")
            .bind(name)
            .bind(body.id.to_string())
            .execute(&st.db)
            .await?;
        let ws = workspace_row(&st, body.id).await?;
        return Ok((StatusCode::OK, Json(entry(&st, ws, Role::Admin))));
    }
    sqlx::query("INSERT INTO workspaces (id, name, host_id, created_at) VALUES (?, ?, ?, ?)")
        .bind(body.id.to_string())
        .bind(name)
        .bind(auth.user.id.to_string())
        .bind(now_ms())
        .execute(&st.db)
        .await?;
    db::add_member(&st.db, body.id, auth.user.id, Role::Admin, true).await?;
    st.hub.invalidate(body.id);
    let ws = workspace_row(&st, body.id).await?;
    Ok((StatusCode::CREATED, Json(entry(&st, ws, Role::Admin))))
}

pub async fn list(
    State(st): State<AppState>,
    auth: AuthUser,
) -> ApiResult<Json<Vec<WorkspaceEntry>>> {
    let rows = db::workspaces_of(&st.db, auth.user.id).await?;
    Ok(Json(
        rows.into_iter()
            .map(|(ws, role)| entry(&st, ws, role))
            .collect(),
    ))
}

pub async fn members(
    State(st): State<AppState>,
    auth: AuthUser,
    Path(ws): Path<Uuid>,
) -> ApiResult<Json<Vec<Member>>> {
    require_role(&st, ws, auth.user.id, Role::Viewer).await?;
    let rows = db::members(&st.db, ws).await?;
    Ok(Json(
        rows.into_iter()
            .map(|m| Member {
                online: st.hub.is_online(m.user.id),
                user: m.user,
                role: m.role,
                see_costs: m.see_costs,
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct UpdateMember {
    role: Option<Role>,
    see_costs: Option<bool>,
}

pub async fn update_member(
    State(st): State<AppState>,
    auth: AuthUser,
    Path((ws, user_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateMember>,
) -> ApiResult<Json<Member>> {
    require_role(&st, ws, auth.user.id, Role::Admin).await?;
    let row = workspace_row(&st, ws).await?;
    if row.host.id == user_id && body.role.is_some_and(|r| r != Role::Admin) {
        return Err(ApiError::forbidden("the host cannot be demoted"));
    }
    if db::role_of(&st.db, ws, user_id).await?.is_none() {
        return Err(ApiError::not_found("not a member"));
    }
    if let Some(role) = body.role {
        sqlx::query("UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?")
            .bind(role_str(role))
            .bind(ws.to_string())
            .bind(user_id.to_string())
            .execute(&st.db)
            .await?;
    }
    if let Some(see_costs) = body.see_costs {
        sqlx::query("UPDATE members SET see_costs = ? WHERE workspace_id = ? AND user_id = ?")
            .bind(see_costs)
            .bind(ws.to_string())
            .bind(user_id.to_string())
            .execute(&st.db)
            .await?;
    }
    st.hub.invalidate(ws);
    let m = db::members(&st.db, ws)
        .await?
        .into_iter()
        .find(|m| m.user.id == user_id)
        .ok_or_else(|| ApiError::not_found("not a member"))?;
    Ok(Json(Member {
        online: st.hub.is_online(user_id),
        user: m.user,
        role: m.role,
        see_costs: m.see_costs,
    }))
}

/// Admins remove anyone but the host; any member may remove themselves (leave).
pub async fn remove_member(
    State(st): State<AppState>,
    auth: AuthUser,
    Path((ws, user_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    let min = if user_id == auth.user.id {
        Role::Viewer
    } else {
        Role::Admin
    };
    require_role(&st, ws, auth.user.id, min).await?;
    if workspace_row(&st, ws).await?.host.id == user_id {
        return Err(ApiError::forbidden("the host cannot be removed"));
    }
    let res = sqlx::query("DELETE FROM members WHERE workspace_id = ? AND user_id = ?")
        .bind(ws.to_string())
        .bind(user_id.to_string())
        .execute(&st.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::not_found("not a member"));
    }
    st.hub.invalidate(ws);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct CreateInvite {
    role: Role,
}

#[derive(Serialize)]
pub struct Invite {
    code: String,
    url: String,
    role: Role,
    expires_at: DateTime<chrono::Utc>,
}

pub async fn create_invite(
    State(st): State<AppState>,
    auth: AuthUser,
    Path(ws): Path<Uuid>,
    Json(body): Json<CreateInvite>,
) -> ApiResult<Json<Invite>> {
    require_role(&st, ws, auth.user.id, Role::Admin).await?;
    let code = db::random_code(10);
    let now = now_ms();
    sqlx::query(
        "INSERT INTO invites (code, workspace_id, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&code)
    .bind(ws.to_string())
    .bind(role_str(body.role))
    .bind(auth.user.id.to_string())
    .bind(now)
    .bind(now + INVITE_TTL_MS)
    .execute(&st.db)
    .await?;
    let url = format!("{}/invite/{code}", st.config.public_url);
    Ok(Json(Invite {
        code,
        url,
        role: body.role,
        expires_at: db::from_ms(now + INVITE_TTL_MS),
    }))
}

/// Joins with the invite's role. Someone who is already a member keeps their role.
pub async fn accept_invite(
    State(st): State<AppState>,
    auth: AuthUser,
    Path(code): Path<String>,
) -> ApiResult<Json<WorkspaceEntry>> {
    let code = code.trim().to_uppercase();
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT workspace_id, role FROM invites WHERE code = ? AND expires_at > ?")
            .bind(&code)
            .bind(now_ms())
            .fetch_optional(&st.db)
            .await?;
    let (ws, role) =
        row.ok_or_else(|| ApiError::not_found("this invite does not exist or has expired"))?;
    let ws = Uuid::parse_str(&ws).map_err(|e| ApiError::from(anyhow::anyhow!(e)))?;
    db::add_member(&st.db, ws, auth.user.id, db::parse_role(&role), false).await?;
    st.hub.invalidate(ws);
    let role = db::role_of(&st.db, ws, auth.user.id)
        .await?
        .unwrap_or(Role::Viewer);
    let ws = workspace_row(&st, ws).await?;
    Ok(Json(entry(&st, ws, role)))
}

#[derive(Deserialize)]
pub struct ChatQuery {
    channel: Option<String>,
    before: Option<String>,
    limit: Option<i64>,
}

pub async fn chat_history(
    State(st): State<AppState>,
    auth: AuthUser,
    Path(ws): Path<Uuid>,
    Query(q): Query<ChatQuery>,
) -> ApiResult<Json<Vec<ChatMessage>>> {
    require_role(&st, ws, auth.user.id, Role::Viewer).await?;
    let channel = q.channel.unwrap_or_else(|| "general".into());
    let before = match q.before {
        // A `+` in an offset arrives as a space when the client did not encode it.
        Some(b) => DateTime::parse_from_rfc3339(&b.replace(' ', "+"))
            .map_err(|_| ApiError::bad_request("before must be an RFC 3339 time"))?
            .timestamp_millis(),
        None => i64::MAX,
    };
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    Ok(Json(
        db::chat_page(&st.db, ws, &channel, before, limit).await?,
    ))
}
