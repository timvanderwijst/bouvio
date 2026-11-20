//! Knowledge: search over everything, imports, web clips, MCP and skills catalog.

use crate::Runner;
use anyhow::Result;
use serde_json::Value;
use std::sync::Arc;
use uuid::Uuid;

pub async fn call(_r: &Arc<Runner>, _method: &str, _params: &Value, _actor: &str) -> Option<Result<Value>> {
    None
}

pub fn workspace_of(_r: &Runner, _method: &str, _params: &Value) -> Option<Result<Uuid>> {
    None
}

pub fn start(_r: &Arc<Runner>) {}

/// Other areas call this when something searchable changes (a doc, a note).
/// `kind` names the source (`doc`, `sheet`, `note`, …); `id` is unique within it.
pub fn index(_r: &Runner, _workspace_id: Uuid, _kind: &str, _id: &str, _title: &str, _text: &str) {}

/// Remove something from the index again.
pub fn unindex(_r: &Runner, _workspace_id: Uuid, _kind: &str, _id: &str) {}
