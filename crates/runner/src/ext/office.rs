//! Office: docs, sheets, slides, databases, calendar and forms, with live collaboration.
//!
//! Every document's content is a Yjs document. The runner keeps one `yrs::Doc`
//! per open document in memory and stores it under
//! `<data>/office/<ws>/<id>.ydoc` as a v1 state update. Incoming updates are
//! appended to `<id>.ylog` right away (cheap and durable), and a debounced
//! snapshot folds the log back into the `.ydoc` file atomically, or at once
//! when the log grows past [`COMPACT_AT`].
//!
//! Shapes inside a Yjs doc, shared with the UI (`components/office/model.ts`):
//! - doc:      XmlFragment `content` (ProseMirror via y-prosemirror)
//! - sheet:    Map `cells` ("A1" → {v, f?, fmt?}), Map `cols` ("A" → width)
//! - slides:   Array `slides` of Map {id, layout, blocks: Array of Map}
//! - database: Map `schema` (field id → {id, name, type, options?, order}),
//!   Array `rows` of Map {id, created, <field id>: value}, Array `views` of Map
//! - form:     Map `form` {description}, Array `questions` of Map {field, label, required, help}

use crate::store::Collection;
use crate::Runner;
use anyhow::{bail, Context, Result};
use base64::Engine;
use cuna_protocol::office::{Doc, DocAwareness, DocKind, DocUpdate, PublicForm, PublicQuestion};
use chrono::Utc;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use uuid::Uuid;
use yrs::types::ToJson;
use yrs::updates::decoder::Decode;
use yrs::{Any, Array, WriteTxn, ArrayRef, GetString, In, Map, MapPrelim, ReadTxn, StateVector, Transact, Update, Xml, XmlElementPrelim, XmlFragment, XmlOut, XmlTextPrelim};

/// Fold the update log into the snapshot once it is this big.
const COMPACT_AT: u64 = 256 * 1024;
/// Quiet time after the last update before a snapshot is written.
const SNAPSHOT_AFTER: Duration = Duration::from_millis(1500);

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

// ---- persistence ---------------------------------------------------------------------------

/// One document's Yjs state on disk: a snapshot plus an append-only update log.
pub struct DocFile {
    snapshot: PathBuf,
    log: PathBuf,
}

impl DocFile {
    pub fn new(dir: &Path, id: Uuid) -> Self {
        Self { snapshot: dir.join(format!("{id}.ydoc")), log: dir.join(format!("{id}.ylog")) }
    }

    /// Load the snapshot and replay the log. A torn last log entry is skipped.
    pub fn load(&self) -> Result<yrs::Doc> {
        let doc = yrs::Doc::new();
        {
            let mut txn = doc.transact_mut();
            if let Ok(bytes) = fs::read(&self.snapshot) {
                if !bytes.is_empty() {
                    txn.apply_update(Update::decode_v1(&bytes).context("decode snapshot")?)?;
                }
            }
            if let Ok(bytes) = fs::read(&self.log) {
                let mut at = 0;
                while at + 4 <= bytes.len() {
                    let len = u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
                    at += 4;
                    if at + len > bytes.len() {
                        break;
                    }
                    if let Ok(u) = Update::decode_v1(&bytes[at..at + len]) {
                        let _ = txn.apply_update(u);
                    }
                    at += len;
                }
            }
        }
        Ok(doc)
    }

    /// Append one update to the log; returns the log's new size.
    pub fn append(&self, update: &[u8]) -> Result<u64> {
        if let Some(dir) = self.log.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut f = fs::OpenOptions::new().create(true).append(true).open(&self.log)?;
        let mut buf = Vec::with_capacity(update.len() + 4);
        buf.extend_from_slice(&(update.len() as u32).to_le_bytes());
        buf.extend_from_slice(update);
        f.write_all(&buf)?;
        Ok(f.metadata()?.len())
    }

    /// Write the full state atomically and drop the log it now contains.
    pub fn snapshot(&self, doc: &yrs::Doc) -> Result<()> {
        let bytes = doc.transact().encode_state_as_update_v1(&StateVector::default());
        if let Some(dir) = self.snapshot.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = self.snapshot.with_extension("ydoc.tmp");
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, &self.snapshot)?;
        let _ = fs::remove_file(&self.log);
        Ok(())
    }

    fn remove(&self) {
        let _ = fs::remove_file(&self.snapshot);
        let _ = fs::remove_file(&self.log);
    }
}

/// An open document: the live Yjs doc and its file. The mutex also orders
/// log appends against snapshots, so a snapshot never loses a logged update.
struct Live {
    ws: Uuid,
    doc: Mutex<yrs::Doc>,
    file: DocFile,
    pending: AtomicBool,
}

impl Live {
    /// Apply an update and log it. Returns true when the log should be compacted now.
    fn apply(&self, update: &[u8]) -> Result<bool> {
        let doc = self.doc.lock().unwrap();
        doc.transact_mut().apply_update(Update::decode_v1(update).context("not a Yjs update")?)?;
        Ok(self.file.append(update)? > COMPACT_AT)
    }

    fn state(&self) -> Vec<u8> {
        self.doc.lock().unwrap().transact().encode_state_as_update_v1(&StateVector::default())
    }

