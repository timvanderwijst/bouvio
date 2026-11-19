//! The app's side of the hub: sign-in, the token in the OS keychain, REST
//! calls, and the list of workspaces other people host.

use anyhow::{bail, Context, Result};
use bouvio_protocol::*;
use bouvio_runner::hub::HubClient;
use bouvio_runner::Runner;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

const KEYCHAIN: &str = "bouvio-hub";

#[derive(Default)]
pub struct Hub {
    pub url: Mutex<Option<String>>,
    pub client: Mutex<Option<Arc<HubClient>>>,
    pub user: Mutex<Option<HubUser>>,
    /// Shared workspaces I am a member of but someone else hosts.
    pub remote: Mutex<Vec<Workspace>>,
    http: reqwest::Client,
}

fn config_path(runner: &Runner) -> PathBuf {
    runner.store().dir().join("hub.json")
}

fn token_entry(url: &str) -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(KEYCHAIN, url)?)
}

impl Hub {
    pub fn load(runner: &Runner) -> Self {
        let url = std::fs::read(config_path(runner)).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v["url"].as_str().map(String::from));
        Self { url: Mutex::new(url), ..Default::default() }
    }

    fn token(&self) -> Option<String> {
        let url = self.url.lock().unwrap().clone()?;
        token_entry(&url).ok()?.get_password().ok()
    }

    pub fn status(&self) -> HubStatus {
        let connected = self.client.lock().unwrap().as_ref().is_some_and(|c| c.connected.load(std::sync::atomic::Ordering::SeqCst));
        HubStatus { url: self.url.lock().unwrap().clone(), user: self.user.lock().unwrap().clone(), connected }
    }

    pub fn set_url(&self, runner: &Runner, url: String) -> Result<()> {
        let url = url.trim().trim_end_matches('/').to_string();
        if !url.starts_with("http://") && !url.starts_with("https://") {
            bail!("the hub address starts with https://");
        }
        std::fs::write(config_path(runner), serde_json::to_vec(&json!({ "url": url }))?)?;
        *self.url.lock().unwrap() = Some(url);
        Ok(())
    }

    pub async fn request(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
        let url = self.url.lock().unwrap().clone().context("connect to a hub first")?;
        let m = reqwest::Method::from_bytes(method.as_bytes())?;
        let mut req = self.http.request(m, format!("{url}{path}"));
        if let Some(t) = self.token() {
            req = req.bearer_auth(t);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await.context("cannot reach the hub")?;
        let status = res.status();
        let text = res.text().await?;
        if !status.is_success() {
            let msg = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["error"].as_str().map(String::from)).unwrap_or(text);
            bail!("{msg}");
        }
        Ok(if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::String(text)) })
    }

    /// Store a fresh token from any sign-in path and connect.
    pub async fn signed_in(&self, runner: &Arc<Runner>, v: Value) -> Result<HubUser> {
        let token = v["token"].as_str().context("no token")?.to_string();
        let user: HubUser = serde_json::from_value(v["user"].clone())?;
        let url = self.url.lock().unwrap().clone().context("no hub")?;
        token_entry(&url)?.set_password(&token)?;
        *self.user.lock().unwrap() = Some(user.clone());
        self.connect(runner).await?;
        Ok(user)
    }

    pub async fn connect(&self, runner: &Arc<Runner>) -> Result<()> {
        let (Some(url), Some(token)) = (self.url.lock().unwrap().clone(), self.token()) else { return Ok(()) };
        if self.user.lock().unwrap().is_none() {
            let me: HubUser = serde_json::from_value(self.request("GET", "/me", None).await?)?;
            *self.user.lock().unwrap() = Some(me);
        }
        let client = HubClient::connect(runner.clone(), url, token);
        *self.client.lock().unwrap() = Some(client);
        self.refresh(runner).await?;
        Ok(())
    }

    pub fn logout(&self) -> Result<()> {
        if let Some(url) = self.url.lock().unwrap().clone() {
            let _ = token_entry(&url)?.delete_credential();
        }
        *self.client.lock().unwrap() = None;
        *self.user.lock().unwrap() = None;
        self.remote.lock().unwrap().clear();
        Ok(())
    }

    /// Re-read memberships: workspaces others host become remote workspaces here.
    pub async fn refresh(&self, runner: &Arc<Runner>) -> Result<Vec<Workspace>> {
        let me = self.user.lock().unwrap().clone().context("not signed in")?;
        let list = self.request("GET", "/workspaces", None).await?;
        let mut remote = Vec::new();
        for w in list.as_array().into_iter().flatten() {
            let id: Uuid = serde_json::from_value(w["id"].clone())?;
            let host: HubUser = serde_json::from_value(w["host"].clone())?;
            if host.id == me.id {
                // Mine: make sure the local copy is marked shared.
                if let Some(mut local) = runner.workspace(id) {
                    if local.kind != WorkspaceKind::Shared {
                        local.kind = WorkspaceKind::Shared;
                        runner.put_workspace(local)?;
                    }
                }
                continue;
            }
            remote.push(Workspace {
                id,
                name: w["name"].as_str().unwrap_or("").into(),
                kind: WorkspaceKind::Shared,
                root: None,
                created_at: chrono::Utc::now(),
                role: serde_json::from_value(w["role"].clone()).ok(),
                host: Some(host),
            });
        }
        *self.remote.lock().unwrap() = remote.clone();
        if let Some(c) = self.client.lock().unwrap().clone() {
            c.refresh_hosted(runner);
        }
        Ok(remote)
    }

    pub fn is_remote(&self, ws: Uuid) -> bool {
        self.remote.lock().unwrap().iter().any(|w| w.id == ws)
    }

    pub fn client(&self) -> Result<Arc<HubClient>> {
        self.client.lock().unwrap().clone().context("not connected to a hub")
    }

    /// Share a local workspace: register it on the hub with me as host.
    pub async fn share(&self, runner: &Arc<Runner>, workspace_id: Uuid) -> Result<Workspace> {
        let mut ws = runner.workspace(workspace_id).context("unknown workspace")?;
        self.request("POST", "/workspaces", Some(json!({ "id": ws.id, "name": ws.name }))).await?;
        ws.kind = WorkspaceKind::Shared;
        runner.put_workspace(ws.clone())?;
        if let Some(c) = self.client.lock().unwrap().clone() {
            c.refresh_hosted(runner);
        }
        Ok(ws)
    }
}
