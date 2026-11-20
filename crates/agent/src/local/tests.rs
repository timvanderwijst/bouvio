use super::*;

fn fixture(name: &str) -> Value {
    let text = match name {
        "ollama_tags" => include_str!("fixtures/ollama_tags.json"),
        "ollama_show" => include_str!("fixtures/ollama_show.json"),
        "lmstudio_v0" => include_str!("fixtures/lmstudio_v0_models.json"),
        "lmstudio_v1" => include_str!("fixtures/lmstudio_v1_models.json"),
        _ => unreachable!(),
    };
    serde_json::from_str(text).unwrap()
}

#[test]
fn parses_ollama_tags() {
    let m = parse_ollama_tags(&fixture("ollama_tags"));
    assert_eq!(m.len(), 3);
    assert_eq!(m[0].id, "local:qwen3:8b");
    assert_eq!(m[0].name, "qwen3:8b");
    assert_eq!(m[0].size, Some(5_225_388_164));
    assert_eq!(m[0].detail.as_deref(), Some("8.2B Q4_K_M"));
    assert!(!m[0].embedding);
    assert_eq!(m[1].id, "local:llama3.2:latest");
    assert!(m[2].embedding, "nomic-bert is an embedding model");
    assert!(parse_ollama_tags(&json!({})).is_empty());
}

#[test]
fn parses_ollama_context() {
    assert_eq!(parse_ollama_context(&fixture("ollama_show")), Some(40960));
    assert_eq!(parse_ollama_context(&json!({"model_info":{"llama.context_length":131072}})), Some(131072));
    assert_eq!(parse_ollama_context(&json!({"details":{}})), None);
}

#[test]
fn parses_lmstudio_models() {
    let m = parse_openai_models(&fixture("lmstudio_v0"));
    assert_eq!(m.len(), 3);
    assert_eq!(m[0].0.id, "local:qwen/qwen3-8b");
    assert_eq!(m[0].1, Some(32768));
    assert_eq!(m[0].0.detail.as_deref(), Some("qwen3 Q4_K_M loaded"));
    assert!(!m[1].0.embedding, "a vision model still chats");
    assert!(m[2].0.embedding);

    let m = parse_openai_models(&fixture("lmstudio_v1"));
    assert_eq!(m.len(), 2);
    assert_eq!((m[0].0.name.as_str(), m[0].1), ("qwen/qwen3-8b", None));
    assert!(m[1].0.embedding, "guessed from the name");
}

#[test]
fn model_infos_are_free_and_local() {
    let m = parse_ollama_tags(&fixture("ollama_tags"));
    let info = to_info(&m[0], Some(40960));
    assert_eq!(info.provider, ProviderKind::Local);
    assert_eq!((info.price_in, info.price_out, info.context), (None, None, Some(40960)));
}

#[test]
fn normalizes_config() {
    let c = normalize(LocalConfig {
        ollama_url: " http://box:11434/v1/ ".into(),
        lmstudio_url: String::new(),
        custom_url: "http://gpu:8080/v1/".into(),
        whisper_size: String::new(),
        ..Default::default()
    });
    assert_eq!(c.ollama_url, "http://box:11434");
    assert_eq!(c.lmstudio_url, "http://127.0.0.1:1234");
    assert_eq!(c.custom_url, "http://gpu:8080/v1");
    assert_eq!(c.whisper_size, "base");
    // Unknown and missing fields in the file fall back to defaults.
    let c: LocalConfig = serde_json::from_value(json!({"chat_server":"lm_studio","piper_voice":"nl_NL-mls-medium"})).unwrap();
    assert_eq!(c.chat_server, LocalChatServer::LmStudio);
    assert_eq!(c.ollama_url, "http://127.0.0.1:11434");
    assert_eq!(c.piper_voice, "nl_NL-mls-medium");
}

#[test]
fn config_file_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("local.json");
    assert_eq!(load_config(&path), LocalConfig::default());
    let c = LocalConfig { default_model: "local:qwen3:8b".into(), ..Default::default() };
    save_config(&path, &c).unwrap();
    assert_eq!(load_config(&path), c);
    std::fs::write(&path, "not json").unwrap();
    assert_eq!(load_config(&path), LocalConfig::default());
}

