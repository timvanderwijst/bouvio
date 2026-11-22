//! Media on this machine: whisper.cpp transcription, Piper speech, ComfyUI images.

use super::{comfy_checkpoints, comfyui_root, config, download, find_piper, find_whisper, which};
use crate::provider::http;
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

const RUN_LIMIT: Duration = Duration::from_secs(30 * 60);

fn command(bin: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    cmd
}

async fn run(mut cmd: tokio::process::Command, what: &str, stdin: Option<&str>) -> Result<String> {
    use tokio::io::AsyncWriteExt;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    let mut child = cmd.spawn().with_context(|| format!("Could not start {what}"))?;
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(text.as_bytes()).await?;
        drop(pipe);
    }
    let out = tokio::time::timeout(RUN_LIMIT, child.wait_with_output())
        .await
        .map_err(|_| anyhow!("{what} did not finish within 30 minutes"))??;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = err.lines().filter(|l| !l.trim().is_empty()).collect();
        let tail = tail[tail.len().saturating_sub(4)..].join("\n");
        bail!("{what} failed ({}): {}", out.status, if tail.is_empty() { "no details" } else { &tail });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

// ---- WAV --------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WavInfo {
    pub rate: u32,
    pub channels: u16,
    pub bits: u16,
    pub format: u16,
}

/// The `fmt ` chunk of a RIFF/WAVE file, wherever it sits among the chunks.
pub(crate) fn wav_info(b: &[u8]) -> Option<WavInfo> {
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return None;
    }
    let mut i = 12;
    while i + 8 <= b.len() {
        let id = &b[i..i + 4];
        let size = u32::from_le_bytes(b[i + 4..i + 8].try_into().ok()?) as usize;
        if id == b"fmt " && i + 8 + 16 <= b.len() {
            let f = &b[i + 8..];
            return Some(WavInfo {
                format: u16::from_le_bytes([f[0], f[1]]),
                channels: u16::from_le_bytes([f[2], f[3]]),
                rate: u32::from_le_bytes([f[4], f[5], f[6], f[7]]),
                bits: u16::from_le_bytes([f[14], f[15]]),
            });
        }
        i += 8 + size + (size & 1);
    }
    None
}

/// What whisper.cpp reads without help: 16 kHz, mono, 16-bit PCM.
pub(crate) fn whisper_ready(b: &[u8]) -> bool {
    wav_info(b).is_some_and(|w| w.rate == 16_000 && w.channels == 1 && w.bits == 16 && w.format == 1)
}

/// A 44-byte header for 16-bit PCM, the same one `toWav16k` in the UI writes.
#[cfg(test)]
pub(crate) fn wav_header(rate: u32, channels: u16, data_len: u32) -> [u8; 44] {
    let mut h = [0u8; 44];
    let block = channels * 2;
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_len).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes());
    h[22..24].copy_from_slice(&channels.to_le_bytes());
    h[24..28].copy_from_slice(&rate.to_le_bytes());
    h[28..32].copy_from_slice(&(rate * block as u32).to_le_bytes());
    h[32..34].copy_from_slice(&block.to_le_bytes());
    h[34..36].copy_from_slice(&16u16.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_len.to_le_bytes());
    h
}

// ---- whisper.cpp ---------------------------------------------------------------------------------

