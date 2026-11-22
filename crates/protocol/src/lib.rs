//! Shared types between the Cuna desktop app, the runner and (later) the hub.
//!
//! Every type derives `ts_rs::TS`, so `cargo test -p cuna-protocol` writes
//! matching TypeScript to `apps/desktop/src/protocol/`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

// Each feature area keeps its own types in its own file.
pub mod comms;
pub mod dev;
pub mod knowledge;
pub mod local;
pub mod office;
pub mod personal;
pub mod platform;

/// A CLI agent (or our own API loop) that actually runs a thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum HarnessKind {
    ClaudeCode,
    Codex,
    OpenCode,
    GeminiCli,
    /// Cuna's own agent loop for API keys and OpenRouter (phase 2).
    Api,
}

impl HarnessKind {
    pub const ALL: [HarnessKind; 5] = [
        HarnessKind::ClaudeCode,
        HarnessKind::Codex,
        HarnessKind::OpenCode,
        HarnessKind::GeminiCli,
        HarnessKind::Api,
    ];

    /// Executable the runner looks for on PATH, if this harness is a CLI.
    pub fn binary(self) -> Option<&'static str> {
        match self {
            HarnessKind::ClaudeCode => Some("claude"),
            HarnessKind::Codex => Some("codex"),
            HarnessKind::OpenCode => Some("opencode"),
            HarnessKind::GeminiCli => Some("gemini"),
            HarnessKind::Api => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct HarnessInfo {
    pub kind: HarnessKind,
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

/// Agent state, as Herdr tracks it per pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum AgentStatus {
    Working,
    /// Waiting on a person: an approval, a question.
    Blocked,
    Idle,
    Done,
    Error,
}

/// How much an agent may do without asking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum ApprovalLevel {
    AskAll,
    AskRisky,
    Free,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum Effort {
    Low,
    Medium,
    High,
    Max,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum WorkspaceKind {
    /// Lives only on this machine, no account, no hub.
    Personal,
    /// Synced through a hub with other people (phase 3).
    Shared,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct Workspace {
    pub id: Uuid,
    pub name: String,
    pub kind: WorkspaceKind,
    /// Folder on the runner; usually a git repo, but not required.
    pub root: Option<String>,
    pub created_at: DateTime<Utc>,
    /// Set for a shared workspace someone else hosts: what I may do in it.
    #[serde(default)]
    pub role: Option<Role>,
    /// Hub user that hosts the runner for a shared workspace.
    #[serde(default)]
    pub host: Option<HubUser>,
}

/// A long-lived agent for one domain, that splits work into threads.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct Lead {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub name: String,
    pub instructions: String,
    pub harness: HarnessKind,
    pub model: Option<String>,
    pub effort: Effort,
    pub approval: ApprovalLevel,
    /// Seed for the pixel avatar.
    pub avatar_seed: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct Thread {
    pub id: Uuid,
    pub workspace_id: Uuid,
    #[serde(alias = "captain_id")]
    pub lead_id: Option<Uuid>,
    pub title: String,
    pub harness: HarnessKind,
    pub model: Option<String>,
    pub effort: Effort,
    pub approval: ApprovalLevel,
    pub status: AgentStatus,
    /// Where the agent works: the workspace root, or its own worktree.
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub cost_usd: f64,
    /// Harness-side session id, used to resume after a restart.
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum ThreadEvent {
    Status { status: AgentStatus },
    UserMessage { text: String, author: String },
    AssistantText { text: String },
    ToolUse { id: String, name: String, input: serde_json::Value },
    ToolResult { tool_use_id: String, output: String, is_error: bool },
    TurnComplete {
        #[ts(type = "number")]
        duration_ms: u64,
        cost_usd: Option<f64>,
    },
    Error { message: String },
    /// The agent wants to do something that needs a person's yes.
    ApprovalRequest { id: String, tool: String, input: serde_json::Value },
    ApprovalResolved { id: String, allowed: bool, by: String },
    /// This thread started another thread (a lead splitting work).
    ThreadSpawned { thread_id: Uuid, title: String },
    /// A file the agent made that is worth showing: html, image, document.
    ArtifactCreated { artifact: Artifact },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct ThreadEnvelope {
    pub thread_id: Uuid,
    #[ts(type = "number")]
    pub seq: u64,
    pub at: DateTime<Utc>,
    pub event: ThreadEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct NewThread {
    pub workspace_id: Uuid,
    #[serde(alias = "captain_id")]
    pub lead_id: Option<Uuid>,
    pub title: Option<String>,
    pub harness: HarnessKind,
    pub model: Option<String>,
    pub effort: Effort,
    pub approval: ApprovalLevel,
    /// Give the thread its own git worktree and branch.
    pub isolate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct NewLead {
    pub workspace_id: Uuid,
    pub name: String,
    pub instructions: String,
    pub harness: HarnessKind,
    pub model: Option<String>,
    pub effort: Effort,
    pub approval: ApprovalLevel,
}

/// Output of a terminal session, streamed to the UI.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct TerminalChunk {
    pub terminal_id: Uuid,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct TerminalExit {
    pub terminal_id: Uuid,
    pub code: Option<u32>,
}

// ---- providers & keys ---------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum ProviderKind {
    OpenRouter,
    Anthropic,
    OpenAi,
    Google,
    Fal,
    Replicate,
    ElevenLabs,
    /// Models on this machine: Ollama, LM Studio, whisper.cpp, Piper, ComfyUI. No key.
    Local,
}

impl ProviderKind {
    pub const ALL: [ProviderKind; 8] = [
        ProviderKind::OpenRouter,
        ProviderKind::Anthropic,
        ProviderKind::OpenAi,
        ProviderKind::Google,
        ProviderKind::Fal,
        ProviderKind::Replicate,
        ProviderKind::ElevenLabs,
        ProviderKind::Local,
    ];
    pub fn id(self) -> &'static str {
        match self {
            ProviderKind::OpenRouter => "openrouter",
            ProviderKind::Anthropic => "anthropic",
            ProviderKind::OpenAi => "openai",
            ProviderKind::Google => "google",
            ProviderKind::Fal => "fal",
            ProviderKind::Replicate => "replicate",
            ProviderKind::ElevenLabs => "elevenlabs",
            ProviderKind::Local => "local",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct ProviderInfo {
    pub kind: ProviderKind,
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct ModelInfo {
    /// Provider-qualified id, e.g. `openrouter:anthropic/claude-sonnet-4.5`.
    pub id: String,
    pub name: String,
    pub provider: ProviderKind,
    pub context: Option<u32>,
    /// USD per million tokens.
    pub price_in: Option<f64>,
    pub price_out: Option<f64>,
}

// ---- workspace settings: instructions, memory, MCP, dev server -------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct McpServer {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct WorkspaceSettings {
    /// Read by every agent in the workspace.
    pub instructions: String,
    /// Facts agents and people keep for later; editable.
    pub memory: String,
    pub mcp_servers: Vec<McpServer>,
    /// Command that starts the app for live frames, e.g. `pnpm dev --port {port}`.
    pub dev_command: Option<String>,
    /// Prefix for issue keys, e.g. `BOU`.
    pub issue_prefix: String,
    /// `owner/repo` on GitHub for issue and PR sync.
    pub github_repo: Option<String>,
}

// ---- issues, pull requests, automations ----------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum IssueStatus {
    Backlog,
    Todo,
    InProgress,
    Done,
    Canceled,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct Issue {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub number: u32,
    /// `CUN-12`
    pub key: String,
    pub title: String,
    pub body: String,
    pub status: IssueStatus,
    pub assignee: Option<String>,
    #[serde(alias = "captain_id")]
    pub lead_id: Option<Uuid>,
    pub thread_ids: Vec<Uuid>,
    pub github_number: Option<u32>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct PullRequest {
    pub number: u32,
    pub title: String,
    pub url: String,
    pub head: String,
    pub base: String,
    pub state: String,
    pub draft: bool,
    pub author: String,
    pub additions: u32,
    pub deletions: u32,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct Automation {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub name: String,
    /// Five-field cron, local time.
    pub schedule: String,
    pub prompt: String,
    #[serde(alias = "captain_id")]
    pub lead_id: Option<Uuid>,
    pub enabled: bool,
    pub last_run: Option<DateTime<Utc>>,
    pub last_thread: Option<Uuid>,
}

// ---- studio: artifacts and boards ------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum ArtifactKind {
    Html,
    Markdown,
    Image,
    Svg,
    Video,
    Audio,
    Pdf,
    Data,
    Code,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct Artifact {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub thread_id: Option<Uuid>,
    pub kind: ArtifactKind,
    pub title: String,
    /// Absolute path on the runner.
    pub path: String,
    #[ts(type = "number")]
    pub size: u64,
    pub created_at: DateTime<Utc>,
    /// For generated media: the prompt and model that made it.
    pub prompt: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct Board {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// The canvas document, owned by the canvas component.
    pub doc: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct DevServer {
    pub thread_id: Uuid,
    pub url: String,
    pub port: u16,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    #[ts(type = "number")]
    pub size: u64,
}

// ---- hub: people, sharing, chat ----------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum Role {
    Viewer,
    Commenter,
    Prompter,
    Operator,
    Admin,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct HubUser {
    pub id: Uuid,
    pub name: String,
    pub email: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct Member {
    pub user: HubUser,
    pub role: Role,
    /// May see what the owner's keys cost.
    pub see_costs: bool,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct ChatMessage {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub channel: String,
    pub author: HubUser,
    pub text: String,
    pub at: DateTime<Utc>,
    /// Reply in a thread under this message.
    #[serde(default)]
    pub parent: Option<Uuid>,
    /// Emoji → user ids who reacted with it.
    #[serde(default)]
    pub reactions: Vec<(String, Vec<Uuid>)>,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct Presence {
    pub workspace_id: Uuid,
    pub user: HubUser,
    /// What they look at: a thread id, a board id, or nothing.
    pub viewing: Option<String>,
    /// Pointer on a board, in board coordinates.
    pub cursor: Option<(f64, f64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct HubStatus {
    pub url: Option<String>,
    pub user: Option<HubUser>,
    pub connected: bool,
}

// ---- hub wire protocol (WebSocket, JSON) --------------------------------------
//
// Users and runners both connect to `/ws?token=…`. A shared workspace is hosted
// by one runner; the hub relays RPCs from members to that runner (after checking
// their role) and fans the runner's events out to every member.

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "t", rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum ClientMsg {
    /// A runner says which shared workspaces it serves.
    Host { workspace_ids: Vec<Uuid> },
    /// Member -> hub -> hosting runner.
    Rpc { id: u64, workspace_id: Uuid, method: String, params: serde_json::Value },
    /// Runner -> hub -> the member that asked.
    RpcResult { id: u64, ok: Option<serde_json::Value>, err: Option<String> },
    /// Runner -> hub -> every member: `thread-event`, `thread-changed`, `terminal-chunk`, …
    Publish { workspace_id: Uuid, kind: String, payload: serde_json::Value },
    Chat { workspace_id: Uuid, channel: String, text: String },
    Presence { workspace_id: Uuid, viewing: Option<String>, cursor: Option<(f64, f64)> },
    /// A reply in a chat thread.
    ChatReply { workspace_id: Uuid, parent: Uuid, text: String },
    React { workspace_id: Uuid, message_id: Uuid, emoji: String },
    Pin { workspace_id: Uuid, message_id: Uuid, pinned: bool },
    /// Peer-to-peer signalling for huddles (WebRTC offers, answers, ICE), relayed
    /// to one member (`to`) or to everyone in the workspace.
    Signal { workspace_id: Uuid, to: Option<Uuid>, kind: String, payload: serde_json::Value },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "t", rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum ServerMsg {
    Welcome { user: HubUser },
    /// To a hosting runner: a member's request, with who asked and their role.
    Rpc { id: u64, workspace_id: Uuid, method: String, params: serde_json::Value, from: HubUser, role: Role },
    RpcResult { id: u64, ok: Option<serde_json::Value>, err: Option<String> },
    Event { workspace_id: Uuid, kind: String, payload: serde_json::Value },
    Chat { message: ChatMessage },
    /// A message changed: reactions, pin.
    ChatUpdated { message: ChatMessage },
    Signal { workspace_id: Uuid, from: HubUser, kind: String, payload: serde_json::Value },
    Presence { presence: Presence, online: bool },
    /// The runner hosting a workspace came online or went away.
    HostStatus { workspace_id: Uuid, online: bool },
    Error { message: String },
}

/// Lowest role that may call a runner method through the hub.
///
/// Reading is open to viewers by naming convention (`list_*`, `get_*`, `read_*`,
/// `search*`); everything not named here needs an operator.
pub fn required_role(method: &str) -> Role {
    match method {
        "thread_events" | "thread_diff" | "workspace_settings" | "dev_servers" | "git_graph" | "ci_runs" | "thread_replay" | "cost_summary" => Role::Viewer,
        // Databases on the host's machine: not for every viewer.
        "list_db_connections" | "list_db_tables" | "get_db_rows" => Role::Operator,
        m if m.starts_with("list_") || m.starts_with("get_") || m.starts_with("read_") || m.starts_with("search") => Role::Viewer,
        "update_board" | "doc_update" | "doc_awareness" | "add_review_comment" | "resolve_review_comment" | "form_submit" => Role::Commenter,
        "send_message" => Role::Prompter,
        "workspace_settings_set" | "install_mcp" | "remove_mcp" | "create_automation" | "update_automation" | "delete_automation" | "export_workspace" | "set_budget" => Role::Admin,
        _ => Role::Operator,
    }
}
