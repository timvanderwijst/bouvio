//! Images, video, speech and transcription with the user's own keys, or on
//! this machine.
//!
//! Models are provider-qualified: `openai:gpt-image-1`, `fal:fal-ai/flux/schnell`,
//! `replicate:black-forest-labs/flux-schnell`, `elevenlabs:<voice_id>`,
//! `openai:gpt-4o-mini-tts`, `openai:whisper-1`. Local ones: `comfyui:<checkpoint>`
//! (or `comfyui:default`), `local:piper/<voice>`, `local:whisper-<size>`. Each
//! call writes one file into `out_dir` and returns its path.

use crate::keys::KeyStore;
use crate::provider::{api_error, base_override, base_url, http, missing_key, provider_from_id, provider_name, send_json};
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use bouvio_protocol::{ArtifactKind, ProviderKind};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

const POLL_EVERY: Duration = Duration::from_secs(3);
const POLL_LIMIT: Duration = Duration::from_secs(30 * 60);

fn split(model: &str) -> Result<(ProviderKind, &str)> {
    let (p, rest) = model.split_once(':').ok_or_else(|| anyhow!("Model {model:?} needs a provider prefix, like fal:… or openai:…"))?;
    let p = provider_from_id(p).ok_or_else(|| anyhow!("Unknown provider {p:?} in {model:?}"))?;
    if rest.trim().is_empty() {
        bail!("Model name missing in {model:?}");
    }
    Ok((p, rest.trim()))
}

fn key(keys: &dyn KeyStore, p: ProviderKind) -> Result<String> {
    keys.get(p).ok_or_else(|| anyhow!(missing_key(p)))
}

async fn post_json(p: ProviderKind, build: impl Fn() -> reqwest::RequestBuilder) -> Result<Value> {
    send_json(p, build, &CancellationToken::new()).await
}

/// One request whose answer is a file.
async fn fetch_bytes(p: ProviderKind, req: reqwest::RequestBuilder) -> Result<(Vec<u8>, Option<String>)> {
    let resp = req.send().await.map_err(|e| anyhow!("Could not reach {}: {e}", provider_name(p)))?;
    let status = resp.status().as_u16();
    let ctype = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_string);
    let body = resp.bytes().await?;
    if !(200..300).contains(&status) {
        bail!(api_error(p, status, &String::from_utf8_lossy(&body)));
    }
    Ok((body.to_vec(), ctype))
}

fn ext_for(ctype: Option<&str>, url: &str, fallback: &str) -> String {
    let by_type = ctype.map(|c| c.split(';').next().unwrap_or("").trim().to_ascii_lowercase()).and_then(|c| {
        Some(match c.as_str() {
            "image/png" => "png",
            "image/jpeg" | "image/jpg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            "video/mp4" => "mp4",
            "video/webm" => "webm",
            "video/quicktime" => "mov",
            "audio/mpeg" | "audio/mp3" => "mp3",
            "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
            "audio/ogg" => "ogg",
            "audio/flac" => "flac",
            _ => return None,
        })
    });
    if let Some(e) = by_type {
        return e.to_string();
    }
    let path = url.split(['?', '#']).next().unwrap_or("");
    let last = path.rsplit('/').next().unwrap_or("");
    match last.rsplit_once('.') {
        Some((_, e)) if (2..=5).contains(&e.len()) && e.chars().all(|c| c.is_ascii_alphanumeric()) => e.to_ascii_lowercase(),
        _ => fallback.to_string(),
    }
}

/// A fresh file name in `out_dir`, which is created if needed.
async fn out_path(out_dir: &Path, prefix: &str, ext: &str) -> Result<PathBuf> {
    tokio::fs::create_dir_all(out_dir).await.with_context(|| format!("Cannot create {}", out_dir.display()))?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    Ok(out_dir.join(format!("{prefix}-{}-{}.{ext}", chrono::Local::now().format("%Y%m%d-%H%M%S"), &id[..8])))
}

async fn save(out_dir: &Path, prefix: &str, ext: &str, bytes: &[u8]) -> Result<PathBuf> {
    let path = out_path(out_dir, prefix, ext).await?;
    tokio::fs::write(&path, bytes).await.with_context(|| format!("Cannot write {}", path.display()))?;
    Ok(path)
}

