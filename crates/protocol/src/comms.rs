//! Communication: chat channels and threads, huddles, ICE servers.
//!
//! Owned by one feature area; types here derive `TS` and export next to the others.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::HubUser;

/// A chat channel of a shared workspace. `general` always exists.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct ChatChannel {
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub created_by: Option<Uuid>,
}

/// How many replies a message has, for the "3 replies" line under it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct ReplySummary {
    pub parent: Uuid,
    pub count: u32,
    pub last_at: DateTime<Utc>,
    /// Distinct reply authors, most recent first (at most 5).
    pub authors: Vec<HubUser>,
}

/// Who is in a workspace's huddle right now (`GET /workspaces/:id/huddle`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct HuddleState {
    pub workspace_id: Uuid,
    pub participants: Vec<HubUser>,
    pub since: Option<DateTime<Utc>>,
}

/// Payload of a huddle `state` signal: what a participant shares.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct HuddleMedia {
    pub muted: bool,
    pub camera: bool,
    pub screen: bool,
}

/// One entry of `RTCConfiguration.iceServers`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub credential: Option<String>,
}

/// `GET /ice`: STUN always, TURN when the hub has a coturn secret.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct IceConfig {
    #[serde(rename = "iceServers")]
    pub ice_servers: Vec<IceServer>,
    /// Seconds the TURN credentials stay valid.
    #[ts(type = "number")]
    pub ttl: u64,
}
