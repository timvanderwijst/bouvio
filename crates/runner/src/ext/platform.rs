//! Platform: backup and export, workspace templates.
//!
//! - `list_templates`, `apply_template`, `create_workspace_from_template`: the
//!   templates in `templates/*.json` at the repository root, built in.
//! - `export_workspace`, `import_workspace`: one workspace as a zip, and back,
//!   either as a copy with fresh ids or restored over the original.

use crate::{store, Runner};
use anyhow::{bail, Context, Result};
use bouvio_protocol::platform::*;
use bouvio_protocol::*;
use chrono::Utc;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

pub async fn call(r: &Arc<Runner>, method: &str, params: &Value, _actor: &str) -> Option<Result<Value>> {
    let out = match method {
        "list_templates" => to_value(templates()),
        "apply_template" => (|| {
            let ws: Uuid = p(params, "workspace_id")?;
            let id: String = p(params, "template_id")?;
            to_value(apply_template(r, ws, &id, opt(params, "harness"))?)
        })(),
        "create_workspace_from_template" => (|| {
            let id: String = p(params, "template_id")?;
            let tpl = template(&id)?;
            let name = opt::<String>(params, "name").filter(|n| !n.trim().is_empty()).unwrap_or(tpl.name);
            let ws = r.create_workspace(name.trim().to_string(), opt::<String>(params, "root").filter(|s| !s.is_empty()))?;
            apply_template(r, ws.id, &id, opt(params, "harness"))?;
            to_value(ws)
        })(),
        "export_workspace" => {
            let (r, params) = (r.clone(), params.clone());
            blocking(move || {
                let ws: Uuid = p(&params, "workspace_id")?;
                let path: String = p(&params, "path")?;
                to_value(export_workspace(&r, ws, Path::new(&path))?)
            })
            .await
        }
        "import_workspace" => {
            let (r, params) = (r.clone(), params.clone());
            blocking(move || {
                let path: String = p(&params, "path")?;
                let opts = ImportOptions {
                    replace: opt(&params, "replace").unwrap_or(false),
                    name: opt::<String>(&params, "name").filter(|n| !n.trim().is_empty()),
                    root: opt::<String>(&params, "root").filter(|s| !s.is_empty()),
                };
                to_value(import_workspace(&r, Path::new(&path), opts)?)
            })
            .await
        }
        _ => return None,
    };
    Some(out)
}

pub fn workspace_of(_r: &Runner, method: &str, _params: &Value) -> Option<Result<Uuid>> {
    // These create workspaces or read local files: only on your own machine.
    match method {
        "import_workspace" | "create_workspace_from_template" | "list_templates" => Some(Err(anyhow::anyhow!("`{method}` is not available through the hub"))),
        _ => None,
    }
}

pub fn start(_r: &Arc<Runner>) {}

fn p<T: DeserializeOwned>(params: &Value, key: &str) -> Result<T> {
    serde_json::from_value(params.get(key).cloned().unwrap_or(Value::Null)).with_context(|| format!("param `{key}`"))
}

fn opt<T: DeserializeOwned>(params: &Value, key: &str) -> Option<T> {
    params.get(key).cloned().and_then(|v| serde_json::from_value(v).ok())
}

fn to_value<T: serde::Serialize>(v: T) -> Result<Value> {
    Ok(serde_json::to_value(v)?)
}

async fn blocking(f: impl FnOnce() -> Result<Value> + Send + 'static) -> Result<Value> {
    tokio::task::spawn_blocking(f).await.context("background task failed")?
}

// ---- templates ---------------------------------------------------------------------------

const TEMPLATES: &[&str] = &[
    include_str!("../../../../templates/web-app.json"),
    include_str!("../../../../templates/marketing-campaign.json"),
    include_str!("../../../../templates/finance-analysis.json"),
    include_str!("../../../../templates/research-project.json"),
    include_str!("../../../../templates/personal-assistant.json"),
];

pub fn templates() -> Vec<WorkspaceTemplate> {
    TEMPLATES.iter().filter_map(|s| serde_json::from_str(s).map_err(|e| tracing::warn!("template: {e}")).ok()).collect()
}