    fn snapshot(&self) -> Result<()> {
        let doc = self.doc.lock().unwrap();
        self.file.snapshot(&doc)
    }

    /// Change the doc on the runner's side (seeding, form rows); returns the update.
    fn edit(&self, f: impl FnOnce(&mut yrs::TransactionMut)) -> Result<Vec<u8>> {
        let doc = self.doc.lock().unwrap();
        let before = doc.transact().state_vector();
        {
            let mut txn = doc.transact_mut();
            f(&mut txn);
        }
        let update = doc.transact().encode_diff_v1(&before);
        self.file.append(&update)?;
        Ok(update)
    }
}

struct Office {
    dir: PathBuf,
    meta: Collection<Doc>,
    live: Mutex<HashMap<Uuid, Arc<Live>>>,
}

impl Office {
    fn ws_dir(&self, ws: Uuid) -> PathBuf {
        self.dir.join(ws.to_string())
    }

    fn open(&self, id: Uuid) -> Result<(Doc, Arc<Live>)> {
        let meta = self.meta.find(|d| d.id == id).context("unknown document")?;
        let mut live = self.live.lock().unwrap();
        if let Some(l) = live.get(&id) {
            return Ok((meta, l.clone()));
        }
        let file = DocFile::new(&self.ws_dir(meta.workspace_id), id);
        let doc = file.load()?;
        let l = Arc::new(Live { ws: meta.workspace_id, doc: Mutex::new(doc), file, pending: AtomicBool::new(false) });
        live.insert(id, l.clone());
        Ok((meta, l))
    }
}

/// One office per data dir (tests open several runners in one process).
fn office(r: &Runner) -> Result<Arc<Office>> {
    static ALL: OnceLock<Mutex<HashMap<PathBuf, Arc<Office>>>> = OnceLock::new();
    let dir = r.store().dir().join("office");
    let mut all = ALL.get_or_init(Default::default).lock().unwrap();
    if let Some(o) = all.get(&dir) {
        return Ok(o.clone());
    }
    fs::create_dir_all(&dir)?;
    let o = Arc::new(Office { meta: Collection::open(dir.join("docs.json"))?, dir: dir.clone(), live: Mutex::new(HashMap::new()) });
    all.insert(dir, o.clone());
    Ok(o)
}

// ---- runner plumbing ------------------------------------------------------------------------

fn p<T: DeserializeOwned>(params: &Value, key: &str) -> Result<T> {
    serde_json::from_value(params.get(key).cloned().unwrap_or(Value::Null)).with_context(|| format!("param `{key}`"))
}

fn opt<T: DeserializeOwned>(params: &Value, key: &str) -> Option<T> {
    params.get(key).cloned().and_then(|v| serde_json::from_value(v).ok())
}

const METHODS: &[&str] = &["list_docs", "create_doc", "rename_doc", "delete_doc", "get_doc_state", "doc_update", "doc_awareness", "get_form_public", "form_submit"];

pub async fn call(r: &Arc<Runner>, method: &str, params: &Value, actor: &str) -> Option<Result<Value>> {
    if !METHODS.contains(&method) {
        return None;
    }
    Some(handle(r, method, params, actor))
}

