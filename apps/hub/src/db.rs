//! SQLite access. Plain runtime queries, so the crate builds without a database.

use std::path::Path;
use std::str::FromStr;

use anyhow::Context;
use cuna_protocol::{HubUser, Role};
use chrono::{DateTime, TimeZone, Utc};
use rand::distr::{Alphanumeric, SampleString};
use rand::Rng;
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;
use uuid::Uuid;

pub type Db = SqlitePool;

pub async fn connect(url: &str) -> anyhow::Result<Db> {
    if let Some(dir) = sqlite_file(url).and_then(|p| p.parent()) {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
    }
    let opts = SqliteConnectOptions::from_str(url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await?;
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("running migrations")?;
    Ok(pool)
}

/// The file behind a `sqlite://path` url, if it is a file at all.
fn sqlite_file(url: &str) -> Option<&Path> {
    let rest = url
        .strip_prefix("sqlite://")
        .or_else(|| url.strip_prefix("sqlite:"))?;
    let path = rest.split('?').next()?;
    (!path.is_empty() && path != ":memory:").then(|| Path::new(path))
}

// ---- small helpers -------------------------------------------------------------

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

pub fn from_ms(ms: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(ms).single().unwrap_or_default()
}

pub fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn random_token() -> String {
    Alphanumeric.sample_string(&mut rand::rng(), 48)
}

/// Short code people type by hand: no 0/O/1/I/L.
pub fn random_code(len: usize) -> String {
    const ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    let mut rng = rand::rng();
    (0..len)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect()
}

pub fn random_digits(len: usize) -> String {
    let mut rng = rand::rng();
    (0..len)
        .map(|_| char::from(b'0' + rng.random_range(0..10u8)))
        .collect()
}

pub fn role_str(role: Role) -> &'static str {
    match role {
        Role::Viewer => "viewer",
        Role::Commenter => "commenter",
        Role::Prompter => "prompter",
        Role::Operator => "operator",
        Role::Admin => "admin",
    }
}

pub fn parse_role(s: &str) -> Role {
    match s {
        "admin" => Role::Admin,
        "operator" => Role::Operator,
        "prompter" => Role::Prompter,
        "commenter" => Role::Commenter,
        _ => Role::Viewer,
    }
}

fn parse_uuid(s: &str) -> Uuid {
    Uuid::parse_str(s).unwrap_or_default()
}

// ---- users & sessions ---------------------------------------------------------

type UserRow = (String, String, String, Option<String>);

fn user_from_row((id, name, email, avatar_url): UserRow) -> HubUser {
    HubUser {
        id: parse_uuid(&id),
        name,
        email,
        avatar_url,
    }
}

pub async fn user_by_id(db: &Db, id: Uuid) -> sqlx::Result<Option<HubUser>> {
    let row: Option<UserRow> =
        sqlx::query_as("SELECT id, name, email, avatar_url FROM users WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(db)
            .await?;
    Ok(row.map(user_from_row))
}

/// Finds the user with this email or creates one. A known user keeps their name;
/// an avatar is only filled in when they have none yet.
pub async fn upsert_user(
    db: &Db,
    email: &str,
    name: Option<&str>,
    avatar_url: Option<&str>,
) -> sqlx::Result<HubUser> {
    let existing: Option<UserRow> =
        sqlx::query_as("SELECT id, name, email, avatar_url FROM users WHERE email = ?")
            .bind(email)
            .fetch_optional(db)
            .await?;
    if let Some(row) = existing {
        let mut user = user_from_row(row);
        if user.avatar_url.is_none() && avatar_url.is_some() {
            sqlx::query("UPDATE users SET avatar_url = ? WHERE id = ?")
                .bind(avatar_url)
                .bind(user.id.to_string())
                .execute(db)
                .await?;
            user.avatar_url = avatar_url.map(str::to_string);
        }
        return Ok(user);
    }
    let name = name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| email.split('@').next().unwrap_or(email))
        .to_string();
    let user = HubUser {
        id: Uuid::new_v4(),
        name,
        email: email.to_string(),
        avatar_url: avatar_url.map(str::to_string),
    };
    sqlx::query(
        "INSERT INTO users (id, email, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(user.id.to_string())
    .bind(&user.email)
    .bind(&user.name)
    .bind(&user.avatar_url)
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(user)
}

/// Creates a session and returns the token; only its hash is stored.
pub async fn create_session(db: &Db, user_id: Uuid) -> sqlx::Result<String> {
    let token = random_token();
    sqlx::query("INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)")
        .bind(sha256_hex(&token))
        .bind(user_id.to_string())
        .bind(now_ms())
        .execute(db)
        .await?;
    Ok(token)
}

pub async fn user_by_token(db: &Db, token: &str) -> sqlx::Result<Option<HubUser>> {
    let row: Option<UserRow> = sqlx::query_as(
        "SELECT u.id, u.name, u.email, u.avatar_url FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?",
    )
    .bind(sha256_hex(token))
    .fetch_optional(db)
    .await?;
    Ok(row.map(user_from_row))
}

pub async fn delete_session(db: &Db, token: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
        .bind(sha256_hex(token))
        .execute(db)
        .await?;
    Ok(())
}

// ---- workspaces & members -----------------------------------------------------

/// workspace id, name, then the host's user columns.
type WsHostRow = (String, String, String, String, String, Option<String>);
/// A `WsHostRow` plus the member's role.
type WsRoleRow = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
);

