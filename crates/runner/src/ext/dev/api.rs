//! API client: requests run in the runner (no CORS), saved per workspace,
//! with environments of `{{variables}}` and a short history.

use super::dev_dir;
use crate::{store, Runner};
use anyhow::{bail, Context, Result};
use base64::Engine;
use bouvio_protocol::dev::*;
use chrono::Utc;
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use uuid::Uuid;

const HISTORY: usize = 50;
/// Responses bigger than this are cut, so a large download cannot fill memory.
const BODY_CAP: usize = 10 * 1024 * 1024;

fn file(r: &Runner, ws: Uuid) -> PathBuf {
    dev_dir(r, ws).join("api.json")
}

pub fn load(r: &Runner, ws: Uuid) -> ApiCollection {
    store::load(&file(r, ws)).unwrap_or_default()
}

fn put(r: &Runner, ws: Uuid, c: &ApiCollection) -> Result<()> {
    store::save(&file(r, ws), c)?;
    r.notice(ws, "dev-api", json!({}));
    Ok(())
}

pub fn save_request(r: &Runner, ws: Uuid, mut req: ApiRequest) -> Result<ApiRequest> {
    let mut c = load(r, ws);
    if req.id.is_nil() {
        req.id = Uuid::new_v4();
    }
    if req.name.trim().is_empty() {
        req.name = format!("{} {}", req.method, req.url);
    }
    match c.requests.iter_mut().find(|x| x.id == req.id) {
        Some(slot) => *slot = req.clone(),
        None => c.requests.push(req.clone()),
    }
    put(r, ws, &c)?;
    Ok(req)
}

pub fn delete_request(r: &Runner, ws: Uuid, id: Uuid) -> Result<()> {
    let mut c = load(r, ws);
    c.requests.retain(|x| x.id != id);
    put(r, ws, &c)
}

pub fn save_environments(r: &Runner, ws: Uuid, mut envs: Vec<ApiEnvironment>, active: Option<Uuid>) -> Result<ApiCollection> {
    for e in &mut envs {
        if e.id.is_nil() {
            e.id = Uuid::new_v4();
        }
    }
    let mut c = load(r, ws);
    c.active_env = active.filter(|a| envs.iter().any(|e| e.id == *a));
    c.environments = envs;
    put(r, ws, &c)?;
    Ok(c)
}

pub fn clear_history(r: &Runner, ws: Uuid) -> Result<()> {
    let mut c = load(r, ws);
    c.history.clear();
    put(r, ws, &c)
}

