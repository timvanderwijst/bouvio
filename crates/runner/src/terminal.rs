//! Real terminals (pty on Unix, ConPTY on Windows) that anyone in a thread can watch.

use anyhow::{Context, Result};
use cuna_protocol::{TerminalChunk, TerminalExit};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use tokio::sync::broadcast;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub enum TerminalOut {
    Chunk(TerminalChunk),
    Exit(TerminalExit),
}

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

pub struct Terminals {
    terms: Mutex<HashMap<Uuid, Term>>,
    owners: Mutex<HashMap<Uuid, Uuid>>,
    tx: broadcast::Sender<TerminalOut>,
}

impl Terminals {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(1024);
        Self { terms: Mutex::new(HashMap::new()), owners: Mutex::new(HashMap::new()), tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TerminalOut> {
        self.tx.subscribe()
    }

    pub fn open(&self, cwd: &Path, cols: u16, rows: u16) -> Result<Uuid> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .context("open pty")?;
        let mut cmd = CommandBuilder::new(default_shell());
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(cmd).context("spawn shell")?;
        drop(pair.slave);

        let id = Uuid::new_v4();
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let killer = child.clone_killer();

        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        // Only send whole UTF-8 characters; keep a split one for the next read.
                        let valid = match std::str::from_utf8(&pending) {
                            Ok(_) => pending.len(),
                            Err(e) if e.error_len().is_none() => e.valid_up_to(),
                            Err(_) => pending.len(),
                        };
                        let data = String::from_utf8_lossy(&pending[..valid]).into_owned();
                        pending.drain(..valid);
                        let _ = tx.send(TerminalOut::Chunk(TerminalChunk { terminal_id: id, data }));
                    }
                }
            }
            let code = child.wait().ok().map(|s| s.exit_code());
            let _ = tx.send(TerminalOut::Exit(TerminalExit { terminal_id: id, code }));
        });

        self.terms.lock().unwrap().insert(id, Term { master: pair.master, writer, killer });
        Ok(id)
    }

    /// Remember which workspace a terminal belongs to, so its output reaches that workspace's members.
    pub fn set_workspace(&self, id: Uuid, workspace_id: Uuid) {
        self.owners.lock().unwrap().insert(id, workspace_id);
    }

    pub fn workspace_of(&self, id: Uuid) -> Option<Uuid> {
        self.owners.lock().unwrap().get(&id).copied()
    }

    pub fn write(&self, id: Uuid, data: &str) -> Result<()> {
        let mut terms = self.terms.lock().unwrap();
        let t = terms.get_mut(&id).context("no such terminal")?;
        t.writer.write_all(data.as_bytes())?;
        t.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: Uuid, cols: u16, rows: u16) -> Result<()> {
        let terms = self.terms.lock().unwrap();
        let t = terms.get(&id).context("no such terminal")?;
        t.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
        Ok(())
    }

    pub fn close(&self, id: Uuid) -> Result<()> {
        self.owners.lock().unwrap().remove(&id);
        if let Some(mut t) = self.terms.lock().unwrap().remove(&id) {
            let _ = t.killer.kill();
        }
        Ok(())
    }
}

impl Default for Terminals {
    fn default() -> Self {
        Self::new()
    }
}

fn default_shell() -> String {
    if cfg!(windows) {
        // PowerShell 7 if present, else the one that ships with Windows.
        if which::which("pwsh").is_ok() { "pwsh".into() } else { "powershell.exe".into() }
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}
