//! Knowledge: search, imports, web clips, MCP and skills catalog.
//!
//! Owned by one feature area; types here derive `TS` and export next to the others.

#[allow(unused_imports)]
use chrono::{DateTime, Utc};
#[allow(unused_imports)]
use serde::{Deserialize, Serialize};
#[allow(unused_imports)]
use ts_rs::TS;
#[allow(unused_imports)]
use uuid::Uuid;

// ---- search -------------------------------------------------------------------------

/// Where a search result lives, so the UI can open it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum SearchLocation {
    Thread {
        thread_id: Uuid,
    },
    Issue {
        issue_id: Uuid,
    },
    /// A file in the workspace folder, relative to its root.
    File {
        path: String,
    },
    /// A file agents made or someone imported; `path` is absolute on the runner.
    Artifact {
        artifact_id: Uuid,
        path: String,
    },
    /// Something another area indexed: a doc, a sheet, a note.
    Doc {
        kind: String,
        id: String,
    },
}

/// A piece of the matching text with the matched words marked.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct SearchSnippet {
    pub text: String,
    /// `[start, end)` in UTF-16 code units of `text`, ready for JavaScript slicing.
    pub highlights: Vec<(u32, u32)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct SearchHit {
    /// `thread`, `issue`, `file`, `artifact`, or a kind another area indexed (`doc`, `sheet`, …).
    pub kind: String,
    pub id: String,
    pub title: String,
    pub snippet: SearchSnippet,
    /// Fused rank score; higher is better. Only meaningful within one result list.
    pub score: f32,
    pub workspace_id: Uuid,
    pub location: SearchLocation,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct KnowledgeIndexStatus {
    pub workspace_id: Uuid,
    /// Items in the keyword index.
    pub docs: u32,
    /// Text chunks with an embedding.
    pub vectors: u32,
    /// Items still waiting for an embedding.
    pub pending: u32,
    /// Whether an embedding model is plugged in.
    pub semantic: bool,
    pub last_scan: Option<DateTime<Utc>>,
}

// ---- MCP catalogue -----------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct McpEnvVar {
    pub name: String,
    pub description: Option<String>,
    pub required: bool,
    pub secret: bool,
    pub default: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct McpCatalogEntry {
    /// Registry name, e.g. `io.github.owner/server`.
    pub name: String,
    /// Short name to install it under, e.g. `server`.
    pub short_name: String,
    pub description: String,
    pub version: Option<String>,
    pub repository: Option<String>,
    /// How it runs: `npx`, `uvx` or `docker`; none for servers we cannot start locally.
    pub runtime: Option<String>,
    pub command: Option<String>,
    pub args: Vec<String>,
    /// Environment the server reads; the user fills these in when installing.
    pub env: Vec<McpEnvVar>,
}

// ---- skills catalogue -------------------------------------------------------------

/// A skill folder on GitHub.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct SkillSource {
    /// `owner/repo`
    pub repo: String,
    /// Folder inside the repo that holds `SKILL.md`.
    pub path: String,
    /// Branch, tag or commit; `HEAD` for the default branch.
    pub git_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct SkillEntry {
    pub name: String,
    pub description: String,
    pub source: SkillSource,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct InstalledSkill {
    pub name: String,
    pub description: String,
    /// Folder on the runner, under `<root>/.claude/skills/`.
    pub path: String,
}