/// Replace `{{name}}` with the environment's value; unknown names stay as written.
pub fn substitute(s: &str, vars: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) => {
                let key = after[..end].trim();
                match vars.get(key) {
                    Some(v) => out.push_str(v),
                    None => out.push_str(&rest[start..start + 2 + end + 2]),
                }
                rest = &after[end + 2..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

pub struct Outgoing {
    pub method: String,
    pub url: String,
    pub headers: Vec<HttpHeader>,
    pub body: String,
    pub timeout_ms: Option<u64>,
}

fn texty(content_type: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    ct.is_empty() || ct.starts_with("text/") || ["json", "xml", "javascript", "x-www-form-urlencoded", "graphql", "yaml", "csv", "html"].iter().any(|k| ct.contains(k))
}

/// Send one request and describe the response.
pub async fn send(req: &Outgoing) -> Result<HttpResponse> {
    let method = reqwest::Method::from_bytes(req.method.trim().to_ascii_uppercase().as_bytes()).context("unknown method")?;
    let url = req.url.trim();
    let url = if url.contains("://") { url.to_string() } else { format!("http://{url}") };
    let parsed = reqwest::Url::parse(&url).context("not a valid URL")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        bail!("only http and https URLs");
    }
    let mut client = reqwest::Client::builder();
    // A local dev API never goes through the system proxy.
    if matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1")) {
        client = client.no_proxy();
    }
    let client = client
        .timeout(Duration::from_millis(req.timeout_ms.unwrap_or(30_000).clamp(100, 600_000)))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()?;
    let mut b = client.request(method, parsed);
    for h in req.headers.iter().filter(|h| h.enabled && !h.name.trim().is_empty()) {
        b = b.header(h.name.trim(), h.value.as_str());
    }
    if !req.body.is_empty() {
        b = b.body(req.body.clone());
    }
    let started = Instant::now();
    let mut resp = b.send().await.map_err(|e| anyhow::anyhow!(describe(&e)))?;
    let status = resp.status();
    let final_url = resp.url().to_string();
    let headers: Vec<HttpHeader> = resp
        .headers()
        .iter()
        .map(|(k, v)| HttpHeader { name: k.as_str().to_string(), value: String::from_utf8_lossy(v.as_bytes()).into_owned(), enabled: true })
        .collect();
    let content_type = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let mut bytes = Vec::new();
    let mut size = 0u64;
    while let Some(chunk) = resp.chunk().await.map_err(|e| anyhow::anyhow!(describe(&e)))? {
        size += chunk.len() as u64;
        if bytes.len() < BODY_CAP {
            bytes.extend_from_slice(&chunk[..chunk.len().min(BODY_CAP - bytes.len())]);
        }
    }
    let time_ms = started.elapsed().as_millis() as u64;
    let (body, base64) = match String::from_utf8(bytes) {
        Ok(s) if texty(&content_type) => (s, false),
        Ok(s) => (base64::engine::general_purpose::STANDARD.encode(s.as_bytes()), true),
        Err(e) => (base64::engine::general_purpose::STANDARD.encode(e.as_bytes()), true),
    };
    Ok(HttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        body,
        base64,
        time_ms,
        size,
        url: final_url,
    })
}

fn describe(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "the request timed out".into()
    } else if e.is_connect() {
        format!("could not connect: {}", std::error::Error::source(e).map(|s| s.to_string()).unwrap_or_else(|| e.to_string()))
    } else {
        e.to_string()
    }
}