fn template(id: &str) -> Result<WorkspaceTemplate> {
    templates().into_iter().find(|t| t.id == id).with_context(|| format!("no template `{id}`"))
}

/// Add a template's leads, instructions, issues and automations to a
/// workspace. Leads that already exist by name are reused, not doubled.
pub fn apply_template(r: &Runner, workspace_id: Uuid, template_id: &str, harness: Option<HarnessKind>) -> Result<TemplateApplied> {
    let tpl = template(template_id)?;
    r.workspace(workspace_id).context("unknown workspace")?;
    let mut out = TemplateApplied::default();

    let mut by_name: HashMap<String, Uuid> = r.leads(workspace_id).into_iter().map(|c| (c.name.to_lowercase(), c.id)).collect();
    for c in &tpl.leads {
        if by_name.contains_key(&c.name.to_lowercase()) {
            continue;
        }
        let made = r.create_lead(NewLead {
            workspace_id,
            name: c.name.clone(),
            instructions: c.instructions.clone(),
            harness: harness.unwrap_or(HarnessKind::ClaudeCode),
            model: None,
            effort: Effort::Medium,
            approval: ApprovalLevel::AskRisky,
        })?;
        by_name.insert(c.name.to_lowercase(), made.id);
        out.leads += 1;
    }
    let lead = |name: &Option<String>| name.as_ref().and_then(|n| by_name.get(&n.to_lowercase()).copied());

    let mut s = r.settings(workspace_id);
    let mut changed = false;
    let extra = tpl.instructions.trim();
    if !extra.is_empty() && !s.instructions.contains(extra) {
        s.instructions = if s.instructions.trim().is_empty() { extra.to_string() } else { format!("{}\n\n{extra}", s.instructions.trim_end()) };
        changed = true;
    }
    if s.dev_command.is_none() && tpl.dev_command.is_some() {
        s.dev_command = tpl.dev_command.clone();
        changed = true;
    }
    if changed {
        r.set_settings(workspace_id, &s)?;
    }

    for i in &tpl.issues {
        r.create_issue(workspace_id, i.title.clone(), i.body.clone(), Some(IssueStatus::Todo), lead(&i.lead))?;
        out.issues += 1;
    }
    for a in &tpl.automations {
        r.save_automation(Automation {
            id: Uuid::nil(),
            workspace_id,
            name: a.name.clone(),
            schedule: a.schedule.clone(),
            prompt: a.prompt.clone(),
            lead_id: lead(&a.lead),
            enabled: a.enabled,
            last_run: None,
            last_thread: None,
        })?;
        out.automations += 1;
    }
    Ok(out)
}

// ---- export ------------------------------------------------------------------------------

const FORMAT: &str = "bouvio-workspace";
const VERSION: u32 = 1;
/// Artifact files go in until they would pass this; their metadata always does.
const ARTIFACT_BUDGET: u64 = 50 * 1024 * 1024;
/// Top-level folders of the data dir that are never copied as per-workspace data:
/// handled on their own (events, boards), machine-bound (worktrees, tmp) or
/// carried as artifacts (media).
const SKIP_DIRS: &[&str] = &["events", "boards", "worktrees", "media", "tmp", "plugins"];

