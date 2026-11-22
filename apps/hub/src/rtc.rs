//! Huddles: ICE servers for WebRTC and who is in a workspace's huddle.
//! The media itself flows peer to peer (or through the owner's own TURN server).

use axum::extract::{Path, State};
use axum::Json;
use base64::Engine;
use cuna_protocol::comms::{HuddleState, IceConfig, IceServer};
use cuna_protocol::Role;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::ApiResult;
use crate::workspaces::require_role;
use crate::AppState;

/// TURN credentials stay valid this long.
pub const TURN_TTL_SECS: u64 = 12 * 60 * 60;

/// coturn's REST API scheme (`use-auth-secret`): the username carries its expiry,
/// the credential is `base64(HMAC-SHA1(secret, username))`.
pub fn turn_credential(secret: &str, user: Uuid, now_unix: u64) -> (String, String) {
    let username = format!("{}:{user}", now_unix + TURN_TTL_SECS);
    let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key");
    mac.update(username.as_bytes());
    let credential = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
    (username, credential)
}

/// `GET /ice`: what to put in `RTCConfiguration.iceServers`.
pub async fn ice(State(st): State<AppState>, auth: AuthUser) -> Json<IceConfig> {
    let mut servers = Vec::new();
    if !st.config.stun_urls.is_empty() {
        servers.push(IceServer {
            urls: st.config.stun_urls.clone(),
            username: None,
            credential: None,
        });
    }
    if let (Some(secret), false) = (&st.config.turn_secret, st.config.turn_urls.is_empty()) {
        let now = chrono::Utc::now().timestamp().max(0) as u64;
        let (username, credential) = turn_credential(secret, auth.user.id, now);
        servers.push(IceServer {
            urls: st.config.turn_urls.clone(),
            username: Some(username),
            credential: Some(credential),
        });
    }
    Json(IceConfig {
        ice_servers: servers,
        ttl: TURN_TTL_SECS,
    })
}

/// `GET /workspaces/:id/huddle`: who is in it right now.
pub async fn huddle(
    State(st): State<AppState>,
    auth: AuthUser,
    Path(ws): Path<Uuid>,
) -> ApiResult<Json<HuddleState>> {
    require_role(&st, ws, auth.user.id, Role::Viewer).await?;
    Ok(Json(st.hub.huddle(ws)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coturn_credentials() {
        let user = Uuid::nil();
        let (name, cred) = turn_credential("north", user, 1_700_000_000);
        assert_eq!(name, format!("{}:{user}", 1_700_000_000 + TURN_TTL_SECS));
        // Same scheme as coturn's turnutils / the RFC draft: verify independently.
        let mut mac = Hmac::<Sha1>::new_from_slice(b"north").unwrap();
        mac.update(name.as_bytes());
        mac.verify_slice(
            &base64::engine::general_purpose::STANDARD
                .decode(&cred)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(cred.len(), 28);
    }
}
