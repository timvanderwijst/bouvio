//! Shell commands: `bash -lc` on Unix, `cmd /C` on Windows. The whole process
//! tree is killed on timeout or cancel.

use super::{truncate_middle, Tool, ToolCtx};
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;
const MAX_OUTPUT: usize = 30_000;

pub struct Bash;

#[async_trait]
impl Tool for Bash {
    fn name(&self) -> &str {
        "bash"
    }
    fn display_name(&self) -> &str {
        "Bash"
    }
    fn description(&self) -> &str {
        if cfg!(windows) {
            "Run a command with `cmd /C` in the working directory. Returns stdout and stderr together. Times out after 120 s unless timeout_ms says otherwise (max 600000). Do not start interactive programs."
        } else {
            "Run a command with `bash -lc` in the working directory. Returns stdout and stderr together. Times out after 120 s unless timeout_ms says otherwise (max 600000). Do not start interactive programs."
        }
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": { "type": "string" },
                "timeout_ms": { "type": "integer", "description": "Timeout in milliseconds (default 120000)" },
                "description": { "type": "string", "description": "A few words on what the command does" }
            },
            "required": ["command"]
        })
    }
    fn risky(&self, _input: &Value) -> bool {
        true
    }
    async fn call(&self, input: Value, ctx: &ToolCtx) -> Result<String> {
        let command = input["command"].as_str().filter(|c| !c.trim().is_empty()).ok_or_else(|| anyhow!("Missing `command`"))?;
        let timeout = input["timeout_ms"].as_u64().unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1, MAX_TIMEOUT_MS);
        run(command, ctx, Duration::from_millis(timeout)).await
    }
}

fn command(cmdline: &str) -> Command {
    #[cfg(windows)]
    {
        let mut c = Command::new("cmd");
        c.arg("/C").raw_arg(cmdline);
        // CREATE_NO_WINDOW: no console flashing up from the desktop app.
        c.creation_flags(0x0800_0000);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("bash");
        c.arg("-lc").arg(cmdline);
        // Own process group, so the whole tree can be killed.
        c.process_group(0);
        c
    }
}

fn kill_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
        // SAFETY: plain syscall; a negative pid addresses the process group we created.
        libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Kills the process tree when dropped while armed (the turn was dropped mid-command).
struct TreeGuard {
    pid: Option<u32>,
    armed: bool,
}

impl Drop for TreeGuard {
    fn drop(&mut self) {
        if self.armed {
            if let Some(pid) = self.pid {
                kill_tree(pid);
            }
        }
    }
}

enum Ended {
    Exited(std::process::ExitStatus),
    TimedOut,
    Cancelled,
}

pub(crate) async fn run(cmdline: &str, ctx: &ToolCtx, timeout: Duration) -> Result<String> {
    let mut child = command(cmdline)
        .current_dir(&ctx.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("Could not start the shell")?;
    let mut guard = TreeGuard { pid: child.id(), armed: true };

    let buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let mut readers = Vec::new();
    let stdout = child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Send + Unpin>);
    let stderr = child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Send + Unpin>);
    for mut stream in [stdout, stderr].into_iter().flatten() {
        let buf = buf.clone();
        readers.push(tokio::spawn(async move {
            let mut chunk = [0u8; 8192];
            while let Ok(n) = stream.read(&mut chunk).await {
                if n == 0 {
                    break;
                }
                let mut b = buf.lock().unwrap();
                // Keep memory bounded; the tail is what usually matters, but the head
                // has the first error. Stop growing past 4 MB.
                if b.len() < 4 << 20 {
                    b.extend_from_slice(&chunk[..n]);
                }
            }
        }));
    }

    let ended = tokio::select! {
        s = child.wait() => Ended::Exited(s?),
        _ = tokio::time::sleep(timeout) => Ended::TimedOut,
        _ = ctx.cancel.cancelled() => Ended::Cancelled,
    };
    if !matches!(ended, Ended::Exited(_)) {
        if let Some(pid) = guard.pid {
            kill_tree(pid);
        }
        let _ = child.kill().await;
    }
    guard.armed = false;
    // A background process can hold the pipes open; don't wait on it for long.
    let _ = tokio::time::timeout(Duration::from_secs(2), futures::future::join_all(readers)).await;
    let output = {
        let b = buf.lock().unwrap();
        truncate_middle(String::from_utf8_lossy(&b).trim_end(), MAX_OUTPUT)
    };
    match ended {
        Ended::Cancelled => bail!("Cancelled; the command was stopped.\n{output}"),
        Ended::TimedOut => bail!("{output}\n[Timed out after {} s; the command was stopped]", timeout.as_secs_f32()),
        Ended::Exited(status) if !status.success() => {
            let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "killed by a signal".into());
            bail!("{output}\n[Exit code {code}]")
        }
        Ended::Exited(_) => Ok(if output.is_empty() { "(no output)".into() } else { output }),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Instant;
    use tokio_util::sync::CancellationToken;

    fn ctx() -> ToolCtx {
        ToolCtx { cwd: std::env::temp_dir(), cancel: CancellationToken::new() }
    }

    #[tokio::test]
    async fn captures_output_and_exit_code() {
        let out = Bash.call(json!({"command":"echo out; echo err >&2"}), &ctx()).await.unwrap();
        assert!(out.contains("out") && out.contains("err"), "{out}");
        let err = Bash.call(json!({"command":"echo nope; exit 3"}), &ctx()).await.unwrap_err().to_string();
        assert!(err.contains("nope") && err.contains("[Exit code 3]"), "{err}");
    }

    #[tokio::test]
    async fn times_out_and_kills_children() {
        let t = Instant::now();
        let err = Bash
            .call(json!({"command":"echo started; sleep 30 & sleep 30","timeout_ms":300}), &ctx())
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("started") && err.contains("Timed out"), "{err}");
        assert!(t.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn cancel_stops_the_command() {
        let c = ctx();
        let cancel = c.cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            cancel.cancel();
        });
        let t = Instant::now();
        let err = Bash.call(json!({"command":"sleep 30"}), &c).await.unwrap_err().to_string();
        assert!(err.starts_with("Cancelled"), "{err}");
        assert!(t.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn bash_is_always_risky() {
        assert!(Bash.risky(&json!({"command":"ls"})));
    }
}