/// Write one workspace to a zip: records, event logs, boards, settings, other
/// areas' per-workspace folders (`<area>/<workspace>/…`, `<area>/<workspace>.json`)
/// and artifact files up to 50 MB.
pub fn export_workspace(r: &Runner, workspace_id: Uuid, path: &Path) -> Result<ExportSummary> {
    let ws = r.workspace(workspace_id).context("unknown workspace")?;
    if ws.host.is_some() {
        bail!("export a shared workspace on the machine that hosts it");
    }
    let dir = r.store().dir().to_path_buf();
    let tmp = path.with_extension("zip.part");
    let file = fs::File::create(&tmp).with_context(|| format!("create {}", tmp.display()))?;
    let mut z = zip::ZipWriter::new(file);
    let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(true);
    let put = |z: &mut zip::ZipWriter<fs::File>, name: &str, bytes: &[u8]| -> Result<()> {
        z.start_file(name, o)?;
        z.write_all(bytes)?;
        Ok(())
    };

    let leads = r.leads(workspace_id);
    let threads = r.threads(workspace_id);
    let issues = r.list_issues(workspace_id);
    let automations = r.list_automations(workspace_id);
    let artifacts = r.artifacts.filter(|a| a.workspace_id == workspace_id);
    let mut summary = ExportSummary { path: path.to_string_lossy().into_owned(), threads: threads.len() as u32, ..Default::default() };

    put(
        &mut z,
        "manifest.json",
        &serde_json::to_vec_pretty(&json!({
            "format": FORMAT,
            "version": VERSION,
            "exported_at": Utc::now(),
            "app_version": env!("CARGO_PKG_VERSION"),
            "workspace_id": workspace_id,
        }))?,
    )?;
    put(&mut z, "workspace.json", &serde_json::to_vec_pretty(&ws)?)?;
    put(&mut z, "leads.json", &serde_json::to_vec_pretty(&leads)?)?;
    put(&mut z, "threads.json", &serde_json::to_vec_pretty(&threads)?)?;
    put(&mut z, "issues.json", &serde_json::to_vec_pretty(&issues)?)?;
    put(&mut z, "automations.json", &serde_json::to_vec_pretty(&automations)?)?;
    put(&mut z, "artifacts.json", &serde_json::to_vec_pretty(&artifacts)?)?;

    for t in &threads {
        if let Ok(bytes) = fs::read(dir.join("events").join(format!("{}.jsonl", t.id))) {
            put(&mut z, &format!("events/{}.jsonl", t.id), &bytes)?;
        }
    }
    for b in r.list_boards(workspace_id) {
        if let Ok(full) = r.get_board(b.id) {
            put(&mut z, &format!("boards/{}.json", b.id), &serde_json::to_vec_pretty(&full)?)?;
        }
    }

    // Other areas' per-workspace data, found by name so new areas are included.
    let ws_name = workspace_id.to_string();
    for top in fs::read_dir(&dir).into_iter().flatten().flatten() {
        let top_name = top.file_name().to_string_lossy().into_owned();
        if !top.path().is_dir() || SKIP_DIRS.contains(&top_name.as_str()) || top_name.starts_with('.') {
            continue;
        }
        let sub = top.path().join(&ws_name);
        if sub.is_dir() {
            for (rel, abs) in walk(&sub) {
                put(&mut z, &format!("dirs/{top_name}/{rel}"), &fs::read(abs)?)?;
            }
        }
        for f in fs::read_dir(top.path()).into_iter().flatten().flatten() {
            let name = f.file_name().to_string_lossy().into_owned();
            if f.path().is_file() && name.starts_with(&ws_name) {
                put(&mut z, &format!("files/{top_name}/{}", name.replacen(&ws_name, "@", 1)), &fs::read(f.path())?)?;
            }
        }
    }

    let mut used = 0u64;
    for a in &artifacts {
        let src = Path::new(&a.path);
        let Ok(meta) = fs::metadata(src) else { continue };
        if !meta.is_file() || used + meta.len() > ARTIFACT_BUDGET {
            summary.artifacts_skipped += 1;
            continue;
        }
        let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
        put(&mut z, &format!("artifact-files/{}/{}", a.id, name), &fs::read(src)?)?;
        used += meta.len();
        summary.artifacts += 1;
    }

    z.finish()?;
    fs::rename(&tmp, path).with_context(|| format!("write {}", path.display()))?;
    summary.bytes = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    Ok(summary)
}

/// Files under `root`, as (`a/b.txt`, absolute path).
fn walk(root: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).into_iter().flatten().flatten() {
            let path = e.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push((rel.to_string_lossy().replace('\\', "/"), path));
            }
        }
    }
    out.sort();
    out
}

// ---- import ------------------------------------------------------------------------------

