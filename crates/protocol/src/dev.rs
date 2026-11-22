//! Developer tools: review comments, CI runs, database viewer, API client, git graph, element picker.
//!
//! Owned by one feature area; types here derive `TS` and export next to the others.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

// ---- preview proxy -------------------------------------------------------------------

/// A thread's dev server behind Cuna's proxy, which adds the element picker.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct DevProxy {
    pub thread_id: Uuid,
    /// What the preview frame loads, e.g. `http://127.0.0.1:51234`.
    pub url: String,
    /// The dev server behind it.
    pub upstream: String,
}

// ---- line-by-line review ---------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum ReviewSide {
    /// A removed line, numbered in the old file.
    Old,
    /// An added or unchanged line, numbered in the new file.
    New,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct ReviewComment {
    pub id: Uuid,
    pub thread_id: Uuid,
    pub path: String,
    pub line: u32,
    pub side: ReviewSide,
    pub text: String,
    pub author: String,
    /// The line's content when the comment was made, to follow it when the diff moves.
    pub line_text: String,
    pub resolved: bool,
    /// The line is gone from the diff.
    pub outdated: bool,
    pub created_at: DateTime<Utc>,
}

// ---- checks (CI through `gh`) ------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct CiRun {
    #[ts(type = "number")]
    pub id: u64,
    pub title: String,
    pub workflow: String,
    pub branch: String,
    /// `queued`, `in_progress`, `completed`, …
    pub status: String,
    /// `success`, `failure`, `cancelled`, `skipped`, … once completed.
    pub conclusion: Option<String>,
    pub event: String,
    pub created_at: String,
    pub url: String,
    /// The thread working on this branch, if any.
    pub thread_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct CiLog {
    pub text: String,
    /// Cut at 200 kB.
    pub truncated: bool,
}

// ---- data (database viewer) ----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum DbKind {
    Sqlite,
    Postgres,
    Mysql,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct DbConnection {
    /// Nil on save creates a new connection.
    pub id: Uuid,
    pub name: String,
    pub kind: DbKind,
    /// A file path for SQLite (relative to the workspace root, or absolute),
    /// a `postgres://` or `mysql://` URL otherwise. Lists show the password as `****`.
    pub url: String,
    /// Refuse anything but reads. On by default.
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct DbConnections {
    pub connections: Vec<DbConnection>,
    /// `*.db` / `*.sqlite` files in the workspace root not saved yet.
    pub suggestions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct DbTable {
    /// `schema.table` outside the default schema.
    pub name: String,
    /// `table` or `view`.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct DbOrder {
    pub column: String,
    pub desc: bool,
}

/// Rows as columns plus JSON values (numbers, strings, booleans, null).
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct DbRows {
    pub columns: Vec<String>,
    #[ts(type = "unknown[][]")]
    pub rows: Vec<Vec<serde_json::Value>>,
    /// More rows than the 1000 cap.
    pub truncated: bool,
    /// Rows in the whole table, for paging (`get_db_rows` only).
    #[ts(type = "number | null")]
    pub total: Option<u64>,
    /// For statements that change data.
    #[ts(type = "number | null")]
    pub affected: Option<u64>,
    #[ts(type = "number")]
    pub time_ms: u64,
}

// ---- API client ------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<HttpHeader>,
    /// Text, or base64 when `base64` is set.
    pub body: String,
    pub base64: bool,
    #[ts(type = "number")]
    pub time_ms: u64,
    #[ts(type = "number")]
    pub size: u64,
    /// The URL after `{{variables}}` and redirects.
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct ApiRequest {
    /// Nil on save creates a new request.
    pub id: Uuid,
    pub name: String,
    pub method: String,
    pub url: String,
    pub headers: Vec<HttpHeader>,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct ApiVariable {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct ApiEnvironment {
    pub id: Uuid,
    pub name: String,
    pub variables: Vec<ApiVariable>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct ApiHistoryEntry {
    pub id: Uuid,
    pub at: DateTime<Utc>,
    /// As written, with `{{variables}}`, so it can be opened again.
    pub request: ApiRequest,
    /// None when the request failed before a response.
    pub status: Option<u16>,
    #[ts(type = "number")]
    pub time_ms: u64,
    #[ts(type = "number")]
    pub size: u64,
}

/// Everything the API client shows for a workspace.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct ApiCollection {
    pub requests: Vec<ApiRequest>,
    pub environments: Vec<ApiEnvironment>,
    pub active_env: Option<Uuid>,
    /// Newest first, the last 50.
    pub history: Vec<ApiHistoryEntry>,
}

// ---- git graph ---------------------------------------------------------------------------------

/// A line between this row and the next, from lane `from` to lane `to`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct GraphEdge {
    pub from: u32,
    pub to: u32,
    pub color: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct GraphCommit {
    pub sha: String,
    pub parents: Vec<String>,
    /// Branch and tag names, `HEAD` first when it points here.
    pub refs: Vec<String>,
    pub author: String,
    pub email: String,
    pub date: String,
    pub subject: String,
    pub lane: u32,
    pub color: u32,
    /// Lines down to the next row.
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct GitGraph {
    pub commits: Vec<GraphCommit>,
    /// Widest row, for sizing the graph column.
    pub lanes: u32,
    pub head: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct CommitFile {
    pub path: String,
    /// None for binary files.
    pub adds: Option<u32>,
    pub dels: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct CommitDetail {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub date: String,
    pub subject: String,
    pub body: String,
    pub files: Vec<CommitFile>,
    /// `git show --stat` as text.
    pub stat: String,
}
