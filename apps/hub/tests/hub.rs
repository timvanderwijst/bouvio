//! End-to-end tests: a real hub on a random port with a temporary SQLite file.

mod common;

use bouvio_protocol::{ClientMsg, Role, ServerMsg};
use common::*;
use serde_json::json;
use uuid::Uuid;

#[tokio::test]
async fn email_login_me_and_logout() {
    let hub = Hub::start().await;

    let (status, _) = hub
        .post("", "/auth/email/start", json!({ "email": "not an email" }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (_, started) = hub
        .post(
            "",
            "/auth/email/start",
            json!({ "email": "Ada@Example.com" }),
        )
        .await;
    let code = started["code"].as_str().unwrap();
    assert_eq!(code.len(), 6);

    let (status, _) = hub
        .post(
            "",
            "/auth/email/verify",
            json!({ "email": "ada@example.com", "code": "000000x" }),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, res) = hub
        .post(
            "",
            "/auth/email/verify",
            json!({ "email": "ada@example.com", "code": code, "name": "Ada Lovelace" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let token = res["token"].as_str().unwrap();
    assert_eq!(res["user"]["name"], "Ada Lovelace");
    assert_eq!(res["user"]["email"], "ada@example.com");

    // A code works once.
    let (status, _) = hub
        .post(
            "",
            "/auth/email/verify",
            json!({ "email": "ada@example.com", "code": code }),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, me) = hub.get(token, "/me").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["id"], res["user"]["id"]);

    // Second login keeps the account; name defaults to the part before @ only for new users.
    let (token2, user2) = hub.login("ada@example.com").await;
    assert_eq!(user2["id"], res["user"]["id"]);
    assert_eq!(user2["name"], "Ada Lovelace");
    let (_, bob) = hub.login("bob@example.com").await;
    assert_eq!(bob["name"], "bob");

    let (status, _) = hub.post(token, "/auth/logout", json!({})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(hub.get(token, "/me").await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(hub.get(&token2, "/me").await.0, StatusCode::OK);

    // Unconfigured OAuth answers 501; unknown provider 404.
    assert_eq!(
        hub.http
            .get(hub.url("/auth/github/start"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_IMPLEMENTED
    );
    assert_eq!(
        hub.http
            .get(hub.url("/auth/nope/start"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        hub.post("", "/auth/exchange", json!({ "code": "ABCDEFGH" }))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn email_codes_are_rate_limited() {
    let hub = Hub::start().await;
    for _ in 0..5 {
        assert_eq!(
            hub.post("", "/auth/email/start", json!({ "email": "x@example.com" }))
                .await
                .0,
            StatusCode::OK
        );
    }
    let (status, _) = hub
        .post("", "/auth/email/start", json!({ "email": "x@example.com" }))
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn shared_workspace_end_to_end() {
    let hub = Hub::start().await;
    let (owner, owner_user) = hub.login("owner@example.com").await;
    let (member, member_user) = hub.login("member@example.com").await;
    let (viewer, _) = hub.login("viewer@example.com").await;
    let (stranger, _) = hub.login("stranger@example.com").await;

    // Register the workspace under the desktop's own id.
    let ws = Uuid::new_v4();
    let (status, entry) = hub
        .post(&owner, "/workspaces", json!({ "id": ws, "name": "Acme" }))
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(entry["role"], "admin");
    assert_eq!(entry["host"]["id"], owner_user["id"]);
    assert_eq!(entry["host_online"], false);
    let (status, _) = hub
        .post(
            &stranger,
            "/workspaces",
            json!({ "id": ws, "name": "Mine" }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Invites.
    let (status, invite) = hub
        .post(
            &owner,
            &format!("/workspaces/{ws}/invites"),
            json!({ "role": "prompter" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let code = invite["code"].as_str().unwrap();
    assert_eq!(
        invite["url"],
        format!("http://localhost:8787/invite/{code}")
    );
    let page = hub
        .http
        .get(hub.url(&format!("/invite/{code}")))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(page.contains("Acme") && page.contains("Open Bouvio and paste this code"));

    let (status, joined) = hub
        .post(&member, &format!("/invites/{code}/accept"), json!({}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(joined["role"], "prompter");
    assert_eq!(joined["name"], "Acme");

    let (_, vinvite) = hub
        .post(
            &owner,
            &format!("/workspaces/{ws}/invites"),
            json!({ "role": "viewer" }),
        )
        .await;
    let (status, _) = hub
        .post(
            &viewer,
            &format!("/invites/{}/accept", vinvite["code"].as_str().unwrap()),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    // Only admins invite; strangers don't see the workspace.
    let (status, _) = hub
        .post(
            &member,
            &format!("/workspaces/{ws}/invites"),
            json!({ "role": "admin" }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        hub.get(&stranger, &format!("/workspaces/{ws}/members"))
            .await
            .0,
        StatusCode::NOT_FOUND
    );

    let (_, members) = hub.get(&owner, &format!("/workspaces/{ws}/members")).await;
    assert_eq!(members.as_array().unwrap().len(), 3);

    // Members connect before the host is online.
    let mut m = hub.connect(&member).await;
    let mut v = hub.connect(&viewer).await;
    m.send(ClientMsg::Rpc {
        id: 1,
        workspace_id: ws,
        method: "list_threads".into(),
        params: json!({}),
    })
    .await;
    match m.recv().await {
        ServerMsg::RpcResult {
            id: 1,
            err: Some(e),
            ..
        } => assert_eq!(e, "host offline"),
        other => panic!("{other:?}"),
    }

    // A non-host cannot host.
    let mut s = hub.connect(&stranger).await;
    s.send(ClientMsg::Host {
        workspace_ids: vec![ws],
    })
    .await;
    assert!(matches!(s.recv().await, ServerMsg::Error { .. }));

    // The host comes online; everyone hears it.
    let mut h = hub.connect(&owner).await;
    h.send(ClientMsg::Host {
        workspace_ids: vec![ws],
    })
    .await;
    for c in [&mut h, &mut m, &mut v] {
        match c.recv().await {
            ServerMsg::HostStatus {
                workspace_id,
                online: true,
            } => assert_eq!(workspace_id, ws),
            other => panic!("{other:?}"),
        }
    }
    let (_, list) = hub.get(&member, "/workspaces").await;
    assert_eq!(list[0]["host_online"], true);
    let (_, members) = hub.get(&owner, &format!("/workspaces/{ws}/members")).await;
    assert!(members
        .as_array()
        .unwrap()
        .iter()
        .all(|m| m["online"] == true));

    // RPC routed member -> host -> member, under a hub-unique id.
    m.send(ClientMsg::Rpc {
        id: 42,
        workspace_id: ws,
        method: "list_threads".into(),
        params: json!({ "x": 1 }),
    })
    .await;
    let hub_id = match h.recv().await {
        ServerMsg::Rpc {
            id,
            workspace_id,
            method,
            params,
            from,
            role,
        } => {
            assert_eq!(workspace_id, ws);
            assert_eq!(method, "list_threads");
            assert_eq!(params, json!({ "x": 1 }));
            assert_eq!(from.id, uid(&member_user));
            assert_eq!(role, Role::Prompter);
            id
        }
        other => panic!("{other:?}"),
    };
    h.send(ClientMsg::RpcResult {
        id: hub_id,
        ok: Some(json!(["t1"])),
        err: None,
    })
    .await;
    match m.recv().await {
        ServerMsg::RpcResult {
            id: 42,
            ok: Some(ok),
            err: None,
        } => assert_eq!(ok, json!(["t1"])),
        other => panic!("{other:?}"),
    }

    // The host may call its own workspace, as admin.
    h.send(ClientMsg::Rpc {
        id: 42,
        workspace_id: ws,
        method: "workspace_settings_set".into(),
        params: json!({}),
    })
    .await;
    let own_id = match h.recv().await {
        ServerMsg::Rpc {
            id,
            role: Role::Admin,
            ..
        } => id,
        other => panic!("{other:?}"),
    };
    assert_ne!(own_id, hub_id);
    h.send(ClientMsg::RpcResult {
        id: own_id,
        ok: None,
        err: Some("nope".into()),
    })
    .await;
    assert!(matches!(
        h.recv().await,
        ServerMsg::RpcResult {
            id: 42,
            err: Some(_),
            ..
        }
    ));

    // A viewer may not create threads; the host never sees the request.
    v.send(ClientMsg::Rpc {
        id: 5,
        workspace_id: ws,
        method: "create_thread".into(),
        params: json!({}),
    })
    .await;
    match v.recv().await {
        ServerMsg::RpcResult {
            id: 5,
            ok: None,
            err: Some(e),
        } => assert!(e.starts_with("forbidden"), "{e}"),
        other => panic!("{other:?}"),
    }
    h.assert_silent().await;

    // Strangers get nothing through.
    s.send(ClientMsg::Rpc {
        id: 9,
        workspace_id: ws,
        method: "list_threads".into(),
        params: json!({}),
    })
    .await;
    assert!(matches!(
        s.recv().await,
        ServerMsg::RpcResult {
            id: 9,
            err: Some(_),
            ..
        }
    ));

    // Host events fan out to members, not back to the publishing connection.
    h.send(ClientMsg::Publish {
        workspace_id: ws,
        kind: "thread-event".into(),
        payload: json!({ "n": 1 }),
    })
    .await;
    for c in [&mut m, &mut v] {
        match c.recv().await {
            ServerMsg::Event {
                workspace_id,
                kind,
                payload,
            } => {
                assert_eq!(
                    (workspace_id, kind.as_str(), payload),
                    (ws, "thread-event", json!({ "n": 1 }))
                );
            }
            other => panic!("{other:?}"),
        }
    }
    h.assert_silent().await;
    s.assert_silent().await;
    m.send(ClientMsg::Publish {
        workspace_id: ws,
        kind: "x".into(),
        payload: json!(null),
    })
    .await;
    assert!(matches!(m.recv().await, ServerMsg::Error { .. }));
    v.assert_silent().await;

    // Chat: persisted and broadcast; viewers can't post.
    m.send(ClientMsg::Chat {
        workspace_id: ws,
        channel: "general".into(),
        text: "hello team".into(),
    })
    .await;
    for c in [&mut m, &mut v, &mut h] {
        match c.recv().await {
            ServerMsg::Chat { message } => {
                assert_eq!(message.text, "hello team");
                assert_eq!(message.author.id, uid(&member_user));
            }
            other => panic!("{other:?}"),
        }
    }
    v.send(ClientMsg::Chat {
        workspace_id: ws,
        channel: "general".into(),
        text: "hi".into(),
    })
    .await;
    assert!(matches!(v.recv().await, ServerMsg::Error { .. }));
    let (status, history) = hub
        .get(
            &viewer,
            &format!("/workspaces/{ws}/chat?channel=general&limit=50"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let history = history.as_array().unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0]["text"], "hello team");
    let (_, other) = hub
        .get(&viewer, &format!("/workspaces/{ws}/chat?channel=random"))
        .await;
    assert_eq!(other.as_array().unwrap().len(), 0);
    let (_, older) = hub
        .get(
            &viewer,
            &format!("/workspaces/{ws}/chat?before=2000-01-01T00:00:00Z"),
        )
        .await;
    assert_eq!(older.as_array().unwrap().len(), 0);

    // Presence, and leaving.
    m.send(ClientMsg::Presence {
        workspace_id: ws,
        viewing: Some("thread-1".into()),
        cursor: None,
    })
    .await;
    for c in [&mut v, &mut h] {
        match c.recv().await {
            ServerMsg::Presence {
                presence,
                online: true,
            } => {
                assert_eq!(presence.viewing.as_deref(), Some("thread-1"));
                assert_eq!(presence.user.id, uid(&member_user));
            }
            other => panic!("{other:?}"),
        }
    }
    m.assert_silent().await;
    drop(m);
    match v.recv().await {
        ServerMsg::Presence {
            presence,
            online: false,
        } => assert_eq!(presence.user.id, uid(&member_user)),
        other => panic!("{other:?}"),
    }

    // Member management: the host can't be demoted or removed.
    let owner_id = owner_user["id"].as_str().unwrap();
    let path = format!("/workspaces/{ws}/members/{owner_id}");
    let (status, _) = hub
        .send(
            reqwest::Method::PATCH,
            &owner,
            &path,
            json!({ "role": "viewer" }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = hub
        .send(reqwest::Method::DELETE, &owner, &path, json!({}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let mpath = format!(
        "/workspaces/{ws}/members/{}",
        member_user["id"].as_str().unwrap()
    );
    let (status, _) = hub
        .send(
            reqwest::Method::PATCH,
            &member,
            &mpath,
            json!({ "role": "admin" }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, updated) = hub
        .send(
            reqwest::Method::PATCH,
            &owner,
            &mpath,
            json!({ "role": "viewer", "see_costs": true }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        (updated["role"].as_str(), updated["see_costs"].as_bool()),
        (Some("viewer"), Some(true))
    );
    let (status, _) = hub
        .send(reqwest::Method::DELETE, &owner, &mpath, json!({}))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        hub.get(&member, &format!("/workspaces/{ws}/chat")).await.0,
        StatusCode::NOT_FOUND
    );

    // The host leaves; members hear it.
    drop(h);
    match v.recv().await {
        ServerMsg::HostStatus {
            workspace_id,
            online: false,
        } => assert_eq!(workspace_id, ws),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn pending_rpc_fails_when_host_drops() {
    let hub = Hub::start().await;
    let (owner, _) = hub.login("o@example.com").await;
    let (member, _) = hub.login("m@example.com").await;
    let ws = Uuid::new_v4();
    hub.post(&owner, "/workspaces", json!({ "id": ws, "name": "W" }))
        .await;
    let (_, invite) = hub
        .post(
            &owner,
            &format!("/workspaces/{ws}/invites"),
            json!({ "role": "operator" }),
        )
        .await;
    hub.post(
        &member,
        &format!("/invites/{}/accept", invite["code"].as_str().unwrap()),
        json!({}),
    )
    .await;

    let mut h = hub.connect(&owner).await;
    h.send(ClientMsg::Host {
        workspace_ids: vec![ws],
    })
    .await;
    h.recv().await;
    let mut m = hub.connect(&member).await;
    m.send(ClientMsg::Rpc {
        id: 3,
        workspace_id: ws,
        method: "create_thread".into(),
        params: json!({}),
    })
    .await;
    assert!(matches!(
        h.recv().await,
        ServerMsg::Rpc {
            role: Role::Operator,
            ..
        }
    ));
    drop(h);
    let mut saw_error = false;
    for _ in 0..2 {
        match m.recv().await {
            ServerMsg::RpcResult {
                id: 3,
                err: Some(e),
                ..
            } => {
                assert_eq!(e, "host offline");
                saw_error = true;
            }
            ServerMsg::HostStatus { online: false, .. } => {}
            other => panic!("{other:?}"),
        }
    }
    assert!(saw_error);
}

#[tokio::test]
async fn websocket_requires_a_valid_token() {
    let hub = Hub::start().await;
    let url = format!("{}/ws?token=bogus", hub.base.replace("http://", "ws://"));
    assert!(tokio_tungstenite::connect_async(url).await.is_err());
}