#[derive(Default)]
pub struct ImportOptions {
    /// Keep the original ids and restore over a workspace with the same id.
    pub replace: bool,
    pub name: Option<String>,
    pub root: Option<String>,
}

/// Read a workspace zip. Without `replace`, everything gets fresh ids, remapped
/// consistently wherever the old ones appear (events, issue links, leads,
/// boards, other areas' JSON).
pub fn import_workspace(r: &Runner, path: &Path, o: ImportOptions) -> Result<ImportSummary> {
    let file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut z = zip::ZipArchive::new(file).context("not a zip file")?;
    let mut entries: HashMap<String, Vec<u8>> = HashMap::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i)?;
        if f.is_dir() {
            continue;
        }
        let name = f.name()?.into_owned();
        let mut buf = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut buf)?;
        entries.insert(name, buf);
    }
    let read = |name: &str| -> Result<Value> {
        let b = entries.get(name).with_context(|| format!("the backup has no {name}"))?;
        Ok(serde_json::from_slice(b)?)
    };

    let manifest = read("manifest.json").context("not a Bouvio workspace export")?;
    if manifest["format"] != FORMAT {
        bail!("not a Bouvio workspace export");
    }
    if manifest["version"].as_u64().unwrap_or(0) > VERSION as u64 {
        bail!("this backup was made by a newer Bouvio; update the app first");
    }

    let ws_old: Workspace = serde_json::from_value(read("workspace.json")?)?;
    let leads = read("leads.json")?;
    let threads = read("threads.json")?;
    let issues = read("issues.json")?;
    let automations = read("automations.json")?;
    let artifacts = read("artifacts.json")?;

    // Every id this workspace owns, old -> new.
    let mut ids: HashMap<String, String> = HashMap::new();
    if !o.replace {
        let mut fresh = |id: Option<&str>| {
            if let Some(id) = id {
                ids.entry(id.to_string()).or_insert_with(|| Uuid::new_v4().to_string());
            }
        };
        fresh(Some(&ws_old.id.to_string()));
        for list in [&leads, &threads, &issues, &automations, &artifacts] {
            for x in list.as_array().into_iter().flatten() {
                fresh(x["id"].as_str());
            }
        }
        for name in entries.keys() {
            if let Some(id) = name.strip_prefix("boards/").and_then(|n| n.strip_suffix(".json")) {
                fresh(Some(id));
            }
        }
    }
    let map = |v: Value| remap(v, &ids);
    let new_id = |old: Uuid| ids.get(&old.to_string()).and_then(|s| s.parse().ok()).unwrap_or(old);
    let ws_id = new_id(ws_old.id);
    let dir = r.store().dir().to_path_buf();

    // A copy next to the original on the same machine must not run its automations twice.
    let beside_original = !o.replace && r.workspace(ws_old.id).is_some();

    let root = o.root.or_else(|| ws_old.root.clone().filter(|p| Path::new(p).is_dir()));
    let ws = Workspace {
        id: ws_id,
        name: o.name.unwrap_or_else(|| ws_old.name.clone()),
        kind: WorkspaceKind::Personal,
        root: root.clone(),
        created_at: if o.replace { ws_old.created_at } else { Utc::now() },
        role: None,
        host: None,
    };
    r.put_workspace(ws.clone())?;

    let leads: Vec<Lead> = serde_json::from_value(map(leads))?;
    for c in &leads {
        r.store().put_lead(c.clone())?;
    }

    let threads: Vec<Thread> = serde_json::from_value(map(threads))?;
    for mut t in threads.clone() {
        t.status = AgentStatus::Idle;
        if !t.cwd.as_deref().is_some_and(|c| Path::new(c).is_dir()) {
            t.cwd = root.clone();
        }
        if !o.replace {
            t.session_id = None;
        }
        r.store().put_thread(t)?;
    }
    fs::create_dir_all(dir.join("events"))?;
    for (name, bytes) in &entries {
        let Some(old) = name.strip_prefix("events/").and_then(|n| n.strip_suffix(".jsonl")) else { continue };
        let Ok(old) = old.parse::<Uuid>() else { continue };
        let mut out = String::new();
        for line in String::from_utf8_lossy(bytes).lines().filter(|l| !l.trim().is_empty()) {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                out.push_str(&serde_json::to_string(&map(v))?);
                out.push('\n');
            }
        }
        fs::write(dir.join("events").join(format!("{}.jsonl", new_id(old))), out)?;
    }

    let issues: Vec<Issue> = serde_json::from_value(map(issues))?;
    let automations: Vec<Automation> = serde_json::from_value(map(automations))?;
    let artifacts: Vec<Artifact> = serde_json::from_value(map(artifacts))?;
    if o.replace {
        r.issues.remove(|i| i.workspace_id == ws_id)?;
        r.automations.remove(|a| a.workspace_id == ws_id)?;
        r.artifacts.remove(|a| a.workspace_id == ws_id)?;
    }
    for i in &issues {
        r.issues.put(i.clone(), |x| x.id)?;
    }
    for mut a in automations.clone() {
        if beside_original {
            a.enabled = false;
        }
        r.automations.put(a, |x| x.id)?;
    }

    // Artifact files go to the workspace's media folder; metadata follows them.
    let media = r.media_dir(ws_id);
    let mut artifact_count = 0;
    for mut a in artifacts.clone() {
        let old_id = ids.iter().find(|(_, v)| **v == a.id.to_string()).map(|(k, _)| k.clone()).unwrap_or_else(|| a.id.to_string());
        let prefix = format!("artifact-files/{old_id}/");
        if let Some((name, bytes)) = entries.iter().find(|(n, _)| n.starts_with(&prefix)) {
            let file = safe_name(&name[prefix.len()..]);
            fs::create_dir_all(&media)?;
            let mut target = media.join(&file);
            if target.exists() && !o.replace {
                target = media.join(format!("{}-{file}", &a.id.simple().to_string()[..8]));
            }
            fs::write(&target, bytes)?;
            a.path = target.to_string_lossy().into_owned();
            a.size = bytes.len() as u64;
        }
        r.artifacts.put(a, |x| x.id)?;
        artifact_count += 1;
    }

    for (name, bytes) in &entries {
        if let Some(rest) = name.strip_prefix("boards/") {
            let Some(old) = rest.strip_suffix(".json") else { continue };
            let Ok(old) = old.parse::<Uuid>() else { continue };
            let v = map(serde_json::from_slice(bytes)?);
            store::save(&dir.join("boards").join(format!("{}.json", new_id(old))), &v)?;
        } else if let Some(rest) = name.strip_prefix("dirs/") {
            let Some((top, rel)) = rest.split_once('/') else { continue };
            let (Some(top), Some(rel)) = (safe_top(top), safe_rel(rel)) else { continue };
            let target = dir.join(top).join(ws_id.to_string()).join(rel);
            write_data(&target, bytes, &ids)?;
        } else if let Some(rest) = name.strip_prefix("files/") {
            let Some((top, file)) = rest.split_once('/') else { continue };
            let Some(top) = safe_top(top) else { continue };
            if file.contains(['/', '\\']) || !file.starts_with('@') {
                continue;
            }
            let target = dir.join(top).join(file.replacen('@', &ws_id.to_string(), 1));
            write_data(&target, bytes, &ids)?;
        }
    }

    // Tell open windows; threads arrive with the next list.
    for i in &issues {
        r.notice(ws_id, "issue-changed", i);
    }

    Ok(ImportSummary {
        workspace: ws,
        leads: leads.len() as u32,
        threads: threads.len() as u32,
        issues: issues.len() as u32,
        automations: automations.len() as u32,
        artifacts: artifact_count,
    })
}

