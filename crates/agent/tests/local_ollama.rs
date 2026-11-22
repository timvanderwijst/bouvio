//! Ollama's native endpoints (tags, show, pull, embed) against a mock.

use axum::{extract::State, http::StatusCode, routing::{get, post}, Json, Router};
use cuna_agent::StaticKeys;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Mock {
    pulled: Arc<Mutex<Vec<String>>>,
    embed_calls: Arc<Mutex<u32>>,
}

async fn tags() -> Json<Value> {
    Json(json!({"models":[
        {"name":"qwen3:8b","size":5225388164u64,"details":{"family":"qwen3","parameter_size":"8.2B","quantization_level":"Q4_K_M"}},
        {"name":"nomic-embed-text:latest","size":274302450,"details":{"family":"nomic-bert","families":["nomic-bert"]}}
    ]}))
}

async fn show(Json(b): Json<Value>) -> Json<Value> {
    assert_eq!(b["model"], "qwen3:8b");
    Json(json!({"model_info":{"general.architecture":"qwen3","qwen3.context_length":40960}}))
}

async fn version() -> Json<Value> {
    Json(json!({"version":"0.12.6"}))
}

async fn pull(State(m): State<Mock>, Json(b): Json<Value>) -> String {
    m.pulled.lock().unwrap().push(b["model"].as_str().unwrap().to_string());
    [
        json!({"status":"pulling manifest"}),
        json!({"status":"pulling 970aa74c0a90","digest":"sha256:970a","total":1000,"completed":500}),
        json!({"status":"pulling 970aa74c0a90","digest":"sha256:970a","total":1000,"completed":1000}),
        json!({"status":"verifying sha256 digest"}),
        json!({"status":"success"}),
    ]
    .iter()
    .map(|v| format!("{v}\n"))
    .collect()
}

async fn embed(State(m): State<Mock>, Json(b): Json<Value>) -> (StatusCode, Json<Value>) {
    let mut n = m.embed_calls.lock().unwrap();
    *n += 1;
    if *n == 1 {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"model \"nomic-embed-text\" not found, try pulling it first"})));
    }
    let count = b["input"].as_array().unwrap().len();
    (StatusCode::OK, Json(json!({"model":"nomic-embed-text","embeddings": vec![vec![0.25, -0.5, 1.0]; count]})))
}

#[tokio::test]
async fn ollama_listing_pull_and_embeddings() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let root = format!("http://{}", listener.local_addr().unwrap());
    let mock = Mock::default();
    let app = Router::new()
        .route("/api/tags", get(tags))
        .route("/api/show", post(show))
        .route("/api/version", get(version))
        .route("/api/pull", post(pull))
        .route("/api/embed", post(embed))
        .with_state(mock.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    std::env::set_var("CUNA_OLLAMA_BASE_URL", &root);
    // Nothing listens here: LM Studio is "not running".
    std::env::set_var("CUNA_LMSTUDIO_BASE_URL", "http://127.0.0.1:9");

    let models = cuna_agent::local::list_chat_models().await;
    assert_eq!(models.len(), 1, "embedding models are not chat models");
    assert_eq!(models[0].id, "local:qwen3:8b");
    assert_eq!(models[0].context, Some(40960));
    assert!(cuna_agent::local::reachable_cached());

    let status = cuna_agent::local::status().await;
    let ollama = &status.engines[0];
    assert!(ollama.ready);
    assert_eq!(ollama.version.as_deref(), Some("0.12.6"));
    assert_eq!(ollama.models.len(), 2);
    assert!(!status.engines[1].ready, "LM Studio is down");

    let mut seen = Vec::new();
    cuna_agent::local::pull("qwen3:4b", |p| seen.push(p)).await.unwrap();
    assert_eq!(seen.first().unwrap().status, "pulling manifest");
    assert!(seen.last().unwrap().done);
    assert!(seen.iter().any(|p| p.total == Some(1000)));

    // The embedding model is pulled on first use, then used.
    let v = cuna_agent::embed(&StaticKeys::new(), &["a".into(), "b".into()]).await.unwrap();
    assert_eq!(v, vec![vec![0.25f32, -0.5, 1.0]; 2]);
    assert_eq!(*mock.pulled.lock().unwrap(), ["qwen3:4b", "nomic-embed-text"]);
    assert!(cuna_agent::embed(&StaticKeys::new(), &[]).await.unwrap().is_empty());
}