/// Fetch a result URL (or decode a `data:` URL) into `out_dir`.
async fn download(url: &str, out_dir: &Path, prefix: &str, fallback_ext: &str) -> Result<PathBuf> {
    if let Some(rest) = url.strip_prefix("data:") {
        let (meta, data) = rest.split_once(',').ok_or_else(|| anyhow!("Bad data URL"))?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).context("Bad base64 in data URL")?;
        let ext = ext_for(Some(meta.split(';').next().unwrap_or("")), "", fallback_ext);
        return save(out_dir, prefix, &ext, &bytes).await;
    }
    let resp = http().get(url).send().await.with_context(|| format!("Downloading {url} failed"))?;
    if !resp.status().is_success() {
        bail!("Downloading the result failed: {}", resp.status());
    }
    let ctype = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_string);
    let bytes = resp.bytes().await?;
    save(out_dir, prefix, &ext_for(ctype.as_deref(), url, fallback_ext), &bytes).await
}

/// First URL-looking string in a result: `"…"`, `["…"]`, `{"url": "…"}`, `[{"url": "…"}]`.
fn first_url(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if s.starts_with("http") || s.starts_with("data:") => Some(s.clone()),
        Value::Array(a) => a.iter().find_map(first_url),
        Value::Object(o) => o.get("url").and_then(first_url).or_else(|| o.values().find_map(first_url)),
        _ => None,
    }
}

// ---- fal ---------------------------------------------------------------------------

async fn fal_run(key: &str, model: &str, input: Value) -> Result<Value> {
    let url = format!("{}/{model}", base_url(ProviderKind::Fal));
    post_json(ProviderKind::Fal, || http().post(&url).header("Authorization", format!("Key {key}")).json(&input)).await
}

/// fal's queue: submit, poll the status, then read the result.
async fn fal_queue(key: &str, model: &str, input: Value) -> Result<Value> {
    let base = base_override("fal_queue").unwrap_or_else(|| "https://queue.fal.run".into());
    let auth = format!("Key {key}");
    let url = format!("{base}/{model}");
    let sub = post_json(ProviderKind::Fal, || http().post(&url).header("Authorization", &auth).json(&input)).await?;
    let status_url = sub["status_url"].as_str().ok_or_else(|| anyhow!("fal did not queue the request: {sub}"))?.to_string();
    let response_url = sub["response_url"].as_str().ok_or_else(|| anyhow!("fal did not queue the request: {sub}"))?.to_string();
    let started = Instant::now();
    loop {
        let s = post_json(ProviderKind::Fal, || http().get(&status_url).header("Authorization", &auth)).await?;
        match s["status"].as_str() {
            Some("COMPLETED") => break,
            Some("IN_QUEUE") | Some("IN_PROGRESS") => {}
            other => bail!("fal reported {}: {}", other.unwrap_or("an unknown status"), s),
        }
        if started.elapsed() > POLL_LIMIT {
            bail!("fal did not finish within 30 minutes");
        }
        tokio::time::sleep(POLL_EVERY).await;
    }
    let r = post_json(ProviderKind::Fal, || http().get(&response_url).header("Authorization", &auth)).await?;
    if let Some(detail) = r.get("detail").filter(|d| !d.is_null()) {
        bail!("fal failed: {detail}");
    }
    Ok(r)
}

// ---- replicate -----------------------------------------------------------------------

async fn replicate(key: &str, model: &str, input: Value) -> Result<Value> {
    let base = base_url(ProviderKind::Replicate);
    let (url, body) = match model.split_once(':') {
        Some((_, version)) => (format!("{base}/predictions"), json!({ "version": version, "input": input })),
        None => (format!("{base}/models/{model}/predictions"), json!({ "input": input })),
    };
    let mut p = post_json(ProviderKind::Replicate, || http().post(&url).bearer_auth(key).header("Prefer", "wait=60").json(&body)).await?;
    let started = Instant::now();
    loop {
        match p["status"].as_str() {
            Some("succeeded") => return Ok(p["output"].clone()),
            Some("failed") | Some("canceled") | Some("aborted") => {
                bail!("Replicate {}: {}", p["status"].as_str().unwrap_or(""), p["error"].as_str().unwrap_or("no details"))
            }
            _ => {}
        }
        if started.elapsed() > POLL_LIMIT {
            bail!("Replicate did not finish within 30 minutes");
        }
        let get = p["urls"]["get"].as_str().ok_or_else(|| anyhow!("Replicate sent no status URL: {p}"))?.to_string();
        tokio::time::sleep(POLL_EVERY).await;
        p = post_json(ProviderKind::Replicate, || http().get(&get).bearer_auth(key)).await?;
    }
}

// ---- public API ------------------------------------------------------------------------