fn handle(r: &Arc<Runner>, method: &str, params: &Value, actor: &str) -> Result<Value> {
    let o = office(r)?;
    match method {
        "list_docs" => {
            let ws: Uuid = p(params, "workspace_id")?;
            let mut v = o.meta.filter(|d| d.workspace_id == ws);
            v.sort_by_key(|d| std::cmp::Reverse(d.updated_at));
            Ok(serde_json::to_value(v)?)
        }
        "create_doc" => {
            let doc = create_doc(r, &o, p(params, "workspace_id")?, p(params, "kind")?, p(params, "title")?, opt(params, "template"), opt(params, "parent_id"), actor)?;
            Ok(serde_json::to_value(doc)?)
        }
        "rename_doc" => {
            let id: Uuid = p(params, "id")?;
            let title: String = p(params, "title")?;
            let icon: Option<String> = opt(params, "icon");
            let d = o
                .meta
                .update(
                    |d| d.id == id,
                    |d| {
                        d.title = title.trim().to_string();
                        if icon.is_some() {
                            d.icon = icon.clone().filter(|i| !i.is_empty());
                        }
                        d.updated_at = Utc::now();
                    },
                )?
                .context("unknown document")?;
            r.notice(d.workspace_id, "office-doc", &d);
            Ok(serde_json::to_value(d)?)
        }
        "delete_doc" => {
            let id: Uuid = p(params, "id")?;
            let d = o.meta.find(|d| d.id == id).context("unknown document")?;
            o.live.lock().unwrap().remove(&id);
            DocFile::new(&o.ws_dir(d.workspace_id), id).remove();
            o.meta.remove(|x| x.id == id)?;
            crate::ext::knowledge::unindex(r, d.workspace_id, d.kind.as_str(), &id.to_string());
            r.notice(d.workspace_id, "office-doc-deleted", json!({ "id": id }));
            Ok(Value::Null)
        }
        "get_doc_state" => {
            let (_, live) = o.open(p(params, "id")?)?;
            Ok(Value::String(B64.encode(live.state())))
        }
        "doc_update" => {
            let id: Uuid = p(params, "id")?;
            let raw: String = p(params, "update")?;
            let bytes = B64.decode(raw.as_bytes()).context("update is not base64")?;
            let (meta, live) = o.open(id)?;
            let compact = live.apply(&bytes)?;
            r.notice(live.ws, "office-update", DocUpdate { id, update: raw, by: actor.to_string(), client: opt(params, "client") });
            touch(r, &o, &meta);
            persist_later(r, &o, id, live, compact);
            Ok(Value::Null)
        }
        "doc_awareness" => {
            let id: Uuid = p(params, "id")?;
            let meta = o.meta.find(|d| d.id == id).context("unknown document")?;
            r.notice(meta.workspace_id, "office-awareness", DocAwareness { id, state: params.get("state").cloned().unwrap_or(Value::Null), by: actor.to_string() });
            Ok(Value::Null)
        }
        "get_form_public" => {
            let (form, _) = form_of(&o, params)?;
            Ok(serde_json::to_value(public_form(&o, &form)?)?)
        }
        "form_submit" => {
            let (form, db) = form_of(&o, params)?;
            let db = db.context("this form is not linked to a database")?;
            let answers: serde_json::Map<String, Value> = p(params, "answers")?;
            let public = public_form(&o, &form)?;
            let values = validate_answers(&public, &o.open(db.id)?.1, &answers)?;
            let row_id = Uuid::new_v4().to_string();
            let (_, live) = o.open(db.id)?;
            let rid = row_id.clone();
            let update = live.edit(move |txn| {
                let rows = txn.get_or_insert_array("rows");
                let mut row: Vec<(String, In)> = vec![("id".into(), In::Any(Any::from(rid))), ("created".into(), In::Any(Any::from(Utc::now().to_rfc3339())))];
                row.extend(values.into_iter().map(|(k, v)| (k, In::Any(v))));
                rows.push_back(txn, row.into_iter().collect::<MapPrelim>());
            })?;
            r.notice(db.workspace_id, "office-update", DocUpdate { id: db.id, update: B64.encode(update), by: form.title.clone(), client: None });
            touch(r, &o, &db);
            persist_later(r, &o, db.id, live, false);
            Ok(json!({ "row_id": row_id }))
        }
        _ => unreachable!(),
    }
}

pub fn workspace_of(r: &Runner, method: &str, params: &Value) -> Option<Result<Uuid>> {
    if !METHODS.contains(&method) {
        return None;
    }
    if let Some(w) = opt::<Uuid>(params, "workspace_id") {
        return Some(Ok(w));
    }
    let id = opt::<Uuid>(params, "id")?;
    Some(office(r).and_then(|o| o.meta.find(|d| d.id == id).map(|d| d.workspace_id).context("unknown document")))
}

pub fn start(_r: &Arc<Runner>) {}

/// Bump `updated_at` at most every 20 seconds while people type.
fn touch(r: &Runner, o: &Office, meta: &Doc) {
    if Utc::now() - meta.updated_at < chrono::Duration::seconds(20) {
        return;
    }
    if let Ok(Some(d)) = o.meta.update(|d| d.id == meta.id, |d| d.updated_at = Utc::now()) {
        r.notice(d.workspace_id, "office-doc", &d);
    }
}

/// Snapshot after a quiet moment (or now, when the log is big), then reindex.
fn persist_later(r: &Arc<Runner>, o: &Arc<Office>, id: Uuid, live: Arc<Live>, now: bool) {
    let run = {
        let r = r.clone();
        let o = o.clone();
        let live = live.clone();
        move || {
            live.pending.store(false, Ordering::SeqCst);
            if let Err(e) = live.snapshot() {
                tracing::warn!("office: snapshot {id}: {e:#}");
            }
            if let Some(meta) = o.meta.find(|d| d.id == id) {
                let text = { plain_text(&live.doc.lock().unwrap(), meta.kind) };
                crate::ext::knowledge::index(&r, meta.workspace_id, meta.kind.as_str(), &id.to_string(), &meta.title, &text);
            }
        }
    };
    if now {
        run();
        return;
    }
    if live.pending.swap(true, Ordering::SeqCst) {
        return;
    }
    match tokio::runtime::Handle::try_current() {
        Ok(h) => {
            h.spawn(async move {
                tokio::time::sleep(SNAPSHOT_AFTER).await;
                run();
            });
        }
        Err(_) => run(),
    }
}

// ---- creating and seeding ---------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn create_doc(r: &Runner, o: &Office, ws: Uuid, kind: DocKind, title: String, template: Option<String>, parent_id: Option<Uuid>, actor: &str) -> Result<Doc> {
    let now = Utc::now();
    let title = if title.trim().is_empty() { "Untitled".to_string() } else { title.trim().to_string() };
    // A form needs a database to write to: make one when none is given.
    let parent_id = match (kind, parent_id) {
        (DocKind::Form, Some(db)) => {
            let d = o.meta.find(|d| d.id == db && d.workspace_id == ws).context("unknown database")?;
            if d.kind != DocKind::Database {
                bail!("a form writes to a database");
            }
            Some(db)
        }
        (DocKind::Form, None) => Some(create_doc(r, o, ws, DocKind::Database, format!("{title} responses"), Some("responses".into()), None, actor)?.id),
        _ => None,
    };
    let doc = Doc { id: Uuid::new_v4(), workspace_id: ws, kind, title, icon: None, created_at: now, updated_at: now, created_by: actor.to_string(), parent_id };
    o.meta.put(doc.clone(), |d| d.id)?;
    let (_, live) = o.open(doc.id)?;
    let fields = parent_id.map(|db| database_fields(o, db)).unwrap_or_default();
    live.edit(|txn| seed(txn, kind, template.as_deref(), &fields))?;
    live.snapshot()?;
    r.notice(ws, "office-doc", &doc);
    Ok(doc)
}