/// `http_request`: fill in variables from the workspace's active (or chosen)
/// environment, send, and keep it in the history.
pub async fn http_request(r: &Runner, ws: Option<Uuid>, env: Option<Uuid>, req: Outgoing, name: Option<String>) -> Result<HttpResponse> {
    let Some(ws) = ws else { return send(&req).await };
    let c = load(r, ws);
    let vars: HashMap<String, String> = env
        .or(c.active_env)
        .and_then(|id| c.environments.iter().find(|e| e.id == id))
        .map(|e| e.variables.iter().map(|v| (v.key.trim().to_string(), v.value.clone())).collect())
        .unwrap_or_default();
    let filled = Outgoing {
        method: req.method.clone(),
        url: substitute(&req.url, &vars),
        headers: req.headers.iter().map(|h| HttpHeader { name: substitute(&h.name, &vars), value: substitute(&h.value, &vars), enabled: h.enabled }).collect(),
        body: substitute(&req.body, &vars),
        timeout_ms: req.timeout_ms,
    };
    let res = send(&filled).await;
    let entry = ApiHistoryEntry {
        id: Uuid::new_v4(),
        at: Utc::now(),
        request: ApiRequest { id: Uuid::nil(), name: name.unwrap_or_default(), method: req.method, url: req.url, headers: req.headers, body: req.body },
        status: res.as_ref().ok().map(|x| x.status),
        time_ms: res.as_ref().map(|x| x.time_ms).unwrap_or(0),
        size: res.as_ref().map(|x| x.size).unwrap_or(0),
    };
    let mut c = load(r, ws);
    c.history.insert(0, entry);
    c.history.truncate(HISTORY);
    put(r, ws, &c)?;
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::{get, post};

    #[test]
    fn substitutes_variables() {
        let vars: HashMap<String, String> = [("base_url".to_string(), "http://x".to_string()), ("token".into(), "abc".into())].into();
        assert_eq!(substitute("{{base_url}}/users?t={{ token }}", &vars), "http://x/users?t=abc");
        assert_eq!(substitute("{{missing}} and {{base_url", &vars), "{{missing}} and {{base_url");
        assert_eq!(substitute("no vars", &vars), "no vars");
    }

    async fn server() -> String {
        let app = axum::Router::new()
            .route("/hello", get(|| async { ([("content-type", "application/json"), ("x-test", "1")], "{\"hi\":true}") }))
            .route(
                "/echo",
                post(|headers: axum::http::HeaderMap, body: String| async move {
                    format!("{}:{}", headers.get("x-token").and_then(|v| v.to_str().ok()).unwrap_or(""), body)
                }),
            )
            .route("/png", get(|| async { ([("content-type", "image/png")], vec![0x89u8, 0x50, 0x4e, 0x47, 0xff]) }))
            .route("/slow", get(|| async {
                tokio::time::sleep(Duration::from_secs(3)).await;
                "late"
            }));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        format!("http://{addr}")
    }

    fn out(method: &str, url: String) -> Outgoing {
        Outgoing { method: method.into(), url, headers: vec![], body: String::new(), timeout_ms: None }
    }

    #[tokio::test]
    async fn requests_against_a_local_server() {
        let base = server().await;

        let r = send(&out("GET", format!("{base}/hello"))).await.unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, "{\"hi\":true}");
        assert!(!r.base64);
        assert_eq!(r.size, 11);
        assert!(r.headers.iter().any(|h| h.name == "x-test" && h.value == "1"));

        let r = send(&out("GET", format!("{base}/png"))).await.unwrap();
        assert!(r.base64);
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(&r.body).unwrap(), [0x89, 0x50, 0x4e, 0x47, 0xff]);

        let r = send(&out("GET", format!("{base}/nope"))).await.unwrap();
        assert_eq!(r.status, 404);

        let mut slow = out("GET", format!("{base}/slow"));
        slow.timeout_ms = Some(200);
        assert!(send(&slow).await.unwrap_err().to_string().contains("timed out"));

        // Through a workspace: variables and history.
        let dir = tempfile::tempdir().unwrap();
        let runner = Runner::open(dir.path()).unwrap();
        let ws = runner.create_workspace("Api".into(), None).unwrap().id;
        let env = ApiEnvironment { id: Uuid::nil(), name: "Local".into(), variables: vec![ApiVariable { key: "base_url".into(), value: base.clone() }, ApiVariable { key: "token".into(), value: "s3cret".into() }] };
        let c = save_environments(&runner, ws, vec![env], None).unwrap();
        let env_id = c.environments[0].id;
        save_environments(&runner, ws, c.environments, Some(env_id)).unwrap();

        let req = Outgoing {
            method: "POST".into(),
            url: "{{base_url}}/echo".into(),
            headers: vec![HttpHeader { name: "x-token".into(), value: "{{token}}".into(), enabled: true }, HttpHeader { name: "x-off".into(), value: "1".into(), enabled: false }],
            body: "hello {{token}}".into(),
            timeout_ms: None,
        };
        let r = http_request(&runner, Some(ws), None, req, None).await.unwrap();
        assert_eq!(r.body, "s3cret:hello s3cret");
        let h = load(&runner, ws).history;
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].request.url, "{{base_url}}/echo");
        assert_eq!(h[0].status, Some(200));

        for _ in 0..55 {
            let _ = http_request(&runner, Some(ws), None, out("GET", "{{base_url}}/hello".into()), None).await;
        }
        assert_eq!(load(&runner, ws).history.len(), HISTORY);

        let saved = save_request(&runner, ws, ApiRequest { id: Uuid::nil(), name: String::new(), method: "GET".into(), url: "{{base_url}}/hello".into(), headers: vec![], body: String::new() }).unwrap();
        assert_eq!(saved.name, "GET {{base_url}}/hello");
        delete_request(&runner, ws, saved.id).unwrap();
        assert!(load(&runner, ws).requests.is_empty());
    }
}