/// JSON and JSON-lines files get their ids remapped; anything else is copied.
fn write_data(target: &Path, bytes: &[u8], ids: &HashMap<String, String>) -> Result<()> {
    if let Some(d) = target.parent() {
        fs::create_dir_all(d)?;
    }
    let ext = target.extension().and_then(|e| e.to_str()).unwrap_or("");
    let out = if ids.is_empty() {
        bytes.to_vec()
    } else if ext == "json" {
        match serde_json::from_slice::<Value>(bytes) {
            Ok(v) => serde_json::to_vec_pretty(&remap(v, ids))?,
            Err(_) => bytes.to_vec(),
        }
    } else if ext == "jsonl" {
        let text = String::from_utf8_lossy(bytes);
        let mut s = String::new();
        for line in text.lines() {
            match serde_json::from_str::<Value>(line) {
                Ok(v) => s.push_str(&serde_json::to_string(&remap(v, ids))?),
                Err(_) => s.push_str(line),
            }
            s.push('\n');
        }
        s.into_bytes()
    } else {
        bytes.to_vec()
    };
    fs::write(target, out)?;
    Ok(())
}

/// A top-level data folder name from a zip: one plain component, not a reserved one.
fn safe_top(top: &str) -> Option<&str> {
    let ok = !top.is_empty() && !top.starts_with('.') && !top.contains(['/', '\\', ':']) && !SKIP_DIRS.contains(&top);
    ok.then_some(top)
}