fn any(v: Value) -> Any {
    serde_json::from_value(v).unwrap_or(Any::Null)
}

fn map_of(pairs: Value) -> MapPrelim {
    pairs.as_object().into_iter().flatten().map(|(k, v)| (k.clone(), In::Any(any(v.clone())))).collect()
}

/// A field of a database schema, as the UI stores it.
fn field(id: &str, name: &str, kind: &str, order: i64, options: &[(&str, &str)]) -> (String, Any) {
    let opts: Vec<Value> = options.iter().enumerate().map(|(i, (n, c))| json!({ "id": format!("{id}-{i}"), "name": n, "color": c })).collect();
    let mut f = json!({ "id": id, "name": name, "type": kind, "order": order });
    if !opts.is_empty() {
        f["options"] = Value::Array(opts);
    }
    (id.to_string(), any(f))
}

fn seed(txn: &mut yrs::TransactionMut, kind: DocKind, template: Option<&str>, form_fields: &[(String, Value)]) {
    match kind {
        DocKind::Doc => {
            let content = txn.get_or_insert_xml_fragment("content");
            let blocks: &[(&str, &str)] = match template {
                Some("meeting-notes") => &[
                    ("p", "Date · Attendees"),
                    ("h2", "Agenda"),
                    ("li", ""),
                    ("h2", "Notes"),
                    ("p", ""),
                    ("h2", "Decisions"),
                    ("li", ""),
                    ("h2", "Action items"),
                    ("todo", ""),
                ],
                Some("project-brief") => &[
                    ("h2", "Goal"),
                    ("p", "What changes for whom, and how we will know."),
                    ("h2", "Context"),
                    ("p", ""),
                    ("h2", "Scope"),
                    ("li", "In:"),
                    ("li", "Out:"),
                    ("h2", "Milestones"),
                    ("todo", ""),
                    ("h2", "Risks and open questions"),
                    ("li", ""),
                ],
                _ => &[],
            };
            for (k, text) in blocks {
                push_block(txn, &content, k, text);
            }
        }
        DocKind::Sheet => {
            let cells = txn.get_or_insert_map("cells");
            if template == Some("budget") {
                let rows: &[(&str, &str, &str)] = &[("Category", "Planned", "Actual"), ("Hosting", "40", "36"), ("Domains", "15", "15"), ("Design", "600", "720"), ("Ads", "300", "180"), ("Tools", "120", "95")];
                for (i, (a, b, c)) in rows.iter().enumerate() {
                    let n = i + 1;
                    let head = i == 0;
                    let fmt = |align: &str| if head { json!({ "b": true, "a": align }) } else { json!({ "n": "eur" }) };
                    cells.insert(txn, format!("A{n}"), any(if head { json!({ "v": a, "fmt": { "b": true } }) } else { json!({ "v": a }) }));
                    cells.insert(txn, format!("B{n}"), any(json!({ "v": if head { json!(b) } else { json!(b.parse::<f64>().unwrap_or(0.0)) }, "fmt": fmt("right") })));
                    cells.insert(txn, format!("C{n}"), any(json!({ "v": if head { json!(c) } else { json!(c.parse::<f64>().unwrap_or(0.0)) }, "fmt": fmt("right") })));
                    if head {
                        cells.insert(txn, "D1", any(json!({ "v": "Difference", "fmt": { "b": true, "a": "right" } })));
                        cells.insert(txn, "E1", any(json!({ "v": "Used", "fmt": { "b": true, "a": "right" } })));
                    } else {
                        cells.insert(txn, format!("D{n}"), any(json!({ "v": "", "f": format!("=B{n}-C{n}"), "fmt": { "n": "eur" } })));
                        cells.insert(txn, format!("E{n}"), any(json!({ "v": "", "f": format!("=IF(B{n}=0,0,C{n}/B{n})"), "fmt": { "n": "percent" } })));
                    }
                }
                let t = rows.len() + 1;
                let last = rows.len();
                cells.insert(txn, format!("A{t}"), any(json!({ "v": "Total", "fmt": { "b": true } })));
                for c in ["B", "C", "D"] {
                    cells.insert(txn, format!("{c}{t}"), any(json!({ "v": "", "f": format!("=SUM({c}2:{c}{last})"), "fmt": { "n": "eur", "b": true } })));
                }
                cells.insert(txn, format!("E{t}"), any(json!({ "v": "", "f": format!("=ROUND(C{t}/B{t},4)"), "fmt": { "n": "percent", "b": true } })));
                let cols = txn.get_or_insert_map("cols");
                cols.insert(txn, "A", any(json!(160)));
            }
        }
        DocKind::Slides => {
            let slides = txn.get_or_insert_array("slides");
            let slide = slides.push_back(txn, map_of(json!({ "id": short_id(), "layout": "title" })));
            let blocks = slide.insert(txn, "blocks", yrs::ArrayPrelim::default());
            blocks.push_back(txn, map_of(json!({ "id": short_id(), "type": "title", "x": 8, "y": 34, "w": 84, "h": 18, "text": "", "size": 6 })));
            blocks.push_back(txn, map_of(json!({ "id": short_id(), "type": "text", "x": 8, "y": 54, "w": 84, "h": 12, "text": "", "size": 3 })));
        }
        DocKind::Database => {
            let schema = txn.get_or_insert_map("schema");
            let rows = txn.get_or_insert_array("rows");
            let views = txn.get_or_insert_array("views");
            let mut table = json!({ "id": short_id(), "name": "Table", "type": "table", "filters": [], "sorts": [] });
            let mut extra: Vec<Value> = Vec::new();
            match template {
                Some("content-calendar") => {
                    for (k, v) in [
                        field("title", "Title", "text", 0, &[]),
                        field("status", "Status", "select", 1, &[("Idea", "gray"), ("Drafting", "yellow"), ("Review", "blue"), ("Published", "green")]),
                        field("channel", "Channel", "select", 2, &[("Blog", "purple"), ("Newsletter", "orange"), ("Social", "pink")]),
                        field("date", "Publish date", "date", 3, &[]),
                        field("owner", "Owner", "person", 4, &[]),
                    ] {
                        schema.insert(txn, k, v);
                    }
                    let today = Utc::now().date_naive();
                    let day = |n: i64| (today + chrono::Duration::days(n)).to_string();
                    for (title, status, channel, d) in [
                        ("Launch announcement", "status-2", "channel-0", day(2)),
                        ("Monthly update", "status-1", "channel-1", day(6)),
                        ("Behind the scenes", "status-0", "channel-2", day(9)),
                        ("Customer story", "status-0", "channel-0", day(14)),
                    ] {
                        rows.push_back(txn, map_of(json!({ "id": short_id(), "created": Utc::now().to_rfc3339(), "title": title, "status": status, "channel": channel, "date": d })));
                    }
                    extra.push(json!({ "id": short_id(), "name": "Board", "type": "kanban", "group_by": "status", "filters": [], "sorts": [] }));
                    extra.push(json!({ "id": short_id(), "name": "Calendar", "type": "calendar", "date_field": "date", "filters": [], "sorts": [] }));
                }
                Some("calendar") => {
                    for (k, v) in [field("title", "Title", "text", 0, &[]), field("date", "Date", "date", 1, &[]), field("notes", "Notes", "text", 2, &[])] {
                        schema.insert(txn, k, v);
                    }
                    extra.push(json!({ "id": short_id(), "name": "Calendar", "type": "calendar", "date_field": "date", "filters": [], "sorts": [] }));
                }
                Some("responses") => {
                    for (k, v) in [field("name", "Name", "text", 0, &[]), field("email", "Email", "text", 1, &[]), field("message", "Message", "text", 2, &[])] {
                        schema.insert(txn, k, v);
                    }
                }
                _ => {
                    for (k, v) in [
                        field("name", "Name", "text", 0, &[]),
                        field("status", "Status", "select", 1, &[("To do", "gray"), ("Doing", "blue"), ("Done", "green")]),
                        field("date", "Date", "date", 2, &[]),
                    ] {
                        schema.insert(txn, k, v);
                    }
                    for _ in 0..3 {
                        rows.push_back(txn, map_of(json!({ "id": short_id(), "created": Utc::now().to_rfc3339() })));
                    }
                    extra.push(json!({ "id": short_id(), "name": "Board", "type": "kanban", "group_by": "status", "filters": [], "sorts": [] }));
                }
            }
            if template == Some("content-calendar") {
                table["name"] = json!("All posts");
            }
            views.push_back(txn, map_of(table));
            for v in extra {
                views.push_back(txn, map_of(v));
            }
        }
        DocKind::Form => {
            let form = txn.get_or_insert_map("form");
            form.insert(txn, "description", "");
            let questions = txn.get_or_insert_array("questions");
            for (id, f) in form_fields {
                if matches!(f["type"].as_str(), Some("person")) {
                    continue;
                }
                questions.push_back(txn, map_of(json!({ "field": id, "label": f["name"].as_str().unwrap_or(id), "required": false, "help": "" })));
            }
        }
    }
}