/// Clean whisper.cpp output: one paragraph, no `[BLANK_AUDIO]`-style markers.
pub(crate) fn clean_transcript(s: &str) -> String {
    let re = regex::Regex::new(r"\[[A-Z_ ]+\]|\([a-z ]*(music|silence|noise)[a-z ]*\)").expect("regex");
    let joined = s.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ");
    re.replace_all(&joined, "").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `local:whisper-<size>` (or `local:whisper` for the configured size).
pub(crate) async fn transcribe(size: Option<&str>, file: &Path) -> Result<String> {
    let size = size.filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| config().whisper_size);
    let bin = find_whisper()
        .await
        .ok_or_else(|| anyhow!("whisper.cpp is not installed. Install it (whisper-cli) or set its path in Settings → Local models."))?;
    let model = download("whisper", &size, |_| {}).await?;
    let head = tokio::fs::read(file).await.with_context(|| format!("Cannot read {}", file.display()))?;
    let mut tmp: Option<PathBuf> = None;
    let input = if whisper_ready(&head) {
        file.to_path_buf()
    } else if let Some(ff) = which("ffmpeg") {
        let out = std::env::temp_dir().join(format!("cuna-{}.wav", uuid::Uuid::new_v4().simple()));
        let mut cmd = command(&ff);
        cmd.arg("-nostdin").arg("-y").arg("-i").arg(file).args(["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"]).arg(&out);
        run(cmd, "ffmpeg", None).await?;
        tmp = Some(out.clone());
        out
    } else {
        // whisper.cpp builds with miniaudio read other formats themselves.
        file.to_path_buf()
    };
    let mut cmd = command(&bin);
    cmd.arg("-m").arg(&model).arg("-f").arg(&input).args(["-nt", "-np", "-l", "auto"]);
    let r = run(cmd, "whisper.cpp", None).await;
    if let Some(t) = tmp {
        let _ = tokio::fs::remove_file(t).await;
    }
    let text = clean_transcript(&r?);
    if text.is_empty() {
        bail!("whisper.cpp heard nothing in this recording");
    }
    Ok(text)
}

// ---- Piper --------------------------------------------------------------------------------------

/// `local:piper/<voice>` (or `local:piper` for the configured voice). Writes a WAV.
pub(crate) async fn speak(voice: Option<&str>, text: &str, out: &Path) -> Result<()> {
    let voice = voice.filter(|v| !v.is_empty()).map(str::to_string).unwrap_or_else(|| config().piper_voice);
    let bin = find_piper().ok_or_else(|| anyhow!("Piper is not installed. Install it or set its path in Settings → Local models."))?;
    let model = download("piper", &voice, |_| {}).await?;
    let mut cmd = command(&bin);
    // `-m`/`-f` work in both the C++ Piper and the Python `piper-tts` CLI.
    cmd.arg("-m").arg(&model).arg("-f").arg(out);
    run(cmd, "Piper", Some(text)).await?;
    if !out.is_file() {
        bail!("Piper wrote no audio");
    }
    Ok(())
}

// ---- ComfyUI ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ComfyParams {
    pub width: u32,
    pub height: u32,
    pub steps: u32,
    pub cfg: f32,
    pub sampler: &'static str,
    pub scheduler: &'static str,
}

/// Sensible settings for a checkpoint by its name: SDXL-class at 1024², SD 1.5 at
/// 512², few steps and low CFG for turbo/lightning/schnell distillations.
pub(crate) fn comfy_params(ckpt: &str) -> ComfyParams {
    let n = ckpt.to_ascii_lowercase();
    let big = ["xl", "pony", "illustrious", "flux", "sd3", "juggernaut"].iter().any(|k| n.contains(k));
    let fast = ["turbo", "lightning", "schnell", "lcm", "hyper"].iter().any(|k| n.contains(k));
    let side = if big { 1024 } else { 512 };
    ComfyParams {
        width: side,
        height: side,
        steps: if fast { 6 } else { 25 },
        cfg: if fast { 1.5 } else if n.contains("flux") { 1.0 } else { 6.5 },
        sampler: if fast { "euler_ancestral" } else { "dpmpp_2m" },
        scheduler: if fast { "sgm_uniform" } else { "karras" },
    }
}

const NEGATIVE: &str = "blurry, low quality, deformed, watermark, text, signature";

/// The classic txt2img graph: checkpoint → prompts → empty latent → KSampler →
/// VAE decode → SaveImage (node "9").
pub(crate) fn comfy_workflow(ckpt: &str, prompt: &str, seed: u64, p: &ComfyParams) -> Value {
    json!({
        "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": ckpt } },
        "5": { "class_type": "EmptyLatentImage", "inputs": { "width": p.width, "height": p.height, "batch_size": 1 } },
        "6": { "class_type": "CLIPTextEncode", "inputs": { "text": prompt, "clip": ["4", 1] } },
        "7": { "class_type": "CLIPTextEncode", "inputs": { "text": NEGATIVE, "clip": ["4", 1] } },
        "3": { "class_type": "KSampler", "inputs": {
            "seed": seed, "steps": p.steps, "cfg": p.cfg, "sampler_name": p.sampler, "scheduler": p.scheduler, "denoise": 1.0,
            "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]
        } },
        "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
        "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": "cuna", "images": ["8", 0] } }
    })
}

