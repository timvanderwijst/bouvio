//! Finds which agent CLIs are installed on this machine.

use bouvio_protocol::{HarnessInfo, HarnessKind};
use std::time::Duration;
use tokio::process::Command;

pub async fn detect_harnesses() -> Vec<HarnessInfo> {
    let mut out = Vec::new();
    for kind in HarnessKind::ALL {
        out.push(detect(kind).await);
    }
    out
}

async fn detect(kind: HarnessKind) -> HarnessInfo {
    let Some(bin) = kind.binary() else {
        // The API loop is always there; it needs keys, not a binary.
        return HarnessInfo { kind, available: true, version: None, path: None };
    };
    let Ok(path) = which::which(bin) else {
        return HarnessInfo { kind, available: false, version: None, path: None };
    };
    let version = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new(&path).arg("--version").kill_on_drop(true).output(),
    )
    .await
    .ok()
    .and_then(|r| r.ok())
    .filter(|o| o.status.success())
    .map(|o| String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").trim().to_string())
    .filter(|v| !v.is_empty());

    HarnessInfo { kind, available: true, version, path: Some(path.to_string_lossy().into_owned()) }
}