fn push_block(txn: &mut yrs::TransactionMut, content: &yrs::XmlFragmentRef, kind: &str, text: &str) {
    let fill = |txn: &mut yrs::TransactionMut, el: &yrs::XmlElementRef| {
        if !text.is_empty() {
            el.push_back(txn, XmlTextPrelim::new(text));
        }
    };
    match kind {
        "h2" => {
            let el = content.push_back(txn, XmlElementPrelim::empty("heading"));
            el.insert_attribute(txn, "level", Any::from(2.0));
            fill(txn, &el);
        }
        "li" => {
            let list = content.push_back(txn, XmlElementPrelim::empty("bulletList"));
            let item = list.push_back(txn, XmlElementPrelim::empty("listItem"));
            let p = item.push_back(txn, XmlElementPrelim::empty("paragraph"));
            fill(txn, &p);
        }
        "todo" => {
            let list = content.push_back(txn, XmlElementPrelim::empty("taskList"));
            let item = list.push_back(txn, XmlElementPrelim::empty("taskItem"));
            item.insert_attribute(txn, "checked", Any::from(false));
            let p = item.push_back(txn, XmlElementPrelim::empty("paragraph"));
            fill(txn, &p);
        }
        _ => {
            let p = content.push_back(txn, XmlElementPrelim::empty("paragraph"));
            fill(txn, &p);
        }
    }
}