/// The first image of a finished `/history/<id>` entry, or the error it reports.
pub(crate) fn comfy_result(entry: &Value) -> Option<Result<(String, String, String)>> {
    let status = &entry["status"];
    if status["status_str"] == "error" {
        let msg = status["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| m[0] == "execution_error")
            .find_map(|m| m[1]["exception_message"].as_str())
            .unwrap_or("the workflow failed");
        return Some(Err(anyhow!("ComfyUI: {}", msg.trim())));
    }
    let outputs = entry["outputs"].as_object()?;
    let img = outputs.values().find_map(|o| o["images"].as_array().and_then(|a| a.first()))?;
    Some(Ok((
        img["filename"].as_str()?.to_string(),
        img["subfolder"].as_str().unwrap_or("").to_string(),
        img["type"].as_str().unwrap_or("output").to_string(),
    )))
}

/// `comfyui:<checkpoint>` or `comfyui:default` (the first checkpoint ComfyUI has).
pub(crate) async fn comfy_image(ckpt: &str, prompt: &str) -> Result<(Vec<u8>, Option<String>)> {
    let root = comfyui_root();
    let unreachable = |e: reqwest::Error| anyhow!("Could not reach ComfyUI at {root}: {e}. Is it running?");
    let ckpt = if ckpt.is_empty() || ckpt == "default" {
        comfy_checkpoints()
            .await
            .map_err(|e| anyhow!("Could not reach ComfyUI at {root}: {e:#}. Is it running?"))?
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("ComfyUI has no checkpoints; put one in its models/checkpoints folder"))?
    } else {
        ckpt.to_string()
    };
    let seed = (uuid::Uuid::new_v4().as_u128() as u64) & ((1u64 << 48) - 1);
    let body = json!({ "prompt": comfy_workflow(&ckpt, prompt, seed, &comfy_params(&ckpt)), "client_id": "cuna" });
    let resp = http().post(format!("{root}/prompt")).json(&body).send().await.map_err(unreachable)?;
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let why = v["error"]["message"].as_str().or(v["error"].as_str()).unwrap_or("rejected the workflow");
        let detail = v["node_errors"].as_object().and_then(|n| n.values().next()).and_then(|n| n["errors"][0]["details"].as_str()).unwrap_or("");
        bail!("ComfyUI {why}{}{detail}", if detail.is_empty() { "" } else { ": " });
    }
    let id = v["prompt_id"].as_str().ok_or_else(|| anyhow!("ComfyUI did not queue the prompt: {v}"))?.to_string();
    let started = Instant::now();
    let (file, sub, kind) = loop {
        tokio::time::sleep(Duration::from_millis(800)).await;
        let h: Value = http().get(format!("{root}/history/{id}")).send().await.map_err(unreachable)?.json().await.unwrap_or(Value::Null);
        if let Some(r) = comfy_result(&h[&id]) {
            break r?;
        }
        if started.elapsed() > RUN_LIMIT {
            bail!("ComfyUI did not finish within 30 minutes");
        }
    };
    let resp = http().get(format!("{root}/view")).query(&[("filename", file.as_str()), ("subfolder", sub.as_str()), ("type", kind.as_str())]).send().await.map_err(unreachable)?;
    if !resp.status().is_success() {
        bail!("Downloading the image from ComfyUI failed: {}", resp.status());
    }
    let ctype = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_string);
    Ok((resp.bytes().await?.to_vec(), ctype))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_roundtrip() {
        let h = wav_header(16_000, 1, 3200);
        assert_eq!(&h[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(h[4..8].try_into().unwrap()), 36 + 3200);
        assert_eq!(u32::from_le_bytes(h[28..32].try_into().unwrap()), 32_000);
        assert_eq!(u16::from_le_bytes(h[32..34].try_into().unwrap()), 2);
        let mut file = h.to_vec();
        file.extend(vec![0u8; 3200]);
        assert_eq!(wav_info(&file), Some(WavInfo { rate: 16_000, channels: 1, bits: 16, format: 1 }));
        assert!(whisper_ready(&file));
        assert!(!whisper_ready(&wav_header(44_100, 2, 0)));
        assert!(!whisper_ready(b"\x1aE\xdf\xa3webm"));
    }

    #[test]
    fn wav_fmt_after_other_chunks() {
        // RIFF, WAVE, a LIST chunk of odd size (padded), then fmt.
        let h = wav_header(16_000, 1, 0);
        let mut b = h[0..12].to_vec();
        b.extend_from_slice(b"LIST");
        b.extend_from_slice(&3u32.to_le_bytes());
        b.extend_from_slice(b"abc\0");
        b.extend_from_slice(&h[12..]);
        assert_eq!(wav_info(&b).unwrap().rate, 16_000);
    }

    #[test]
    fn cleans_transcripts() {
        assert_eq!(clean_transcript(" Hello there.\n\n [BLANK_AUDIO]\n How are you? \n"), "Hello there. How are you?");
        assert_eq!(clean_transcript("(soft music) Hi"), "Hi");
    }

    #[test]
    fn builds_comfy_workflow() {
        let p = comfy_params("sd_xl_base_1.0.safetensors");
        assert_eq!((p.width, p.height, p.steps), (1024, 1024, 25));
        let fast = comfy_params("sdxl_turbo_1.0_fp16.safetensors");
        assert_eq!(fast.steps, 6);
        assert!(fast.cfg < 2.0);
        assert_eq!(comfy_params("v1-5-pruned-emaonly.safetensors").width, 512);

        let w = comfy_workflow("v1-5-pruned-emaonly.safetensors", "a red fox", 42, &comfy_params("v1-5"));
        assert_eq!(w["4"]["inputs"]["ckpt_name"], "v1-5-pruned-emaonly.safetensors");
        assert_eq!(w["6"]["inputs"]["text"], "a red fox");
        assert_eq!(w["3"]["inputs"]["seed"], 42);
        assert_eq!(w["3"]["inputs"]["positive"], json!(["6", 0]));
        assert_eq!(w["3"]["inputs"]["negative"], json!(["7", 0]));
        assert_eq!(w["3"]["inputs"]["latent_image"], json!(["5", 0]));
        assert_eq!(w["8"]["inputs"]["vae"], json!(["4", 2]));
        assert_eq!(w["9"]["class_type"], "SaveImage");
        // Every link points at a node that exists.
        let nodes = w.as_object().unwrap();
        for node in nodes.values() {
            for input in node["inputs"].as_object().unwrap().values() {
                if let Some(link) = input.as_array() {
                    assert!(nodes.contains_key(link[0].as_str().unwrap()));
                }
            }
        }
    }

    #[test]
    fn reads_comfy_history() {
        let done = json!({"outputs":{"9":{"images":[{"filename":"cuna_00001_.png","subfolder":"","type":"output"}]}},"status":{"status_str":"success","completed":true}});
        let (f, s, t) = comfy_result(&done).unwrap().unwrap();
        assert_eq!((f.as_str(), s.as_str(), t.as_str()), ("cuna_00001_.png", "", "output"));
        let failed = json!({"outputs":{},"status":{"status_str":"error","messages":[["execution_start",{}],["execution_error",{"exception_message":"CUDA out of memory\n"}]]}});
        assert_eq!(comfy_result(&failed).unwrap().unwrap_err().to_string(), "ComfyUI: CUDA out of memory");
        assert!(comfy_result(&Value::Null).is_none());
        assert!(comfy_result(&json!({"outputs":{},"status":{"status_str":"success"}})).is_none());
    }
}
