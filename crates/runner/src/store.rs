//! Local state of a runner: workspaces, captains, threads and their event logs.
//!
//! Plain JSON files under the data dir. Small, inspectable, easy to move to
//! SQLite once the hub needs queries across them.

use anyhow::{Context, Result};
use bouvio_protocol::{Captain, Thread, ThreadEnvelope, Workspace};
use serde::{de::DeserializeOwned, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

pub struct Store {
    dir: PathBuf,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    workspaces: Vec<Workspace>,
    captains: Vec<Captain>,
    threads: Vec<Thread>,
}

impl Store {
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self> {
        let dir = dir.into();
        fs::create_dir_all(dir.join("events")).with_context(|| format!("create {}", dir.display()))?;
        let state = State {
            workspaces: read_json(&dir.join("workspaces.json"))?,
            captains: read_json(&dir.join("captains.json"))?,
            threads: read_json(&dir.join("threads.json"))?,
        };
        Ok(Self { dir, state: Mutex::new(state) })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn workspaces(&self) -> Vec<Workspace> {
        self.state.lock().unwrap().workspaces.clone()
    }

    pub fn workspace(&self, id: Uuid) -> Option<Workspace> {
        self.state.lock().unwrap().workspaces.iter().find(|w| w.id == id).cloned()
    }

    pub fn put_workspace(&self, ws: Workspace) -> Result<()> {
        let mut s = self.state.lock().unwrap();
        upsert(&mut s.workspaces, ws, |w| w.id);
        write_json(&self.dir.join("workspaces.json"), &s.workspaces)
    }

    pub fn captains(&self, workspace_id: Uuid) -> Vec<Captain> {
        let s = self.state.lock().unwrap();
        s.captains.iter().filter(|c| c.workspace_id == workspace_id).cloned().collect()
    }

    pub fn captain(&self, id: Uuid) -> Option<Captain> {
        self.state.lock().unwrap().captains.iter().find(|c| c.id == id).cloned()
    }

    pub fn put_captain(&self, c: Captain) -> Result<()> {
        let mut s = self.state.lock().unwrap();
        upsert(&mut s.captains, c, |c| c.id);
        write_json(&self.dir.join("captains.json"), &s.captains)
    }

    pub fn threads(&self, workspace_id: Uuid) -> Vec<Thread> {
        let s = self.state.lock().unwrap();
        let mut t: Vec<_> = s.threads.iter().filter(|t| t.workspace_id == workspace_id).cloned().collect();
        t.sort_by_key(|x| std::cmp::Reverse(x.updated_at));
        t
    }

    pub fn thread(&self, id: Uuid) -> Option<Thread> {
        self.state.lock().unwrap().threads.iter().find(|t| t.id == id).cloned()
    }

    pub fn put_thread(&self, t: Thread) -> Result<()> {
        let mut s = self.state.lock().unwrap();
        upsert(&mut s.threads, t, |t| t.id);
        write_json(&self.dir.join("threads.json"), &s.threads)
    }

    /// Change a thread in place and persist it. Returns the new version.
    pub fn update_thread(&self, id: Uuid, f: impl FnOnce(&mut Thread)) -> Result<Option<Thread>> {
        let mut s = self.state.lock().unwrap();
        let Some(t) = s.threads.iter_mut().find(|t| t.id == id) else { return Ok(None) };
        f(t);
        let out = t.clone();
        write_json(&self.dir.join("threads.json"), &s.threads)?;
        Ok(Some(out))
    }

    pub fn append_event(&self, env: &ThreadEnvelope) -> Result<()> {
        let path = self.events_path(env.thread_id);
        let mut f = OpenOptions::new().create(true).append(true).open(&path)?;
        writeln!(f, "{}", serde_json::to_string(env)?)?;
        Ok(())
    }

    pub fn events(&self, thread_id: Uuid) -> Result<Vec<ThreadEnvelope>> {
        let path = self.events_path(thread_id);
        if !path.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for line in BufReader::new(fs::File::open(path)?).lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            // A torn last line after a crash is skipped, not fatal.
            if let Ok(env) = serde_json::from_str(&line) {
                out.push(env);
            }
        }
        Ok(out)
    }

    fn events_path(&self, thread_id: Uuid) -> PathBuf {
        self.dir.join("events").join(format!("{thread_id}.jsonl"))
    }
}

fn upsert<T, K: PartialEq>(v: &mut Vec<T>, item: T, key: impl Fn(&T) -> K) {
    let k = key(&item);
    match v.iter_mut().find(|x| key(x) == k) {
        Some(slot) => *slot = item,
        None => v.push(item),
    }
}

fn read_json<T: DeserializeOwned + Default>(path: &Path) -> Result<T> {
    if !path.exists() {
        return Ok(T::default());
    }
    let raw = fs::read_to_string(path)?;
    serde_json::from_str(&raw).with_context(|| format!("parse {}", path.display()))
}

/// Write via a temp file and rename, so a crash never leaves half a file.
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// A small JSON-file-backed list, for collections that change rarely.
pub struct Collection<T> {
    path: PathBuf,
    items: Mutex<Vec<T>>,
}

impl<T: Clone + Serialize + DeserializeOwned> Collection<T> {
    pub fn open(path: PathBuf) -> Result<Self> {
        let items = read_json(&path)?;
        Ok(Self { path, items: Mutex::new(items) })
    }

    pub fn all(&self) -> Vec<T> {
        self.items.lock().unwrap().clone()
    }

    pub fn filter(&self, f: impl Fn(&T) -> bool) -> Vec<T> {
        self.items.lock().unwrap().iter().filter(|x| f(x)).cloned().collect()
    }

    pub fn find(&self, f: impl Fn(&T) -> bool) -> Option<T> {
        self.items.lock().unwrap().iter().find(|x| f(x)).cloned()
    }

    pub fn put<K: PartialEq>(&self, item: T, key: impl Fn(&T) -> K) -> Result<()> {
        let mut v = self.items.lock().unwrap();
        upsert(&mut v, item, key);
        write_json(&self.path, &*v)
    }

    pub fn update(&self, f: impl Fn(&T) -> bool, change: impl FnOnce(&mut T)) -> Result<Option<T>> {
        let mut v = self.items.lock().unwrap();
        let Some(x) = v.iter_mut().find(|x| f(x)) else { return Ok(None) };
        change(x);
        let out = x.clone();
        write_json(&self.path, &*v)?;
        Ok(Some(out))
    }

    pub fn remove(&self, f: impl Fn(&T) -> bool) -> Result<()> {
        let mut v = self.items.lock().unwrap();
        v.retain(|x| !f(x));
        write_json(&self.path, &*v)
    }
}

/// Read one JSON value from a file, or the default when it does not exist.
pub fn load<T: DeserializeOwned + Default>(path: &Path) -> Result<T> {
    read_json(path)
}

pub fn save<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    write_json(path, value)
}