fn short_id() -> String {
    Uuid::new_v4().simple().to_string()[..10].to_string()
}

// ---- forms --------------------------------------------------------------------------------------

/// The form doc a public call names, checked against its workspace, and its database.
fn form_of(o: &Office, params: &Value) -> Result<(Doc, Option<Doc>)> {
    let ws: Uuid = p(params, "workspace_id")?;
    let id: Uuid = p(params, "form_id")?;
    let form = o.meta.find(|d| d.id == id && d.workspace_id == ws && d.kind == DocKind::Form).context("no such form")?;
    let db = form.parent_id.and_then(|db| o.meta.find(|d| d.id == db && d.workspace_id == ws));
    Ok((form, db))
}

/// Field id → field JSON of a database's schema.
fn database_fields(o: &Office, db: Uuid) -> Vec<(String, Value)> {
    let Ok((_, live)) = o.open(db) else { return Vec::new() };
    let doc = live.doc.lock().unwrap();
    let txn = doc.transact();
    let mut v: Vec<(String, Value)> = match txn.get_map("schema") {
        Some(m) => m.iter(&txn).map(|(k, v)| (k.to_string(), serde_json::to_value(v.to_json(&txn)).unwrap_or_default())).collect(),
        None => Vec::new(),
    };
    v.sort_by_key(|(_, f)| f["order"].as_f64().unwrap_or(0.0) as i64);
    v
}

fn public_form(o: &Office, form: &Doc) -> Result<PublicForm> {
    let fields: HashMap<String, Value> = form.parent_id.map(|db| database_fields(o, db)).unwrap_or_default().into_iter().collect();
    let (_, live) = o.open(form.id)?;
    let doc = live.doc.lock().unwrap();
    let txn = doc.transact();
    let description = txn.get_map("form").and_then(|m| m.get(&txn, "description")).map(|v| v.to_string(&txn)).unwrap_or_default();
    let mut questions = Vec::new();
    if let Some(qs) = txn.get_array("questions") {
        for q in qs.iter(&txn) {
            let q = serde_json::to_value(q.to_json(&txn)).unwrap_or_default();
            let Some(id) = q["field"].as_str() else { continue };
            let Some(f) = fields.get(id) else { continue };
            let label = q["label"].as_str().filter(|s| !s.trim().is_empty()).or(f["name"].as_str()).unwrap_or(id).to_string();
            questions.push(PublicQuestion {
                id: id.to_string(),
                label,
                kind: f["type"].as_str().unwrap_or("text").to_string(),
                required: q["required"].as_bool().unwrap_or(false),
                help: q["help"].as_str().filter(|s| !s.is_empty()).map(String::from),
                options: f["options"].as_array().into_iter().flatten().filter_map(|o| o["name"].as_str().map(String::from)).collect(),
            });
        }
    }
    Ok(PublicForm { id: form.id, title: form.title.clone(), description, questions })
}