/// `openai:gpt-image-1`, `fal:fal-ai/flux/schnell`, `replicate:<owner/model>`,
/// `comfyui:<checkpoint>` (ComfyUI on this machine; `comfyui:default` = its first checkpoint).
pub async fn generate_image(keys: &dyn KeyStore, model: &str, prompt: &str, out_dir: &Path) -> Result<PathBuf> {
    if let Some(ckpt) = model.trim().strip_prefix("comfyui:").or((model.trim() == "comfyui").then_some("")) {
        let (bytes, ctype) = crate::local::media::comfy_image(ckpt.trim(), prompt).await?;
        return save(out_dir, "image", &ext_for(ctype.as_deref(), "", "png"), &bytes).await;
    }
    let (p, m) = split(model)?;
    match p {
        ProviderKind::OpenAi => {
            let k = key(keys, p)?;
            let url = format!("{}/images/generations", base_url(p));
            let body = json!({ "model": m, "prompt": prompt, "n": 1 });
            let v = post_json(p, || http().post(&url).bearer_auth(&k).json(&body)).await?;
            let item = &v["data"][0];
            if let Some(b64) = item["b64_json"].as_str() {
                let bytes = base64::engine::general_purpose::STANDARD.decode(b64).context("OpenAI sent bad image data")?;
                return save(out_dir, "image", "png", &bytes).await;
            }
            let url = item["url"].as_str().ok_or_else(|| anyhow!("OpenAI sent no image: {v}"))?;
            download(url, out_dir, "image", "png").await
        }
        ProviderKind::Fal => {
            let v = fal_run(&key(keys, p)?, m, json!({ "prompt": prompt })).await?;
            let url = first_url(&v["images"]).or_else(|| first_url(&v["image"])).ok_or_else(|| anyhow!("fal sent no image: {v}"))?;
            download(&url, out_dir, "image", "png").await
        }
        ProviderKind::Replicate => {
            let out = replicate(&key(keys, p)?, m, json!({ "prompt": prompt })).await?;
            let url = first_url(&out).ok_or_else(|| anyhow!("Replicate sent no image: {out}"))?;
            download(&url, out_dir, "image", "png").await
        }
        _ => bail!("Image generation works with openai:, fal:, replicate: and comfyui: models, not {model}"),
    }
}

/// `fal:<model>` or `replicate:<owner/model>`; waits until the video is done.
pub async fn generate_video(keys: &dyn KeyStore, model: &str, prompt: &str, out_dir: &Path) -> Result<PathBuf> {
    let (p, m) = split(model)?;
    let url = match p {
        ProviderKind::Fal => {
            let v = fal_queue(&key(keys, p)?, m, json!({ "prompt": prompt })).await?;
            first_url(&v["video"]).or_else(|| first_url(&v["videos"])).or_else(|| first_url(&v)).ok_or_else(|| anyhow!("fal sent no video: {v}"))?
        }
        ProviderKind::Replicate => {
            let out = replicate(&key(keys, p)?, m, json!({ "prompt": prompt })).await?;
            first_url(&out).ok_or_else(|| anyhow!("Replicate sent no video: {out}"))?
        }
        _ => bail!("Video generation works with fal: and replicate: models, not {model}"),
    };
    download(&url, out_dir, "video", "mp4").await
}

/// `elevenlabs:<voice_id>` (optionally `/<model_id>`), or `openai:gpt-4o-mini-tts`
/// (optionally `/<voice>`), which write an mp3; or `local:piper/<voice>` (Piper on
/// this machine, `local:piper` = the configured voice), which writes a WAV.
pub async fn speak(keys: &dyn KeyStore, model: &str, text: &str, out_dir: &Path) -> Result<PathBuf> {
    let (p, m) = split(model)?;
    let (name, variant) = match m.split_once('/') {
        Some((a, b)) => (a, Some(b)),
        None => (m, None),
    };
    if p == ProviderKind::Local {
        if name != "piper" {
            bail!("Local speech uses Piper: local:piper/<voice>, not {model}");
        }
        let path = out_path(out_dir, "speech", "wav").await?;
        crate::local::media::speak(variant, text, &path).await?;
        return Ok(path);
    }
    let (bytes, ctype) = match p {
        ProviderKind::ElevenLabs => {
            let k = key(keys, p)?;
            let body = json!({ "text": text, "model_id": variant.unwrap_or("eleven_multilingual_v2") });
            let req = http()
                .post(format!("{}/text-to-speech/{name}", base_url(p)))
                .header("xi-api-key", k)
                .header("accept", "audio/mpeg")
                .json(&body);
            fetch_bytes(p, req).await?
        }
        ProviderKind::OpenAi => {
            let k = key(keys, p)?;
            let body = json!({ "model": name, "input": text, "voice": variant.unwrap_or("alloy"), "response_format": "mp3" });
            fetch_bytes(p, http().post(format!("{}/audio/speech", base_url(p))).bearer_auth(k).json(&body)).await?
        }
        _ => bail!("Speech works with elevenlabs: and openai: models, not {model}"),
    };
    save(out_dir, "speech", &ext_for(ctype.as_deref(), "", "mp3"), &bytes).await
}

