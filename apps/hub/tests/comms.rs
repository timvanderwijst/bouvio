//! Chat threads, reactions, pins, channels, huddle signalling, ICE servers,
//! public forms and the web client, against a real hub.

mod common;

use std::time::Duration;

use bouvio_protocol::{ChatMessage, ClientMsg, ServerMsg};
use common::*;
use serde_json::{json, Value};
use uuid::Uuid;

fn chat_of(m: &ServerMsg) -> Option<&ChatMessage> {
    match m {
        ServerMsg::Chat { message } | ServerMsg::ChatUpdated { message } => Some(message),
        _ => None,
    }
}

async fn error(c: &mut Client) -> String {
    match c.recv_where(|m| matches!(m, ServerMsg::Error { .. })).await {
        ServerMsg::Error { message } => message,
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn threads_reactions_pins_and_channels() {
    let hub = Hub::start().await;
    let (owner, _) = hub.login("owner@example.com").await;
    let (commenter, commenter_user) = hub.login("commenter@example.com").await;
    let (viewer, _) = hub.login("viewer@example.com").await;
    let ws = hub
        .workspace(&owner, &[(&commenter, "commenter"), (&viewer, "viewer")])
        .await;
    let mut a = hub.connect(&owner).await;
    let mut b = hub.connect(&commenter).await;
    let mut v = hub.connect(&viewer).await;
    let is_chat = |m: &ServerMsg| matches!(m, ServerMsg::Chat { .. });
    let is_update = |m: &ServerMsg| matches!(m, ServerMsg::ChatUpdated { .. });

    b.send(ClientMsg::Chat {
        workspace_id: ws,
        channel: "general".into(),
        text: "Who reviews the hub?".into(),
    })
    .await;
    let root = chat_of(&a.recv_where(is_chat).await).unwrap().clone();
    b.recv_where(is_chat).await;
    v.recv_where(is_chat).await;
    assert_eq!(root.parent, None);
    assert!(!root.pinned && root.reactions.is_empty());

    // A reply, and a reply to the reply, both land under the root.
    a.send(ClientMsg::ChatReply {
        workspace_id: ws,
        parent: root.id,
        text: "I do".into(),
    })
    .await;
    let reply = chat_of(&b.recv_where(is_chat).await).unwrap().clone();
    assert_eq!(reply.parent, Some(root.id));
    assert_eq!(reply.channel, "general");
    a.recv_where(is_chat).await;
    b.send(ClientMsg::ChatReply {
        workspace_id: ws,
        parent: reply.id,
        text: "Thanks".into(),
    })
    .await;
    let nested = chat_of(&a.recv_where(is_chat).await).unwrap().clone();
    assert_eq!(nested.parent, Some(root.id));
    b.recv_where(is_chat).await;

    // Viewers may not reply.
    v.send(ClientMsg::ChatReply {
        workspace_id: ws,
        parent: root.id,
        text: "me too".into(),
    })
    .await;
    assert!(error(&mut v).await.contains("commenter"));

    let (status, top) = hub.get(&owner, &format!("/workspaces/{ws}/chat")).await;
    assert_eq!(status, StatusCode::OK);
    let top = top.as_array().unwrap();
    assert_eq!(top.len(), 1, "replies stay out of the channel");
    assert_eq!(top[0]["parent"], Value::Null);
    let (_, thread) = hub
        .get(
            &viewer,
            &format!("/workspaces/{ws}/chat?parent={}", root.id),
        )
        .await;
    let texts: Vec<&str> = thread
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["text"].as_str().unwrap())
        .collect();
    assert_eq!(texts, ["I do", "Thanks"]);
    let (_, counts) = hub
        .get(
            &owner,
            &format!("/workspaces/{ws}/chat/replies?channel=general"),
        )
        .await;
    assert_eq!(counts[0]["parent"], root.id.to_string());
    assert_eq!(counts[0]["count"], 2);
    assert_eq!(counts[0]["authors"].as_array().unwrap().len(), 2);

    // Reactions toggle per person and emoji.
    let react = ClientMsg::React {
        workspace_id: ws,
        message_id: root.id,
        emoji: "👍".into(),
    };
    b.send(react.clone()).await;
    let m = chat_of(&a.recv_where(is_update).await).unwrap().clone();
    assert_eq!(
        m.reactions,
        vec![(
            "👍".to_string(),
            vec![commenter_user["id"].as_str().unwrap().parse().unwrap()]
        )]
    );
    b.recv_where(is_update).await;
    a.send(react.clone()).await;
    let m = chat_of(&b.recv_where(is_update).await).unwrap().clone();
    assert_eq!(m.reactions[0].1.len(), 2);
    a.recv_where(is_update).await;
    b.send(react.clone()).await;
    let m = chat_of(&a.recv_where(is_update).await).unwrap().clone();
    assert_eq!(m.reactions[0].1.len(), 1);
    b.recv_where(is_update).await;
    let (_, top) = hub.get(&owner, &format!("/workspaces/{ws}/chat")).await;
    assert_eq!(top[0]["reactions"][0][0], "👍");
    v.send(react).await;
    assert!(error(&mut v).await.contains("commenter"));

    // Pinning needs an operator.
    let pin = ClientMsg::Pin {
        workspace_id: ws,
        message_id: root.id,
        pinned: true,
    };
    b.send(pin.clone()).await;
    assert!(error(&mut b).await.contains("operator"));
    a.send(pin).await;
    let m = chat_of(&b.recv_where(is_update).await).unwrap().clone();
    assert!(m.pinned);
    let (_, pinned) = hub
        .get(&viewer, &format!("/workspaces/{ws}/chat/pinned"))
        .await;
    assert_eq!(pinned.as_array().unwrap().len(), 1);
    assert_eq!(pinned[0]["id"], root.id.to_string());
    let (_, pinned) = hub
        .get(
            &viewer,
            &format!("/workspaces/{ws}/chat/pinned?channel=random"),
        )
        .await;
    assert!(pinned.as_array().unwrap().is_empty());

    // A message of another workspace cannot be touched through this one.
    let other = hub.workspace(&owner, &[]).await;
    a.send(ClientMsg::React {
        workspace_id: other,
        message_id: root.id,
        emoji: "👀".into(),
    })
    .await;
    assert!(error(&mut a).await.contains("does not exist"));

    // Channels.
    let (status, ch) = hub
        .post(
            &commenter,
            &format!("/workspaces/{ws}/channels"),
            json!({ "name": "#Design Review" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(ch["name"], "design-review");
    let (status, _) = hub
        .post(
            &commenter,
            &format!("/workspaces/{ws}/channels"),
            json!({ "name": "design-review" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = hub
        .post(
            &viewer,
            &format!("/workspaces/{ws}/channels"),
            json!({ "name": "nope" }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    a.send(ClientMsg::Chat {
        workspace_id: ws,
        channel: "ops".into(),
        text: "deploy at 5".into(),
    })
    .await;
    a.recv_where(is_chat).await;
    let (_, list) = hub
        .get(&viewer, &format!("/workspaces/{ws}/channels"))
        .await;
    let names: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["general", "design-review", "ops"]);
    let (status, _) = hub
        .get(
            &hub.login("stranger@example.com").await.0,
            &format!("/workspaces/{ws}/channels"),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn signals_are_relayed_targeted_and_broadcast() {
    let hub = Hub::start().await;
    let (owner, owner_user) = hub.login("owner@example.com").await;
    let (b_tok, b_user) = hub.login("b@example.com").await;
    let (c_tok, _) = hub.login("c@example.com").await;
    let (viewer, _) = hub.login("viewer@example.com").await;
    let ws = hub
        .workspace(
            &owner,
            &[
                (&b_tok, "commenter"),
                (&c_tok, "operator"),
                (&viewer, "viewer"),
            ],
        )
        .await;
    let mut a = hub.connect(&owner).await;
    let mut b = hub.connect(&b_tok).await;
    let mut c = hub.connect(&c_tok).await;
    let mut v = hub.connect(&viewer).await;
    let is_signal = |m: &ServerMsg| matches!(m, ServerMsg::Signal { .. });

    // Broadcast join: everyone but the sender, and the hub remembers the huddle.
    a.send(ClientMsg::Signal {
        workspace_id: ws,
        to: None,
        kind: "join".into(),
        payload: json!({}),
    })
    .await;
    for peer in [&mut b, &mut c, &mut v] {
        match peer.recv_where(is_signal).await {
            ServerMsg::Signal {
                workspace_id,
                from,
                kind,
                payload,
            } => {
                assert_eq!(workspace_id, ws);
                assert_eq!(from.id.to_string(), owner_user["id"].as_str().unwrap());
                assert_eq!(kind, "join");
                assert!(payload["conn"].is_u64());
            }
            _ => unreachable!(),
        }
    }
    a.assert_silent().await;
    let (_, huddle) = hub.get(&viewer, &format!("/workspaces/{ws}/huddle")).await;
    assert_eq!(huddle["participants"].as_array().unwrap().len(), 1);
    assert!(huddle["since"].is_string());

    // Targeted: only that person.
    let b_id: Uuid = b_user["id"].as_str().unwrap().parse().unwrap();
    a.send(ClientMsg::Signal {
        workspace_id: ws,
        to: Some(b_id),
        kind: "offer".into(),
        payload: json!({ "sdp": "v=0" }),
    })
    .await;
    match b.recv_where(is_signal).await {
        ServerMsg::Signal { kind, payload, .. } => {
            assert_eq!(kind, "offer");
            assert_eq!(payload["sdp"], "v=0");
        }
        _ => unreachable!(),
    }
    c.assert_silent().await;
    a.assert_silent().await;

    // Viewers may watch but not join.
    v.send(ClientMsg::Signal {
        workspace_id: ws,
        to: None,
        kind: "join".into(),
        payload: json!({}),
    })
    .await;
    assert!(error(&mut v).await.contains("commenter"));
    b.assert_silent().await;

    // Nor to someone outside the workspace.
    a.send(ClientMsg::Signal {
        workspace_id: ws,
        to: Some(Uuid::new_v4()),
        kind: "offer".into(),
        payload: json!({}),
    })
    .await;
    assert!(error(&mut a).await.contains("not a member"));

    // Hanging up counts as leaving.
    drop(a);
    match b
        .recv_where(|m| matches!(m, ServerMsg::Signal { kind, .. } if kind == "leave"))
        .await
    {
        ServerMsg::Signal { from, .. } => {
            assert_eq!(from.id.to_string(), owner_user["id"].as_str().unwrap())
        }
        _ => unreachable!(),
    }
    let (_, huddle) = hub.get(&viewer, &format!("/workspaces/{ws}/huddle")).await;
    assert!(huddle["participants"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn signal_bursts_are_rate_limited() {
    let hub = Hub::start().await;
    let (owner, _) = hub.login("owner@example.com").await;
    let (b_tok, _) = hub.login("b@example.com").await;
    let ws = hub.workspace(&owner, &[(&b_tok, "commenter")]).await;
    let mut a = hub.connect(&owner).await;
    for _ in 0..600 {
        a.send(ClientMsg::Signal {
            workspace_id: ws,
            to: None,
            kind: "ice".into(),
            payload: json!({}),
        })
        .await;
    }
    assert!(error(&mut a).await.contains("too many signals"));
}

#[tokio::test]
async fn ice_servers() {
    let hub = Hub::start().await;
    let (token, user) = hub.login("ada@example.com").await;
    let (status, _) = hub.get("", "/ice").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, ice) = hub.get(&token, "/ice").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        ice["iceServers"],
        json!([{ "urls": ["stun:stun.l.google.com:19302"] }])
    );

    let hub = Hub::start_with(|c| {
        c.turn_urls = vec![
            "turn:turn.example.com:3478?transport=udp".into(),
            "turns:turn.example.com:5349".into(),
        ];
        c.turn_secret = Some("s3cret".into());
    })
    .await;
    let (token, user2) = hub.login("ada@example.com").await;
    let _ = user;
    let (_, ice) = hub.get(&token, "/ice").await;
    let servers = ice["iceServers"].as_array().unwrap();
    assert_eq!(servers.len(), 2);
    let turn = &servers[1];
    assert_eq!(turn["urls"].as_array().unwrap().len(), 2);
    let username = turn["username"].as_str().unwrap();
    let (expiry, id) = username.split_once(':').unwrap();
    assert_eq!(id, user2["id"].as_str().unwrap());
    let left = expiry.parse::<i64>().unwrap() - chrono::Utc::now().timestamp();
    assert!(
        (12 * 3600 - 60..=12 * 3600).contains(&left),
        "valid for 12 h, got {left}"
    );
    // base64 of a 20-byte SHA-1 HMAC.
    assert_eq!(turn["credential"].as_str().unwrap().len(), 28);
    assert_eq!(ice["ttl"], 43200);
}

/// The fake host answers the hub's relayed form calls.
async fn answer_form_rpcs(mut host: Client, form: Uuid) -> Vec<Value> {
    let mut submitted = Vec::new();
    while let Some(m) = host.try_recv(Duration::from_secs(5)).await {
        let ServerMsg::Rpc {
            id,
            method,
            params,
            from,
            role,
            ..
        } = m
        else {
            continue;
        };
        assert_eq!(from.id, Uuid::nil());
        assert_eq!(from.name, "Form");
        assert_eq!(role, bouvio_protocol::Role::Commenter);
        let ok = match method.as_str() {
            "get_form_public" => {
                assert_eq!(params["form_id"], form.to_string());
                json!({
                    "id": form,
                    "title": "Event <signup>",
                    "description": "Tell us you're coming.",
                    "questions": [
                        { "id": "name", "label": "Name", "kind": "text", "required": true, "help": null, "options": [] },
                        { "id": "guests", "label": "Guests", "kind": "number", "required": false, "help": "Not counting you", "options": [] },
                        { "id": "diet", "label": "Diet", "kind": "multi_select", "required": false, "help": null, "options": ["vegan", "no nuts"] },
                    ]
                })
            }
            "form_submit" => {
                submitted.push(params.clone());
                json!(null)
            }
            other => panic!("unexpected {other}"),
        };
        host.send(ClientMsg::RpcResult {
            id,
            ok: Some(ok),
            err: None,
        })
        .await;
        if method == "form_submit" {
            break;
        }
    }
    submitted
}

#[tokio::test]
async fn public_forms_relay_to_the_host() {
    let hub = Hub::start().await;
    let (owner, _) = hub.login("owner@example.com").await;
    let ws = hub.workspace(&owner, &[]).await;
    let form = Uuid::new_v4();
    let url = hub.url(&format!("/f/{ws}/{form}"));

    // Offline host: a friendly page.
    let r = hub.http.get(&url).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(r.text().await.unwrap().contains("This form is offline"));

    let mut host = hub.connect(&owner).await;
    host.send(ClientMsg::Host {
        workspace_ids: vec![ws],
    })
    .await;
    host.recv_where(|m| matches!(m, ServerMsg::HostStatus { online: true, .. }))
        .await;
    let task = tokio::spawn(answer_form_rpcs(host, form));

    let r = hub.http.get(&url).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let page = r.text().await.unwrap();
    assert!(page.contains("Event &lt;signup&gt;"), "titles are escaped");
    assert!(page.contains(r#"name="name""#) && page.contains(" required"));
    assert!(page.contains(r#"type="number""#));
    assert!(page.contains(r#"type="checkbox" name="diet" value="no nuts""#));
    assert!(!page.contains("<script"));

    // Missing a required answer: shown again with an error, nothing submitted.
    let r = hub
        .http
        .post(&url)
        .form(&[("guests", "2")])
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let page = r.text().await.unwrap();
    assert!(page.contains("needs an answer") && page.contains(r#"value="2""#));

    let body = "name=Ada&guests=2&diet=vegan&diet=no+nuts&_website=";
    let r = hub
        .http
        .post(&url)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert!(r.text().await.unwrap().contains("Thank you"));
    let submitted = task.await.unwrap();
    assert_eq!(submitted.len(), 1);
    assert_eq!(submitted[0]["form_id"], form.to_string());
    assert_eq!(
        submitted[0]["answers"],
        json!({ "name": "Ada", "guests": 2.0, "diet": ["vegan", "no nuts"] })
    );
}

#[tokio::test]
async fn public_forms_are_rate_limited() {
    let hub = Hub::start().await;
    let ws = Uuid::new_v4();
    let url = hub.url(&format!("/f/{ws}/{}", Uuid::new_v4()));
    let mut limited = false;
    for _ in 0..12 {
        let r = hub
            .http
            .post(&url)
            .form(&[("a", "b")])
            .send()
            .await
            .unwrap();
        if r.status() == StatusCode::TOO_MANY_REQUESTS {
            limited = true;
            break;
        }
    }
    assert!(limited);
}

#[tokio::test]
async fn serves_the_web_client() {
    let web = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(web.path().join("assets")).unwrap();
    std::fs::write(
        web.path().join("index.html"),
        "<!doctype html><title>Bouvio</title>",
    )
    .unwrap();
    std::fs::write(
        web.path().join("assets/index-Bx12abCD.js"),
        "console.log(1)",
    )
    .unwrap();
    std::fs::write(web.path().join("manifest.webmanifest"), "{}").unwrap();
    let dir = web.path().to_path_buf();
    let hub = Hub::start_with(move |c| c.web_dir = Some(dir)).await;
    let get = |p: &str| hub.http.get(hub.url(p)).send();

    let r = get("/app/").await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()["cache-control"], "no-cache");
    assert!(r.text().await.unwrap().contains("<title>Bouvio"));

    let r = get("/app/assets/index-Bx12abCD.js").await.unwrap();
    assert_eq!(
        r.headers()["cache-control"],
        "public, max-age=31536000, immutable"
    );
    assert!(r.headers()["content-type"]
        .to_str()
        .unwrap()
        .starts_with("text/javascript"));

    let r = get("/app/manifest.webmanifest").await.unwrap();
    assert_eq!(r.headers()["content-type"], "application/manifest+json");
    assert_eq!(r.headers()["cache-control"], "no-cache");

    // Routes of the app fall back to index.html; missing assets do not.
    let r = get("/app/workspaces/123/chat").await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert!(r.text().await.unwrap().contains("<title>Bouvio"));
    assert_eq!(
        get("/app/assets/gone-12345678.js").await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    assert_ne!(
        get("/app/../Cargo.toml").await.unwrap().status(),
        StatusCode::OK
    );

    let plain = Hub::start().await;
    assert_eq!(
        plain
            .http
            .get(plain.url("/app/"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
}