/// Check answers against the form's questions and turn them into row values.
fn validate_answers(form: &PublicForm, db: &Live, answers: &serde_json::Map<String, Value>) -> Result<Vec<(String, Any)>> {
    // Option names → ids, from the database schema.
    let options: HashMap<String, Vec<(String, String)>> = {
        let doc = db.doc.lock().unwrap();
        let txn = doc.transact();
        txn.get_map("schema")
            .map(|m| {
                m.iter(&txn)
                    .map(|(k, v)| {
                        let f = serde_json::to_value(v.to_json(&txn)).unwrap_or_default();
                        let opts = f["options"].as_array().into_iter().flatten().filter_map(|o| Some((o["name"].as_str()?.to_string(), o["id"].as_str()?.to_string()))).collect();
                        (k.to_string(), opts)
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let pick = |field: &str, name: &str| -> Result<String> {
        options.get(field).and_then(|o| o.iter().find(|(n, id)| n == name || id == name)).map(|(_, id)| id.clone()).with_context(|| format!("`{name}` is not a choice"))
    };
    let mut out = Vec::new();
    for q in &form.questions {
        let a = answers.get(&q.id).filter(|v| !v.is_null() && v.as_str().is_none_or(|s| !s.trim().is_empty()) && v.as_array().is_none_or(|a| !a.is_empty()));
        let Some(a) = a else {
            if q.required {
                bail!("{} is required", q.label);
            }
            continue;
        };
        let text = || a.as_str().map(|s| s.trim().chars().take(10_000).collect::<String>()).with_context(|| format!("{} must be text", q.label));
        let v = match q.kind.as_str() {
            "number" => {
                let n = a.as_f64().or_else(|| a.as_str().and_then(|s| s.trim().replace(',', ".").parse().ok())).with_context(|| format!("{} must be a number", q.label))?;
                Any::from(n)
            }
            "checkbox" => Any::from(a.as_bool().or_else(|| a.as_str().map(|s| s == "true" || s == "on")).unwrap_or(false)),
            "date" => {
                let s = text()?;
                chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d").with_context(|| format!("{} must be a date", q.label))?;
                Any::from(s)
            }
            "url" => {
                let s = text()?;
                if !(s.starts_with("https://") || s.starts_with("http://")) {
                    bail!("{} must be a link", q.label);
                }
                Any::from(s)
            }
            "select" => Any::from(pick(&q.id, &text()?)?),
            "multi_select" => {
                let names: Vec<String> = match a {
                    Value::Array(v) => v.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
                    Value::String(s) => s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
                    _ => bail!("{} must be a list", q.label),
                };
                let ids = names.iter().map(|n| pick(&q.id, n).map(Any::from)).collect::<Result<Vec<_>>>()?;
                Any::from(ids)
            }
            _ => Any::from(text()?),
        };
        out.push((q.id.clone(), v));
    }
    Ok(out)
}

// ---- search text --------------------------------------------------------------------------------

/// Plain text of a document, for search.
pub fn plain_text(doc: &yrs::Doc, kind: DocKind) -> String {
    let txn = doc.transact();
    let mut out = String::new();
    match kind {
        DocKind::Doc => {
            if let Some(f) = txn.get_xml_fragment("content") {
                for c in f.children(&txn) {
                    xml_text(&txn, c, &mut out);
                    out.push('\n');
                }
            }
        }
        DocKind::Sheet => {
            if let Some(m) = txn.get_map("cells") {
                strings(&m.to_json(&txn), &mut out);
            }
        }
        DocKind::Slides => collect(&txn, txn.get_array("slides"), &mut out),
        DocKind::Database => {
            if let Some(m) = txn.get_map("schema") {
                strings(&m.to_json(&txn), &mut out);
            }
            collect(&txn, txn.get_array("rows"), &mut out);
        }
        DocKind::Form => {
            if let Some(m) = txn.get_map("form") {
                strings(&m.to_json(&txn), &mut out);
            }
            collect(&txn, txn.get_array("questions"), &mut out);
        }
    }
    out.trim().to_string()
}

fn collect<T: ReadTxn>(txn: &T, a: Option<ArrayRef>, out: &mut String) {
    if let Some(a) = a {
        strings(&a.to_json(txn), out);
    }
}

fn xml_text<T: ReadTxn>(txn: &T, node: XmlOut, out: &mut String) {
    match node {
        XmlOut::Text(t) => {
            let s = t.get_string(txn);
            // Marks come back as tags; keep the words.
            let mut inside = false;
            for ch in s.chars() {
                match ch {
                    '<' => inside = true,
                    '>' => inside = false,
                    c if !inside => out.push(c),
                    _ => {}
                }
            }
        }
        XmlOut::Element(e) => {
            for c in e.children(txn) {
                xml_text(txn, c, out);
            }
            out.push('\n');
        }
        XmlOut::Fragment(f) => {
            for c in f.children(txn) {
                xml_text(txn, c, out);
            }
        }
    }
}

/// Every human string inside a JSON-ish value, skipping ids, colours and types.
fn strings(v: &Any, out: &mut String) {
    match v {
        Any::String(s) if !s.trim().is_empty() => {
            out.push_str(s);
            out.push('\n');
        }
        Any::Array(a) => a.iter().for_each(|x| strings(x, out)),
        Any::Map(m) => {
            for (k, x) in m.iter() {
                if !matches!(k.as_str(), "id" | "color" | "type" | "layout" | "created" | "field" | "f" | "fmt" | "url" | "shape" | "group_by" | "date_field" | "status" | "channel") {
                    strings(x, out);
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::Text;

    fn text_update(doc: &yrs::Doc, at: u32, s: &str) -> Vec<u8> {
        let before = doc.transact().state_vector();
        {
            let mut txn = doc.transact_mut();
            let t = txn.get_or_insert_text("t");
            t.insert(&mut txn, at, s);
        }
        doc.transact().encode_diff_v1(&before)
    }

    fn text_of(doc: &yrs::Doc) -> String {
        let txn = doc.transact();
        txn.get_text("t").map(|t| t.get_string(&txn)).unwrap_or_default()
    }

    #[test]
    fn apply_persist_reload() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let file = DocFile::new(dir.path(), id);
        let live = Live { ws: Uuid::nil(), doc: Mutex::new(file.load().unwrap()), file: DocFile::new(dir.path(), id), pending: AtomicBool::new(false) };

        let client = yrs::Doc::new();
        let u1 = text_update(&client, 0, "hello");
        live.apply(&u1).unwrap();
        // Logged but not yet snapshotted: a reload replays the log.
        assert_eq!(text_of(&file.load().unwrap()), "hello");

        live.snapshot().unwrap();
        assert!(!dir.path().join(format!("{id}.ylog")).exists());
        let u2 = text_update(&client, 5, " world");
        live.apply(&u2).unwrap();
        assert_eq!(text_of(&file.load().unwrap()), "hello world");

        // A torn trailing log entry is ignored.
        let mut f = fs::OpenOptions::new().append(true).open(dir.path().join(format!("{id}.ylog"))).unwrap();
        f.write_all(&[200, 0, 0, 0, 1, 2]).unwrap();
        assert_eq!(text_of(&file.load().unwrap()), "hello world");

        // The full state loads into a fresh client.
        let fresh = yrs::Doc::new();
        fresh.transact_mut().apply_update(Update::decode_v1(&live.state()).unwrap()).unwrap();
        assert_eq!(text_of(&fresh), "hello world");
    }

    #[test]
    fn concurrent_updates_merge() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let live = Live { ws: Uuid::nil(), doc: Mutex::new(yrs::Doc::new()), file: DocFile::new(dir.path(), id), pending: AtomicBool::new(false) };
        let base = yrs::Doc::new();
        live.apply(&text_update(&base, 0, "ac")).unwrap();

        // Two people start from the same state and edit at once.
        let a = yrs::Doc::new();
        let b = yrs::Doc::new();
        let state = live.state();
        a.transact_mut().apply_update(Update::decode_v1(&state).unwrap()).unwrap();
        b.transact_mut().apply_update(Update::decode_v1(&state).unwrap()).unwrap();
        let ua = text_update(&a, 1, "b");
        let ub = text_update(&b, 2, "d");
        live.apply(&ub).unwrap();
        live.apply(&ua).unwrap();

        let merged = text_of(&live.doc.lock().unwrap());
        assert_eq!(merged, "abcd");
        // Each side converges after receiving the other's update.
        a.transact_mut().apply_update(Update::decode_v1(&ub).unwrap()).unwrap();
        b.transact_mut().apply_update(Update::decode_v1(&ua).unwrap()).unwrap();
        assert_eq!(text_of(&a), merged);
        assert_eq!(text_of(&b), merged);
        // And the merge survives a reload.
        live.snapshot().unwrap();
        assert_eq!(text_of(&DocFile::new(dir.path(), id).load().unwrap()), "abcd");
    }

    #[tokio::test]
    async fn create_seed_and_submit_form() {
        let dir = tempfile::tempdir().unwrap();
        let r = Runner::open(dir.path()).unwrap();
        let ws = r.create_workspace("Test".into(), None).unwrap().id;
        let db: Doc = serde_json::from_value(call(&r, "create_doc", &json!({ "workspace_id": ws, "kind": "database", "title": "Tasks" }), "Maya").await.unwrap().unwrap()).unwrap();
        let form: Doc = serde_json::from_value(call(&r, "create_doc", &json!({ "workspace_id": ws, "kind": "form", "title": "Intake", "parent_id": db.id }), "Maya").await.unwrap().unwrap()).unwrap();
        assert_eq!(form.parent_id, Some(db.id));

        let public: PublicForm = serde_json::from_value(call(&r, "get_form_public", &json!({ "workspace_id": ws, "form_id": form.id }), "x").await.unwrap().unwrap()).unwrap();
        assert_eq!(public.questions.len(), 3);
        assert_eq!(public.questions[1].options, vec!["To do", "Doing", "Done"]);

        let bad = call(&r, "form_submit", &json!({ "workspace_id": ws, "form_id": form.id, "answers": { "date": "not a date" } }), "x").await.unwrap();
        assert!(bad.is_err());
        call(&r, "form_submit", &json!({ "workspace_id": ws, "form_id": form.id, "answers": { "name": "Fix login", "status": "Doing", "date": "2026-12-01" } }), "x").await.unwrap().unwrap();

        let o = office(&r).unwrap();
        let (_, live) = o.open(db.id).unwrap();
        {
            let doc = live.doc.lock().unwrap();
            let txn = doc.transact();
            let rows = txn.get_array("rows").unwrap();
            assert_eq!(rows.len(&txn), 4);
            let last = serde_json::to_value(rows.get(&txn, 3).unwrap().to_json(&txn)).unwrap();
            assert_eq!(last["name"], "Fix login");
            assert_eq!(last["status"], "status-1");
        }

        // Another workspace cannot reach the form.
        assert!(call(&r, "get_form_public", &json!({ "workspace_id": Uuid::new_v4(), "form_id": form.id }), "x").await.unwrap().is_err());
        assert_eq!(workspace_of(&r, "get_doc_state", &json!({ "id": db.id })).unwrap().unwrap(), ws);
    }

    #[tokio::test]
    async fn seeded_doc_has_text() {
        let dir = tempfile::tempdir().unwrap();
        let r = Runner::open(dir.path()).unwrap();
        let ws = r.create_workspace("Test".into(), None).unwrap().id;
        let d: Doc = serde_json::from_value(call(&r, "create_doc", &json!({ "workspace_id": ws, "kind": "doc", "title": "Brief", "template": "project-brief" }), "Maya").await.unwrap().unwrap()).unwrap();
        let o = office(&r).unwrap();
        let (_, live) = o.open(d.id).unwrap();
        let text = plain_text(&live.doc.lock().unwrap(), DocKind::Doc);
        assert!(text.contains("Goal") && text.contains("Milestones"), "{text}");
        // Reload from disk after dropping the live copy.
        o.live.lock().unwrap().clear();
        let state: String = serde_json::from_value(call(&r, "get_doc_state", &json!({ "id": d.id }), "Maya").await.unwrap().unwrap()).unwrap();
        assert!(!state.is_empty());
        let (_, again) = o.open(d.id).unwrap();
        assert_eq!(plain_text(&again.doc.lock().unwrap(), DocKind::Doc), text);
    }
}