/// `openai:whisper-1` or `openai:gpt-4o-transcribe`; or `local:whisper-<size>`
/// (`tiny`, `base`, `small`, `medium`; `local:whisper` = the configured size) with
/// whisper.cpp on this machine, which wants a 16 kHz mono WAV (other formats go
/// through ffmpeg when it is installed). The model downloads on first use.
pub async fn transcribe(keys: &dyn KeyStore, model: &str, file: &Path) -> Result<String> {
    let (p, m) = split(model)?;
    if p == ProviderKind::Local {
        let size = match m.strip_prefix("whisper") {
            Some(rest) => rest.trim_start_matches(['-', '/', ':']),
            None => bail!("Local transcription uses whisper.cpp: local:whisper-<size>, not {model}"),
        };
        return crate::local::media::transcribe(Some(size), file).await;
    }
    if p != ProviderKind::OpenAi {
        bail!("Transcription works with openai: and local:whisper-… models, not {model}");
    }
    let k = key(keys, p)?;
    let bytes = tokio::fs::read(file).await.with_context(|| format!("Cannot read {}", file.display()))?;
    if bytes.len() > 25 * 1024 * 1024 {
        bail!("{} is larger than the 25 MB OpenAI accepts; split or compress it first", file.display());
    }
    let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "audio".into());
    let url = format!("{}/audio/transcriptions", base_url(p));
    let v = post_json(p, || {
        let part = reqwest::multipart::Part::bytes(bytes.clone()).file_name(name.clone());
        let form = reqwest::multipart::Form::new().text("model", m.to_string()).text("response_format", "json").part("file", part);
        http().post(&url).bearer_auth(&k).multipart(form)
    })
    .await?;
    v["text"].as_str().map(str::to_string).ok_or_else(|| anyhow!("OpenAI sent no transcript: {v}"))
}

/// The artifact kind for a file, by extension.
pub fn artifact_kind(path: &Path) -> ArtifactKind {
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => ArtifactKind::Html,
        "md" | "markdown" => ArtifactKind::Markdown,
        "svg" => ArtifactKind::Svg,
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "avif" | "bmp" => ArtifactKind::Image,
        "mp4" | "webm" | "mov" | "mkv" => ArtifactKind::Video,
        "mp3" | "wav" | "ogg" | "flac" | "m4a" | "opus" => ArtifactKind::Audio,
        "pdf" => ArtifactKind::Pdf,
        "json" | "csv" | "tsv" | "xlsx" | "parquet" => ArtifactKind::Data,
        _ => ArtifactKind::Code,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_models() {
        assert_eq!(split("fal:fal-ai/flux/schnell").unwrap(), (ProviderKind::Fal, "fal-ai/flux/schnell"));
        assert_eq!(split("replicate:owner/model:abc").unwrap(), (ProviderKind::Replicate, "owner/model:abc"));
        assert!(split("flux").is_err());
        assert!(split("nope:x").is_err());
    }

    #[test]
    fn picks_extensions_and_urls() {
        assert_eq!(ext_for(Some("image/jpeg; charset=binary"), "", "png"), "jpg");
        assert_eq!(ext_for(None, "https://x.io/a/b.webp?sig=1", "png"), "webp");
        assert_eq!(ext_for(Some("application/octet-stream"), "https://x.io/a/b", "mp4"), "mp4");
        let v = json!({"images":[{"url":"https://fal.media/a.png","width":1}]});
        assert_eq!(first_url(&v["images"]).unwrap(), "https://fal.media/a.png");
        assert_eq!(first_url(&json!(["https://r/x.mp4"])).unwrap(), "https://r/x.mp4");
        assert_eq!(first_url(&json!({"video":{"url":"https://v"}})).unwrap(), "https://v");
        assert_eq!(artifact_kind(Path::new("a/b.MP3")), ArtifactKind::Audio);
    }

    #[tokio::test]
    async fn missing_media_key() {
        let keys = crate::keys::StaticKeys::new();
        let dir = tempfile::tempdir().unwrap();
        let e = generate_image(&keys, "fal:fal-ai/flux/schnell", "a cat", dir.path()).await.unwrap_err();
        assert_eq!(e.to_string(), "Add a fal key in Settings");
        let e = speak(&keys, "elevenlabs:voice", "hi", dir.path()).await.unwrap_err();
        assert_eq!(e.to_string(), "Add an ElevenLabs key in Settings");
    }

    #[tokio::test]
    async fn saves_data_urls() {
        let dir = tempfile::tempdir().unwrap();
        let p = download("data:image/png;base64,aGk=", dir.path(), "image", "bin").await.unwrap();
        assert_eq!(p.extension().unwrap(), "png");
        assert_eq!(std::fs::read(p).unwrap(), b"hi");
    }
}
