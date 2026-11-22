//! Platform: web client, updates, plugins, backup and templates.
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

use crate::Workspace;

// ---- workspace templates ---------------------------------------------------------

/// A starting point for a workspace: leads, instructions, issues, automations.
/// Shipped as `templates/*.json` at the repository root.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct WorkspaceTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    /// A lucide icon name in kebab case (`code`, `megaphone`, …).
    pub icon: String,
    /// Workspace instructions every agent reads.
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub dev_command: Option<String>,
    #[serde(default)]
    pub leads: Vec<TemplateLead>,
    #[serde(default)]
    pub issues: Vec<TemplateIssue>,
    #[serde(default)]
    pub automations: Vec<TemplateAutomation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct TemplateLead {
    pub name: String,
    pub instructions: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct TemplateIssue {
    pub title: String,
    #[serde(default)]
    pub body: String,
    /// Name of one of the template's leads.
    #[serde(default)]
    pub lead: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct TemplateAutomation {
    pub name: String,
    /// Five-field cron, local time.
    pub schedule: String,
    pub prompt: String,
    #[serde(default)]
    pub lead: Option<String>,
    #[serde(default)]
    pub enabled: bool,
}

/// What `apply_template` added to a workspace.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct TemplateApplied {
    pub leads: u32,
    pub issues: u32,
    pub automations: u32,
}

// ---- backup ------------------------------------------------------------------------

/// What `export_workspace` wrote.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct ExportSummary {
    pub path: String,
    /// Size of the zip on disk.
    pub bytes: u64,
    pub threads: u32,
    pub artifacts: u32,
    /// Artifact files left out because they would pass the size budget (metadata stays).
    pub artifacts_skipped: u32,
}

/// What `import_workspace` created.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct ImportSummary {
    pub workspace: Workspace,
    pub leads: u32,
    pub threads: u32,
    pub issues: u32,
    pub automations: u32,
    pub artifacts: u32,
}

// ---- plugins -----------------------------------------------------------------------

/// What a plugin may use besides drawing UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum PluginPermission {
    /// Call runner methods (`api.rpc`).
    Rpc,
    /// Talk to the network (`fetch`); declared so people can see it, not enforced.
    Network,
}

/// `~/.cuna/plugins/<id>/plugin.json`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_entry")]
    pub entry: String,
    #[serde(default)]
    pub permissions: Vec<PluginPermission>,
}

fn default_entry() -> String {
    "index.js".into()
}

/// A plugin as the app found it on disk.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct PluginInfo {
    pub manifest: PluginManifest,
    pub enabled: bool,
    pub path: String,
    /// Why the folder could not be read as a plugin, if it could not.
    pub error: Option<String>,
}

/// The app's version and whether this build can update itself.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct AppInfo {
    pub version: String,
    /// False when the build has no updater public key (a placeholder in tauri.conf.json).
    pub updater: bool,
}
