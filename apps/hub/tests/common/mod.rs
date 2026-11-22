//! Shared helpers: a real hub on a random port with a temporary SQLite file.
#![allow(dead_code)]

use std::time::Duration;

use cuna_protocol::{ClientMsg, ServerMsg};
use futures_util::{SinkExt, StreamExt};
pub use reqwest::StatusCode;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

pub struct Hub {
    pub base: String,
    pub http: reqwest::Client,
    pub dir: tempfile::TempDir,
}

impl Hub {
    pub async fn start() -> Hub {
        Self::start_with(|_| {}).await
    }

    /// Starts a hub after `tweak` adjusts its configuration.
    pub async fn start_with(tweak: impl FnOnce(&mut cuna_hub::Config)) -> Hub {
        let dir = tempfile::tempdir().unwrap();
        let mut config =
            cuna_hub::Config::for_tests(format!("sqlite://{}/hub.db", dir.path().display()));
        tweak(&mut config);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { cuna_hub::serve(config, listener).await.unwrap() });
        let http = reqwest::Client::new();
        for _ in 0..100 {
            if let Ok(r) = http.get(format!("{base}/health")).send().await {
                assert_eq!(r.text().await.unwrap(), "ok");
                return Hub { base, http, dir };
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("hub did not start");
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    /// Signs in by email and returns `(token, user)`.
    pub async fn login(&self, email: &str) -> (String, Value) {
        let started: Value = self
            .http
            .post(self.url("/auth/email/start"))
            .json(&json!({ "email": email }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let code = started["code"].as_str().expect("dev code in response");
        let res: Value = self
            .http
            .post(self.url("/auth/email/verify"))
            .json(&json!({ "email": email, "code": code }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        (
            res["token"].as_str().unwrap().to_string(),
            res["user"].clone(),
        )
    }

    pub async fn get(&self, token: &str, path: &str) -> (StatusCode, Value) {
        let r = self
            .http
            .get(self.url(path))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        let status = r.status();
        (status, r.json().await.unwrap_or(Value::Null))
    }

    pub async fn send(
        &self,
        method: reqwest::Method,
        token: &str,
        path: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let r = self
            .http
            .request(method, self.url(path))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = r.status();
        (status, r.json().await.unwrap_or(Value::Null))
    }

    pub async fn post(&self, token: &str, path: &str, body: Value) -> (StatusCode, Value) {
        self.send(reqwest::Method::POST, token, path, body).await
    }

    pub async fn connect(&self, token: &str) -> Client {
        let url = format!("{}/ws?token={token}", self.base.replace("http://", "ws://"));
        let (ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        let mut client = Client { ws };
        assert!(matches!(client.recv().await, ServerMsg::Welcome { .. }));
        client
    }
}

pub struct Client {
    pub ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl Client {
    pub async fn send(&mut self, msg: ClientMsg) {
        self.ws
            .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
            .await
            .unwrap();
    }

    pub async fn recv(&mut self) -> ServerMsg {
        self.try_recv(Duration::from_secs(5))
            .await
            .expect("expected a message from the hub")
    }

    pub async fn try_recv(&mut self, wait: Duration) -> Option<ServerMsg> {
        loop {
            let msg = tokio::time::timeout(wait, self.ws.next())
                .await
                .ok()??
                .unwrap();
            if let Message::Text(t) = msg {
                return Some(serde_json::from_str(&t).unwrap());
            }
        }
    }

    /// The next message that matches, skipping others (presence, host status).
    pub async fn recv_where(&mut self, pred: impl Fn(&ServerMsg) -> bool) -> ServerMsg {
        loop {
            let m = self.recv().await;
            if pred(&m) {
                return m;
            }
        }
    }

    pub async fn assert_silent(&mut self) {
        if let Some(m) = self.try_recv(Duration::from_millis(200)).await {
            panic!("unexpected message: {m:?}");
        }
    }
}

pub fn uid(v: &Value) -> Uuid {
    v["id"].as_str().unwrap().parse().unwrap()
}

impl Hub {
    /// A workspace hosted by `owner`, with `others` joined at the given roles.
    pub async fn workspace(&self, owner: &str, others: &[(&str, &str)]) -> Uuid {
        let ws = Uuid::new_v4();
        let (status, _) = self
            .post(owner, "/workspaces", json!({ "id": ws, "name": "Acme" }))
            .await;
        assert_eq!(status, StatusCode::CREATED);
        for (token, role) in others {
            let (_, invite) = self
                .post(
                    owner,
                    &format!("/workspaces/{ws}/invites"),
                    json!({ "role": role }),
                )
                .await;
            let code = invite["code"].as_str().unwrap();
            let (status, _) = self
                .post(token, &format!("/invites/{code}/accept"), json!({}))
                .await;
            assert_eq!(status, StatusCode::OK);
        }
        ws
    }
}