#[test]
fn download_urls() {
    assert!(whisper_url("base").unwrap().ends_with("/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"));
    assert!(whisper_url("../etc").is_err());
    assert!(whisper_url("huge").is_err());
    assert!(piper_url("en_US-lessac-medium").unwrap().ends_with("/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx"));
    assert!(piper_url("nl_NL-mls-medium").unwrap().ends_with("/nl/nl_NL/mls/medium/nl_NL-mls-medium.onnx"));
    assert!(piper_url("en_GB-alan-low").is_ok());
    assert!(piper_url("en_US-x_y-x_low").is_ok());
    assert!(piper_url("en_US-lessac").is_err());
    assert!(piper_url("../../x-y-medium").is_err());
    assert!(piper_url("en_US-les/sac-medium").is_err());
}

#[test]
fn parses_pull_stream() {
    let p = parse_pull_line("qwen3:8b", r#"{"status":"pulling 3e4cb1417446","digest":"sha256:3e4c","total":5225386944,"completed":1048576}"#).unwrap().unwrap();
    assert_eq!((p.completed, p.total, p.done), (Some(1_048_576), Some(5_225_386_944), false));
    assert_eq!(p.kind, "ollama");
    let p = parse_pull_line("qwen3:8b", r#"{"status":"success"}"#).unwrap().unwrap();
    assert!(p.done);
    let e = parse_pull_line("nope", r#"{"error":"pull model manifest: file does not exist"}"#).unwrap().unwrap_err();
    assert!(e.to_string().contains("file does not exist"));
    assert!(parse_pull_line("x", "").is_none());
    assert!(valid_ollama_name("hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M"));
    assert!(!valid_ollama_name("qwen3; rm -rf"));
}

#[test]
fn parses_comfy_checkpoints() {
    let old = json!({"CheckpointLoaderSimple":{"input":{"required":{"ckpt_name":[["sd_xl_base_1.0.safetensors","v1-5.ckpt"],{}]}}}});
    assert_eq!(parse_comfy_checkpoints(&old), ["sd_xl_base_1.0.safetensors", "v1-5.ckpt"]);
    let new = json!({"CheckpointLoaderSimple":{"input":{"required":{"ckpt_name":["COMBO",{"options":["flux1-schnell.safetensors"]}]}}}});
    assert_eq!(parse_comfy_checkpoints(&new), ["flux1-schnell.safetensors"]);
    assert!(parse_comfy_checkpoints(&json!({})).is_empty());
}

#[test]
fn parses_embeddings() {
    let v = json!([[0.1, 0.2], [0.3, -0.4]]);
    assert_eq!(parse_embeddings(&v, 2).unwrap(), vec![vec![0.1f32, 0.2], vec![0.3, -0.4]]);
    assert!(parse_embeddings(&v, 3).is_err());
    assert!(parse_embeddings(&Value::Null, 0).is_err());
}

#[test]
fn recommended_has_each_use() {
    let r = recommended();
    for u in [LocalModelUse::Chat, LocalModelUse::Code, LocalModelUse::Embed, LocalModelUse::Whisper, LocalModelUse::Piper] {
        assert!(r.iter().any(|x| x.use_ == u));
    }
    for x in r.iter().filter(|x| x.use_ == LocalModelUse::Whisper) {
        assert!(whisper_url(&x.name).is_ok());
    }
    for x in r.iter().filter(|x| x.use_ == LocalModelUse::Piper) {
        assert!(piper_url(&x.name).is_ok());
    }
}

#[test]
fn throttles_progress() {
    let mut seen = Vec::new();
    {
        let mut t = Throttle { on: |p: LocalProgress| seen.push(p.status), last: None };
        for _ in 0..50 {
            t.send(progress("ollama", "m", "downloading", Some(1), Some(2)));
        }
        t.send(progress("ollama", "m", "verifying", None, None));
        let mut end = progress("ollama", "m", "verifying", None, None);
        end.done = true;
        t.send(end);
    }
    assert_eq!(seen, ["downloading", "verifying", "verifying"]);
}