pub struct WorkspaceRow {
    pub id: Uuid,
    pub name: String,
    pub host: HubUser,
}

pub async fn workspace(db: &Db, id: Uuid) -> sqlx::Result<Option<WorkspaceRow>> {
    let row: Option<WsHostRow> = sqlx::query_as(
        "SELECT w.id, w.name, u.id, u.name, u.email, u.avatar_url
         FROM workspaces w JOIN users u ON u.id = w.host_id WHERE w.id = ?",
    )
    .bind(id.to_string())
    .fetch_optional(db)
    .await?;
    Ok(
        row.map(|(id, name, uid, uname, email, avatar)| WorkspaceRow {
            id: parse_uuid(&id),
            name,
            host: user_from_row((uid, uname, email, avatar)),
        }),
    )
}

/// Workspaces the user belongs to, with their role in each.
pub async fn workspaces_of(db: &Db, user_id: Uuid) -> sqlx::Result<Vec<(WorkspaceRow, Role)>> {
    let rows: Vec<WsRoleRow> = sqlx::query_as(
        "SELECT w.id, w.name, u.id, u.name, u.email, u.avatar_url, m.role
         FROM members m JOIN workspaces w ON w.id = m.workspace_id JOIN users u ON u.id = w.host_id
         WHERE m.user_id = ? ORDER BY w.name COLLATE NOCASE",
    )
    .bind(user_id.to_string())
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, uid, uname, email, avatar, role)| {
            let ws = WorkspaceRow {
                id: parse_uuid(&id),
                name,
                host: user_from_row((uid, uname, email, avatar)),
            };
            (ws, parse_role(&role))
        })
        .collect())
}

pub async fn role_of(db: &Db, workspace_id: Uuid, user_id: Uuid) -> sqlx::Result<Option<Role>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?")
            .bind(workspace_id.to_string())
            .bind(user_id.to_string())
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(r,)| parse_role(&r)))
}

pub struct MemberRow {
    pub user: HubUser,
    pub role: Role,
    pub see_costs: bool,
}

pub async fn members(db: &Db, workspace_id: Uuid) -> sqlx::Result<Vec<MemberRow>> {
    let rows: Vec<(String, String, String, Option<String>, String, bool)> = sqlx::query_as(
        "SELECT u.id, u.name, u.email, u.avatar_url, m.role, m.see_costs
         FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at",
    )
    .bind(workspace_id.to_string())
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, email, avatar, role, see_costs)| MemberRow {
            user: user_from_row((id, name, email, avatar)),
            role: parse_role(&role),
            see_costs,
        })
        .collect())
}

pub async fn add_member(
    db: &Db,
    workspace_id: Uuid,
    user_id: Uuid,
    role: Role,
    see_costs: bool,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO members (workspace_id, user_id, role, see_costs, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, user_id) DO NOTHING",
    )
    .bind(workspace_id.to_string())
    .bind(user_id.to_string())
    .bind(role_str(role))
    .bind(see_costs)
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(())
}
