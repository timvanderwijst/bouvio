//! Office: docs, sheets, slides, databases, calendar and forms, with live collaboration.

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