/// A relative path from a zip that cannot climb out of where it is written.
fn safe_rel(rel: &str) -> Option<PathBuf> {
    let p = Path::new(rel);
    let ok = !rel.is_empty() && p.components().all(|c| matches!(c, Component::Normal(_)));
    ok.then(|| p.to_path_buf())
}

fn safe_name(name: &str) -> String {
    let n: String = name.chars().filter(|c| !matches!(c, '/' | '\\' | ':' | '\0')).collect();
    if n.is_empty() || n.starts_with('.') {
        format!("file{n}")
    } else {
        n
    }
}

/// Replace every old id with its new one, in strings and object keys alike.
/// Ids are UUIDs, so a substring match never hits anything else.
pub fn remap(v: Value, ids: &HashMap<String, String>) -> Value {
    if ids.is_empty() {
        return v;
    }
    match v {
        Value::String(s) => Value::String(remap_str(&s, ids)),
        Value::Array(a) => Value::Array(a.into_iter().map(|x| remap(x, ids)).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, x)| (remap_str(&k, ids), remap(x, ids))).collect()),
        other => other,
    }
}

fn remap_str(s: &str, ids: &HashMap<String, String>) -> String {
    const LEN: usize = 36;
    if s.len() < LEN {
        return s.to_string();
    }
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let mut last = 0;
    while i + LEN <= b.len() {
        let shaped = b[i + 8] == b'-' && b[i + 13] == b'-' && b[i + 18] == b'-' && b[i + 23] == b'-';
        if shaped && s.is_char_boundary(i) && s.is_char_boundary(i + LEN) {
            if let Some(new) = ids.get(&s[i..i + LEN]) {
                out.push_str(&s[last..i]);
                out.push_str(new);
                i += LEN;
                last = i;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&s[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_thread(ws: Uuid, lead: Option<Uuid>, title: &str) -> NewThread {
        NewThread {
            workspace_id: ws,
            lead_id: lead,
            title: Some(title.into()),
            harness: HarnessKind::ClaudeCode,
            model: None,
            effort: Effort::Medium,
            approval: ApprovalLevel::AskRisky,
            isolate: false,
        }
    }

    #[test]
    fn every_template_parses() {
        let all = templates();
        assert_eq!(all.len(), TEMPLATES.len());
        for t in &all {
            for i in &t.issues {
                if let Some(c) = &i.lead {
                    assert!(t.leads.iter().any(|x| &x.name == c), "{}: issue names unknown lead {c}", t.id);
                }
            }
            for a in &t.automations {
                croner::Cron::new(&a.schedule).parse().unwrap();
            }
        }
    }

    #[tokio::test]
    async fn apply_template_creates_leads_issues_settings_automations() {
        let dir = tempfile::tempdir().unwrap();
        let r = Runner::open(dir.path()).unwrap();
        let ws = r.create_workspace("Site".into(), None).unwrap();

        let out = apply_template(&r, ws.id, "web-app", None).unwrap();
        assert_eq!(out.leads, 3);
        let caps = r.leads(ws.id);
        let names: Vec<_> = caps.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"Frontend") && names.contains(&"Backend") && names.contains(&"Tests"));
        let issues = r.list_issues(ws.id);
        assert_eq!(issues.len() as u32, out.issues);
        assert!(issues.iter().all(|i| i.lead_id.is_some_and(|c| caps.iter().any(|x| x.id == c))));
        let s = r.settings(ws.id);
        assert!(s.dev_command.as_deref().unwrap().contains("{port}"));
        assert!(!s.instructions.is_empty());

        // Applying again reuses leads and does not repeat the instructions.
        apply_template(&r, ws.id, "web-app", None).unwrap();
        assert_eq!(r.leads(ws.id).len(), 3);
        assert_eq!(r.settings(ws.id).instructions, s.instructions);

        let v = call(&r, "create_workspace_from_template", &json!({ "name": "Launch", "template_id": "marketing-campaign" }), "t").await.unwrap().unwrap();
        let m: Workspace = serde_json::from_value(v).unwrap();
        assert_eq!(m.name, "Launch");
        let autos = r.list_automations(m.id);
        assert_eq!(autos.len(), 1);
        let research = r.leads(m.id).into_iter().find(|c| c.name == "Research").unwrap();
        assert_eq!(autos[0].lead_id, Some(research.id));
        assert!(apply_template(&r, ws.id, "nope", None).is_err());
    }

    #[tokio::test]
    async fn export_import_round_trip_remaps_ids() {
        let dir = tempfile::tempdir().unwrap();
        let r = Runner::open(dir.path().join("data")).unwrap();
        let ws = r.create_workspace("Bouvio".into(), None).unwrap();
        let cap = r
            .create_lead(NewLead {
                workspace_id: ws.id,
                name: "Desktop".into(),
                instructions: "UI".into(),
                harness: HarnessKind::ClaudeCode,
                model: None,
                effort: Effort::Medium,
                approval: ApprovalLevel::AskRisky,
            })
            .unwrap();
        let a = r.create_thread(new_thread(ws.id, Some(cap.id), "Parent")).await.unwrap();
        let b = r.create_thread(new_thread(ws.id, Some(cap.id), "Child")).await.unwrap();
        r.emit(a.id, ThreadEvent::UserMessage { text: "hi".into(), author: "Maya".into() }).unwrap();
        r.emit(a.id, ThreadEvent::ThreadSpawned { thread_id: b.id, title: "Child".into() }).unwrap();

        let mut issue = r.create_issue(ws.id, "Fix it".into(), String::new(), None, Some(cap.id)).unwrap();
        issue.thread_ids = vec![a.id, b.id];
        r.update_issue(issue.clone()).unwrap();
        r.save_automation(Automation {
            id: Uuid::nil(),
            workspace_id: ws.id,
            name: "Daily".into(),
            schedule: "0 9 * * *".into(),
            prompt: "go".into(),
            lead_id: Some(cap.id),
            enabled: true,
            last_run: None,
            last_thread: Some(a.id),
        })
        .unwrap();
        let board = r.create_board(ws.id, "Ideas".into()).unwrap();
        r.update_board(board.id, json!({ "items": [{ "thread": a.id }] }), "t").unwrap();
        let mut s = r.settings(ws.id);
        s.instructions = "Be kind".into();
        r.set_settings(ws.id, &s).unwrap();
        let office = r.store().dir().join("office").join(ws.id.to_string());
        fs::create_dir_all(&office).unwrap();
        fs::write(office.join("notes.ydoc"), [1u8, 2, 3]).unwrap();
        let media = r.media_dir(ws.id);
        fs::create_dir_all(&media).unwrap();
        fs::write(media.join("logo.svg"), "<svg/>").unwrap();
        let art = r.add_artifact(ws.id, Some(a.id), &media.join("logo.svg"), Some("a logo".into()), None).unwrap();

        let zip = dir.path().join("backup.zip");
        let sum = export_workspace(&r, ws.id, &zip).unwrap();
        assert_eq!(sum.threads, 2);
        assert_eq!(sum.artifacts, 1);
        assert!(sum.bytes > 0);

        let out = import_workspace(&r, &zip, ImportOptions { name: Some("Copy".into()), ..Default::default() }).unwrap();
        let nw = out.workspace.id;
        assert_ne!(nw, ws.id);
        assert_eq!(out.workspace.name, "Copy");
        assert_eq!(out.threads, 2);

        let ncap = r.leads(nw);
        assert_eq!(ncap.len(), 1);
        assert_ne!(ncap[0].id, cap.id);
        let nthreads = r.threads(nw);
        assert_eq!(nthreads.len(), 2);
        assert!(nthreads.iter().all(|t| t.lead_id == Some(ncap[0].id) && t.id != a.id && t.id != b.id));
        let na = nthreads.iter().find(|t| t.title == "Parent").unwrap();
        let nb = nthreads.iter().find(|t| t.title == "Child").unwrap();

        let events = r.thread_events(na.id).unwrap();
        assert!(events.iter().all(|e| e.thread_id == na.id));
        assert!(events.iter().any(|e| matches!(&e.event, ThreadEvent::ThreadSpawned { thread_id, .. } if *thread_id == nb.id)));
        assert!(events.iter().any(|e| matches!(&e.event, ThreadEvent::ArtifactCreated { artifact } if artifact.workspace_id == nw)));

        let ni = r.list_issues(nw);
        assert_eq!(ni.len(), 1);
        assert_ne!(ni[0].id, issue.id);
        assert_eq!(ni[0].thread_ids, vec![na.id, nb.id]);
        assert_eq!(ni[0].lead_id, Some(ncap[0].id));

        let nauto = r.list_automations(nw);
        assert_eq!(nauto[0].lead_id, Some(ncap[0].id));
        assert_eq!(nauto[0].last_thread, Some(na.id));
        // A copy beside the original stays paused.
        assert!(!nauto[0].enabled);

        let nboards = r.list_boards(nw);
        assert_eq!(nboards.len(), 1);
        let nboard = r.get_board(nboards[0].id).unwrap();
        assert_ne!(nboard.id, board.id);
        assert_eq!(nboard.doc["items"][0]["thread"], json!(na.id));

        assert_eq!(r.settings(nw).instructions, "Be kind");
        assert_eq!(fs::read(r.store().dir().join("office").join(nw.to_string()).join("notes.ydoc")).unwrap(), vec![1, 2, 3]);

        let narts = r.list_artifacts(nw);
        assert_eq!(narts.len(), 1);
        assert_ne!(narts[0].id, art.id);
        assert_eq!(narts[0].thread_id, Some(na.id));
        assert!(narts[0].path.contains(&nw.to_string()));
        assert_eq!(fs::read_to_string(&narts[0].path).unwrap(), "<svg/>");

        // The original is untouched.
        assert_eq!(r.threads(ws.id).len(), 2);
        assert_eq!(r.list_issues(ws.id)[0].thread_ids, vec![a.id, b.id]);

        // Restoring keeps the original ids.
        let back = import_workspace(&r, &zip, ImportOptions { replace: true, ..Default::default() }).unwrap();
        assert_eq!(back.workspace.id, ws.id);
        assert_eq!(r.list_issues(ws.id).len(), 1);
        assert!(r.list_automations(ws.id)[0].enabled);
    }

    #[test]
    fn remap_replaces_ids_inside_strings_and_keys() {
        let old = Uuid::new_v4().to_string();
        let new = Uuid::new_v4().to_string();
        let ids = HashMap::from([(old.clone(), new.clone())]);
        let v = remap(json!({ old.clone(): [format!("/x/{old}/y"), "keep", 3] }), &ids);
        assert_eq!(v, json!({ new.clone(): [format!("/x/{new}/y"), "keep", 3] }));
        assert!(safe_rel("../x").is_none() && safe_rel("/etc/x").is_none() && safe_rel("a/b.ydoc").is_some());
        assert!(safe_top("worktrees").is_none() && safe_top("office").is_some());
    }
}
