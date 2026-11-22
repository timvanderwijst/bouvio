//! Personal overview: brief, tasks and notes, costs and budgets, replay, evals.
//!
//! Owned by one feature area; types here derive `TS` and export next to the others.

use crate::{HarnessKind, ThreadEvent};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

// ---- morning brief ----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum BriefKind {
    /// A thread is blocked on an approval or a question.
    Waiting,
    Failed,
    Finished,
    /// An issue changed status.
    Issue,
    /// An automation ran.
    Automation,
    /// One of my tasks is due today (or overdue).
    Task,
}

/// One fact in the brief, with ids so the UI can link it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct BriefItem {
    pub kind: BriefKind,
    /// Thread, issue, automation or task id.
    pub id: Uuid,
    pub workspace_id: Option<Uuid>,
    pub workspace: Option<String>,
    pub title: String,
    /// Issue status, `overdue`, the automation's thread title, …
    pub detail: Option<String>,
    /// A thread to open for this item (an automation's last run, an issue's thread).
    pub thread_id: Option<Uuid>,
    pub at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct Brief {
    /// Local date, `YYYY-MM-DD`.
    pub date: String,
    pub markdown: String,
    pub items: Vec<BriefItem>,
    pub generated_at: DateTime<Utc>,
    /// Written by a model; otherwise the markdown is the plain list of facts.
    pub ai: bool,
}

// ---- tasks and notes ----------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
#[ts(rename = "PersonalTaskPriority")]
pub enum TaskPriority {
    #[default]
    None,
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
#[ts(rename = "PersonalTask")]
pub struct Task {
    pub id: Uuid,
    pub title: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub done: bool,
    /// Local date, `YYYY-MM-DD`.
    #[serde(default)]
    pub due: Option<String>,
    #[serde(default)]
    pub priority: TaskPriority,
    #[serde(default)]
    pub workspace_id: Option<Uuid>,
    #[serde(default)]
    pub thread_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub done_at: Option<DateTime<Utc>>,
    /// Position within its group; lower comes first.
    #[serde(default)]
    pub sort: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
#[ts(rename = "PersonalNewTask")]
pub struct NewTask {
    pub title: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub due: Option<String>,
    #[serde(default)]
    pub priority: Option<TaskPriority>,
    #[serde(default)]
    pub workspace_id: Option<Uuid>,
    #[serde(default)]
    pub thread_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
#[ts(rename = "PersonalNoteMeta")]
pub struct NoteMeta {
    pub id: String,
    pub title: String,
    /// First line of the body, for the list.
    pub excerpt: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
#[ts(rename = "PersonalNote")]
pub struct Note {
    pub id: String,
    pub title: String,
    pub text: String,
    pub updated_at: DateTime<Utc>,
}

// ---- costs and budgets ----------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct CostRow {
    /// Lead id, model id, person name, …; empty for "none".
    pub key: String,
    pub label: String,
    pub cost_usd: f64,
    pub turns: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct CostDay {
    /// Local date, `YYYY-MM-DD`.
    pub date: String,
    pub cost_usd: f64,
    pub turns: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct CostThread {
    pub thread_id: Uuid,
    pub workspace_id: Uuid,
    pub title: String,
    pub cost_usd: f64,
    pub turns: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct CostSummary {
    pub workspace_id: Option<Uuid>,
    pub days: u32,
    pub since: DateTime<Utc>,
    pub total_usd: f64,
    pub turns: u32,
    /// Turns whose harness reported no cost (subscriptions, local models).
    pub unknown_turns: u32,
    /// One entry per day of the period, oldest first, zero days included.
    pub per_day: Vec<CostDay>,
    pub per_lead: Vec<CostRow>,
    /// `harness · model`.
    pub per_model: Vec<CostRow>,
    /// Who sent the message that started each turn.
    pub per_person: Vec<CostRow>,
    pub top_threads: Vec<CostThread>,
    pub budgets: Vec<BudgetStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum BudgetScope {
    Workspace,
    #[serde(alias = "captain")]
    Lead,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct Budget {
    pub workspace_id: Uuid,
    pub scope: BudgetScope,
    /// The lead, for a lead budget.
    pub id: Option<Uuid>,
    pub monthly_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct BudgetStatus {
    pub budget: Budget,
    /// Workspace or lead name.
    pub label: String,
    /// Spent this calendar month (local time).
    pub spent_usd: f64,
}

// ---- replay -------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum ReplayKind {
    Message,
    Reply,
    Tool,
    Approval,
    Error,
    Turn,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct ReplayStep {
    #[ts(type = "number")]
    pub seq: u64,
    pub at: DateTime<Utc>,
    /// Since the first event.
    #[ts(type = "number")]
    pub offset_ms: i64,
    /// Since the previous step.
    #[ts(type = "number")]
    pub gap_ms: i64,
    /// How long this step took: a tool until its result, an approval until answered.
    #[ts(type = "number | null")]
    pub duration_ms: Option<i64>,
    pub kind: ReplayKind,
    pub label: String,
    pub event: ThreadEvent,
    /// A tool's result, or who answered an approval.
    pub output: Option<String>,
    pub is_error: bool,
    /// Cost of all turns finished up to and including this step.
    pub cost_so_far: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct Replay {
    pub thread_id: Uuid,
    pub title: String,
    pub started_at: Option<DateTime<Utc>>,
    #[ts(type = "number")]
    pub total_ms: i64,
    pub total_cost: f64,
    pub steps: Vec<ReplayStep>,
}

// ---- evals ----------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum EvalCheck {
    /// The reply contains `expected` (case-insensitive).
    Contains,
    NotContains,
    /// The reply matches the regular expression `expected`.
    Regex,
    /// `expected` is a shell command that must exit 0 in the thread's folder.
    CommandExitZero,
    /// A model judges the reply against the criteria in `expected`.
    Judge,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct EvalCase {
    pub prompt: String,
    pub check: EvalCheck,
    pub expected: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct EvalSuite {
    /// Nil to create.
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub name: String,
    pub cases: Vec<EvalCase>,
    #[serde(default = "Utc::now")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct EvalTarget {
    pub harness: HarnessKind,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum EvalStatus {
    Pending,
    Running,
    Passed,
    Failed,
    /// The run could not finish: the agent failed, timed out or the check could not run.
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct EvalResult {
    pub case_index: u32,
    pub target_index: u32,
    pub thread_id: Option<Uuid>,
    pub status: EvalStatus,
    pub reason: Option<String>,
    #[ts(type = "number | null")]
    pub duration_ms: Option<u64>,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct EvalRun {
    pub id: Uuid,
    pub suite_id: Uuid,
    pub workspace_id: Uuid,
    pub suite_name: String,
    /// The cases as they were when the run started.
    pub cases: Vec<EvalCase>,
    pub targets: Vec<EvalTarget>,
    pub results: Vec<EvalResult>,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}
