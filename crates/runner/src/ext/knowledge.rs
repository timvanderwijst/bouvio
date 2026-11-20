//! Knowledge: search over everything, imports, web clips, MCP and skills catalog.
//!
//! One tantivy index per workspace lives under `<data>/knowledge/<ws>/index`,
//! with a manifest of content hashes so re-indexing only touches what changed.
//! When the app plugs in an embedding model, text is chunked and embedded in
//! the background into `vectors.bin`; search then fuses BM25 with brute-force
//! cosine similarity through reciprocal rank fusion.

use crate::{store, Runner};
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use bouvio_protocol::knowledge::*;
use bouvio_protocol::{Artifact, ArtifactKind, McpServer, ThreadEvent};
use chrono::{DateTime, Utc};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tantivy::collector::TopDocs;
use tantivy::directory::MmapDirectory;
use tantivy::query::{BooleanQuery, BoostQuery, Occur, PhrasePrefixQuery, Query, TermQuery};
use tantivy::schema::{Field, IndexRecordOption, Schema, Value as _, STORED, STRING, TEXT};
use tantivy::{DocAddress, Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument, Term};
use uuid::Uuid;

// ---- limits ---------------------------------------------------------------------------------

const MAX_FILE: u64 = 1024 * 1024;
const MAX_FILES: usize = 20_000;
/// Text kept for snippets and chunking; the full text is indexed.
const MAX_STORED: usize = 64 * 1024;
const MAX_THREAD_TEXT: usize = 512 * 1024;
const CHUNK: usize = 800;
const OVERLAP: usize = 150;
const MAX_CHUNKS: usize = 32;
const MAX_PENDING: usize = 20_000;
const RRF_K: f32 = 60.0;
const SCAN_EVERY: Duration = Duration::from_secs(5 * 60);
const CATALOG_TTL: Duration = Duration::from_secs(60 * 60);
const SKILLS_REPO: &str = "anthropics/skills";
const MCP_REGISTRY: &str = "https://registry.modelcontextprotocol.io/v0/servers";

// ---- params ---------------------------------------------------------------------------------

fn p<T: DeserializeOwned>(params: &Value, key: &str) -> Result<T> {
    serde_json::from_value(params.get(key).cloned().unwrap_or(Value::Null)).with_context(|| format!("param `{key}`"))
}

fn opt<T: DeserializeOwned>(params: &Value, key: &str) -> Option<T> {
    params.get(key).cloned().filter(|v| !v.is_null()).and_then(|v| serde_json::from_value(v).ok())
}

fn ok<T: serde::Serialize>(v: T) -> Result<Value> {
    Ok(serde_json::to_value(v)?)
}

// ---- entry points ----------------------------------------------------------------------------

pub async fn call(r: &Arc<Runner>, method: &str, params: &Value, _actor: &str) -> Option<Result<Value>> {
    let w = || p::<Uuid>(params, "workspace_id");
    let out = match method {
        "search" => search(r, params).await.and_then(ok),
        "reindex" => match w() {
            Ok(ws) => reindex_now(r, ws).await.and_then(ok),
            Err(e) => Err(e),
        },
        "get_index_status" => w().map(|ws| status(r, ws)).and_then(ok),
        "import_file" => async {
            let ws = w()?;
            let path: String = p(params, "path")?;
            let path = PathBuf::from(path);
            let bytes = tokio::fs::read(&path).await.with_context(|| format!("read {}", path.display()))?;
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "import".into());
            import(r, ws, &name, bytes, Source::File(path.to_string_lossy().into_owned())).await
        }
        .await
        .and_then(ok),
        "import_bytes" => async {
            let ws = w()?;
            let name: String = p(params, "name")?;
            let b64: String = p(params, "base64")?;
            let b64 = b64.split_once(";base64,").map(|(_, b)| b.to_string()).unwrap_or(b64);
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).context("invalid base64")?;
            import(r, ws, &name, bytes, Source::Upload(name.clone())).await
        }
        .await
        .and_then(ok),
        "clip_url" => match w() {
            Ok(ws) => match p::<String>(params, "url") {
                Ok(url) => clip_url(r, ws, &url).await.and_then(ok),
                Err(e) => Err(e),
            },
            Err(e) => Err(e),
        },
        "search_mcp_registry" => search_mcp_registry(&opt::<String>(params, "query").unwrap_or_default()).await.and_then(ok),
        "install_mcp" => w().and_then(|ws| install_mcp(r, ws, p(params, "server")?)).and_then(ok),
        "remove_mcp" => w().and_then(|ws| remove_mcp(r, ws, &p::<String>(params, "name")?)).and_then(ok),
        "list_skills_catalog" => list_skills_catalog(r, opt(params, "refresh").unwrap_or(false)).await.and_then(ok),
        "get_skill_sources" => ok(skill_sources(r)),
        "set_skill_sources" => p::<Vec<String>>(params, "sources").and_then(|s| set_skill_sources(r, s)).and_then(ok),
        "install_skill" => match (w(), p::<SkillSource>(params, "source")) {
            (Ok(ws), Ok(src)) => install_skill(r, ws, &src).await.and_then(ok),
            (Err(e), _) | (_, Err(e)) => Err(e),
        },
        "list_installed_skills" => w().map(|ws| list_installed_skills(r, ws)).and_then(ok),
        "remove_skill" => w().and_then(|ws| remove_skill(r, ws, &p::<String>(params, "name")?)).and_then(ok),
        _ => return None,
    };
    Some(out)
}

pub fn workspace_of(_r: &Runner, method: &str, params: &Value) -> Option<Result<Uuid>> {
    match method {
        // Catalog lookups carry the workspace they are made from, so the hub can scope them.
        "search" | "search_mcp_registry" | "list_skills_catalog" | "get_skill_sources" => {
            Some(opt::<Uuid>(params, "workspace_id").context("pass `workspace_id` to search through the hub"))
        }
        "set_skill_sources" => Some(Err(anyhow!("skill sources are set on the runner's own machine"))),
        _ => None,
    }
}

pub fn start(r: &Arc<Runner>) {
    let kb = kb_of(r);
    if kb.background.swap(true, Ordering::SeqCst) {
        return;
    }

    // Full scans: soon after start, then every few minutes.
    let me = r.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        loop {
            for ws in local_workspaces(&me) {
                let r2 = me.clone();
                let _ = tokio::task::spawn_blocking(move || full_reindex(&r2, ws)).await;
            }
            tokio::time::sleep(SCAN_EVERY).await;
        }
    });

    // Live changes, collected into a set and flushed every two seconds.
    let k = kb.clone();
    let mut events = r.subscribe_events();
    tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(e) => {
                    if matches!(e.event, ThreadEvent::UserMessage { .. } | ThreadEvent::AssistantText { .. }) {
                        k.mark(Item::Thread(e.thread_id));
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });
    let k = kb.clone();
    let mut threads = r.subscribe_threads();
    tokio::spawn(async move {
        loop {
            match threads.recv().await {
                Ok(t) => k.mark(Item::Thread(t.id)),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });
    let k = kb.clone();
    let mut notices = r.subscribe_notices();
    tokio::spawn(async move {
        loop {
            match notices.recv().await {
                Ok(n) => {
                    let id = n.payload.get("id").and_then(|v| v.as_str()).and_then(|s| s.parse::<Uuid>().ok());
                    match (n.kind.as_str(), id) {
                        ("issue-changed", Some(id)) => k.mark(Item::Issue(n.workspace_id, id)),
                        ("issue-deleted", Some(id)) => k.mark(Item::IssueGone(n.workspace_id, id)),
                        ("artifact-changed", Some(id)) => k.mark(Item::Artifact(n.workspace_id, id)),
                        _ => {}
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });

    let me = r.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let items: Vec<Item> = std::mem::take(&mut *kb_of(&me).dirty.lock().unwrap()).into_iter().collect();
            if items.is_empty() {
                continue;
            }
            let r2 = me.clone();
            let _ = tokio::task::spawn_blocking(move || {
                for it in items {
                    if let Err(e) = index_item(&r2, it) {
                        tracing::debug!("knowledge: {e:#}");
                    }
                }
            })
            .await;
        }
    });

    // Commits, at most once a second per workspace.
    let me = r.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let r2 = me.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let kb = kb_of(&r2);
                let all: Vec<_> = kb.indexes.lock().unwrap().values().cloned().collect();
                for ix in all {
                    if let Err(e) = ix.flush() {
                        tracing::warn!("knowledge commit: {e:#}");
                    }
                }
            })
            .await;
        }
    });

    // Embeddings, when a model is plugged in.
    let me = r.clone();
    tokio::spawn(async move {
        loop {
            let worked = embed_some(&me).await;
            tokio::time::sleep(Duration::from_millis(if worked { 200 } else { 3000 })).await;
        }
    });
}

/// Other areas call this when something searchable changes (a doc, a note).
/// `kind` names the source (`doc`, `sheet`, `note`, …); `id` is unique within it.
pub fn index(r: &Runner, workspace_id: Uuid, kind: &str, id: &str, title: &str, text: &str) {
    let kb = kb_of(r);
    let Ok(ix) = kb.open(workspace_id) else { return };
    let doc = Doc {
        key: format!("{kind}:{id}"),
        kind: kind.to_string(),
        id: id.to_string(),
        loc: SearchLocation::Doc { kind: kind.to_string(), id: id.to_string() },
        hash: fnv(&[title.as_bytes(), text.as_bytes()]),
    };
    let semantic = r.hooks.embed().is_some();
    if let Err(e) = ix.upsert(&kb, doc, semantic, || Some((title.to_string(), text.to_string()))) {
        tracing::warn!("knowledge index {kind}:{id}: {e:#}");
    }
    kb.after_write(&ix);
}

/// Remove something from the index again.
pub fn unindex(r: &Runner, workspace_id: Uuid, kind: &str, id: &str) {
    let kb = kb_of(r);
    let Ok(ix) = kb.open(workspace_id) else { return };
    ix.remove(&kb, &format!("{kind}:{id}"));
    kb.after_write(&ix);
}

// ---- state ------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Item {
    Thread(Uuid),
    Issue(Uuid, Uuid),
    IssueGone(Uuid, Uuid),
    Artifact(Uuid, Uuid),
}

struct EmbedJob {
    hash: u64,
    title: String,
    text: String,
}

struct Kb {
    dir: PathBuf,
    indexes: Mutex<HashMap<Uuid, Arc<WsIndex>>>,
    dirty: Mutex<HashSet<Item>>,
    pending: Mutex<HashMap<(Uuid, String), EmbedJob>>,
    background: AtomicBool,
    qcache: Mutex<HashMap<String, Vec<f32>>>,
    catalog: Mutex<Option<(Instant, Vec<SkillEntry>)>>,
    trees: Mutex<HashMap<String, (Instant, Vec<String>)>>,
}

/// One knowledge state per data dir, so tests with several runners stay apart.
fn kb_of(r: &Runner) -> Arc<Kb> {
    static ALL: OnceLock<Mutex<HashMap<PathBuf, Arc<Kb>>>> = OnceLock::new();
    let dir = r.store().dir().join("knowledge");
    ALL.get_or_init(Default::default)
        .lock()
        .unwrap()
        .entry(dir.clone())
        .or_insert_with(|| {
            Arc::new(Kb {
                dir,
                indexes: Mutex::new(HashMap::new()),
                dirty: Mutex::new(HashSet::new()),
                pending: Mutex::new(HashMap::new()),
                background: AtomicBool::new(false),
                qcache: Mutex::new(HashMap::new()),
                catalog: Mutex::new(None),
                trees: Mutex::new(HashMap::new()),
            })
        })
        .clone()
}

impl Kb {
    fn mark(&self, it: Item) {
        self.dirty.lock().unwrap().insert(it);
    }

    fn open(&self, ws: Uuid) -> Result<Arc<WsIndex>> {
        let mut all = self.indexes.lock().unwrap();
        if let Some(ix) = all.get(&ws) {
            return Ok(ix.clone());
        }
        let ix = Arc::new(WsIndex::open(ws, &self.dir.join(ws.to_string()))?);
        all.insert(ws, ix.clone());
        Ok(ix)
    }

    /// Without the background committer (tests, one-off runners) writes land at once.
    fn after_write(&self, ix: &WsIndex) {
        if !self.background.load(Ordering::SeqCst) {
            if let Err(e) = ix.flush() {
                tracing::warn!("knowledge commit: {e:#}");
            }
        }
    }

    fn enqueue(&self, ws: Uuid, key: &str, hash: u64, title: &str, text: &str) {
        let mut q = self.pending.lock().unwrap();
        if q.len() >= MAX_PENDING && !q.contains_key(&(ws, key.to_string())) {
            return;
        }
        let text = truncate_chars(text, MAX_STORED).to_string();
        q.insert((ws, key.to_string()), EmbedJob { hash, title: title.to_string(), text });
    }

    fn pending_for(&self, ws: Uuid) -> usize {
        self.pending.lock().unwrap().keys().filter(|(w, _)| *w == ws).count()
    }
}

// ---- the index of one workspace ---------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Fields {
    key: Field,
    kind: Field,
    id: Field,
    title: Field,
    body: Field,
    text: Field,
    loc: Field,
}

fn schema() -> (Schema, Fields) {
    let mut b = Schema::builder();
    let f = Fields {
        key: b.add_text_field("key", STRING | STORED),
        kind: b.add_text_field("kind", STRING | STORED),
        id: b.add_text_field("id", STORED),
        title: b.add_text_field("title", TEXT | STORED),
        body: b.add_text_field("body", TEXT),
        text: b.add_text_field("text", STORED),
        loc: b.add_text_field("loc", STORED),
    };
    (b.build(), f)
}

struct Doc {
    key: String,
    kind: String,
    id: String,
    loc: SearchLocation,
    hash: u64,
}

struct WsIndex {
    ws: Uuid,
    dir: PathBuf,
    reader: IndexReader,
    writer: Option<Mutex<IndexWriter>>,
    f: Fields,
    manifest: Mutex<HashMap<String, u64>>,
    dirty: AtomicBool,
    vectors: Mutex<Vectors>,
    vectors_dirty: AtomicBool,
    last_scan: Mutex<Option<DateTime<Utc>>>,
}

impl WsIndex {
    fn open(ws: Uuid, dir: &Path) -> Result<Self> {
        let idx_dir = dir.join("index-v1");
        std::fs::create_dir_all(&idx_dir)?;
        let (schema, f) = schema();
        let index = match Index::open_or_create(MmapDirectory::open(&idx_dir)?, schema.clone()) {
            Ok(i) => i,
            Err(e) => {
                // A broken or older index is only a cache: start over.
                tracing::warn!("knowledge: rebuilding index for {ws}: {e}");
                let _ = std::fs::remove_dir_all(&idx_dir);
                let _ = std::fs::remove_file(dir.join("manifest.json"));
                std::fs::create_dir_all(&idx_dir)?;
                Index::open_or_create(MmapDirectory::open(&idx_dir)?, schema)?
            }
        };
        let reader = index.reader_builder().reload_policy(ReloadPolicy::Manual).try_into()?;
        let writer = match index.writer_with_num_threads(1, 20_000_000) {
            Ok(w) => Some(Mutex::new(w)),
            Err(e) => {
                // Another process (a headless runner on the same data dir) owns it.
                tracing::warn!("knowledge: index for {ws} is read-only: {e}");
                None
            }
        };
        let manifest = if writer.is_some() { store::load(&dir.join("manifest.json")).unwrap_or_default() } else { HashMap::new() };
        let vectors = Vectors::load(&dir.join("vectors.bin")).unwrap_or_default();
        Ok(Self {
            ws,
            dir: dir.to_path_buf(),
            reader,
            writer,
            f,
            manifest: Mutex::new(manifest),
            dirty: AtomicBool::new(false),
            vectors: Mutex::new(vectors),
            vectors_dirty: AtomicBool::new(false),
            last_scan: Mutex::new(None),
        })
    }

    /// Add or replace one item. `make` is only called when it changed (or
    /// still needs an embedding); it returns the title and text.
    fn upsert(&self, kb: &Kb, doc: Doc, semantic: bool, make: impl FnOnce() -> Option<(String, String)>) -> Result<bool> {
        let Some(w) = &self.writer else { return Ok(false) };
        let unchanged = self.manifest.lock().unwrap().get(&doc.key) == Some(&doc.hash);
        if unchanged {
            if semantic && !self.vectors.lock().unwrap().has(&doc.key, doc.hash) && !kb.pending.lock().unwrap().contains_key(&(self.ws, doc.key.clone())) {
                if let Some((title, text)) = make() {
                    kb.enqueue(self.ws, &doc.key, doc.hash, &title, &text);
                }
            }
            return Ok(false);
        }
        let Some((title, text)) = make() else {
            self.remove(kb, &doc.key);
            return Ok(false);
        };
        let mut d = TantivyDocument::default();
        d.add_text(self.f.key, &doc.key);
        d.add_text(self.f.kind, &doc.kind);
        d.add_text(self.f.id, &doc.id);
        d.add_text(self.f.title, &title);
        d.add_text(self.f.body, &text);
        d.add_text(self.f.text, truncate_chars(&text, MAX_STORED));
        d.add_text(self.f.loc, serde_json::to_string(&doc.loc)?);
        {
            let w = w.lock().unwrap();
            w.delete_term(Term::from_field_text(self.f.key, &doc.key));
            w.add_document(d)?;
        }
        self.manifest.lock().unwrap().insert(doc.key.clone(), doc.hash);
        self.dirty.store(true, Ordering::SeqCst);
        if semantic && !text.trim().is_empty() {
            kb.enqueue(self.ws, &doc.key, doc.hash, &title, &text);
        }
        Ok(true)
    }

    fn remove(&self, kb: &Kb, key: &str) {
        let Some(w) = &self.writer else { return };
        w.lock().unwrap().delete_term(Term::from_field_text(self.f.key, key));
        self.manifest.lock().unwrap().remove(key);
        kb.pending.lock().unwrap().remove(&(self.ws, key.to_string()));
        if self.vectors.lock().unwrap().remove(key) {
            self.vectors_dirty.store(true, Ordering::SeqCst);
        }
        self.dirty.store(true, Ordering::SeqCst);
    }

    /// Keys of one kind the manifest knows, for pruning what disappeared.
    fn keys_of(&self, kind: &str) -> Vec<String> {
        let prefix = format!("{kind}:");
        self.manifest.lock().unwrap().keys().filter(|k| k.starts_with(&prefix)).cloned().collect()
    }

    fn flush(&self) -> Result<()> {
        if self.dirty.swap(false, Ordering::SeqCst) {
            if let Some(w) = &self.writer {
                w.lock().unwrap().commit()?;
                self.reader.reload()?;
                let m = self.manifest.lock().unwrap().clone();
                store::save(&self.dir.join("manifest.json"), &m)?;
            }
        }
        if self.vectors_dirty.swap(false, Ordering::SeqCst) {
            self.vectors.lock().unwrap().save(&self.dir.join("vectors.bin"))?;
        }
        Ok(())
    }

    fn num_docs(&self) -> u64 {
        self.reader.searcher().num_docs()
    }

    fn bm25(&self, tokens: &[String], kinds: &[String], n: usize) -> Result<Vec<DocAddress>> {
        let searcher = self.reader.searcher();
        for conjunction in [true, false] {
            if !conjunction && tokens.len() < 2 {
                break;
            }
            let mut clauses: Vec<(Occur, Box<dyn Query>)> = Vec::new();
            for (i, tok) in tokens.iter().enumerate() {
                let mut alts: Vec<(Occur, Box<dyn Query>)> = vec![
                    (Occur::Should, Box::new(BoostQuery::new(Box::new(TermQuery::new(Term::from_field_text(self.f.title, tok), IndexRecordOption::WithFreqs)), 2.0))),
                    (Occur::Should, Box::new(TermQuery::new(Term::from_field_text(self.f.body, tok), IndexRecordOption::WithFreqs))),
                ];
                // The word being typed matches as a prefix.
                if i == tokens.len() - 1 {
                    alts.push((Occur::Should, Box::new(BoostQuery::new(Box::new(PhrasePrefixQuery::new(vec![Term::from_field_text(self.f.title, tok)])), 1.2))));
                    alts.push((Occur::Should, Box::new(BoostQuery::new(Box::new(PhrasePrefixQuery::new(vec![Term::from_field_text(self.f.body, tok)])), 0.4))));
                }
                clauses.push((if conjunction { Occur::Must } else { Occur::Should }, Box::new(BooleanQuery::new(alts))));
            }
            if !kinds.is_empty() {
                let ks: Vec<(Occur, Box<dyn Query>)> = kinds
                    .iter()
                    .map(|k| (Occur::Should, Box::new(TermQuery::new(Term::from_field_text(self.f.kind, k), IndexRecordOption::Basic)) as Box<dyn Query>))
                    .collect();
                clauses.push((Occur::Must, Box::new(BooleanQuery::new(ks))));
            }
            let q = BooleanQuery::new(clauses);
            let top = searcher.search(&q, &TopDocs::with_limit(n).order_by_score())?;
            if !top.is_empty() {
                return Ok(top.into_iter().map(|(_, a)| a).collect());
            }
        }
        Ok(Vec::new())
    }

    fn find_key(&self, key: &str) -> Result<Option<TantivyDocument>> {
        let searcher = self.reader.searcher();
        let q = TermQuery::new(Term::from_field_text(self.f.key, key), IndexRecordOption::Basic);
        let top = searcher.search(&q, &TopDocs::with_limit(1).order_by_score())?;
        match top.first() {
            Some((_, a)) => Ok(Some(searcher.doc(*a)?)),
            None => Ok(None),
        }
    }

    fn search(&self, query: &str, kinds: &[String], limit: usize, qvec: Option<&[f32]>) -> Result<Vec<SearchHit>> {
        let tokens = tokenize(query);
        if tokens.is_empty() {
            return Ok(Vec::new());
        }
        let n = (limit * 3).max(30);
        let searcher = self.reader.searcher();
        let lexical = self.bm25(&tokens, kinds, n)?;
        let mut docs: HashMap<String, TantivyDocument> = HashMap::new();
        let mut lex_keys = Vec::new();
        for a in lexical {
            let d: TantivyDocument = searcher.doc(a)?;
            let key = str_field(&d, self.f.key);
            lex_keys.push(key.clone());
            docs.insert(key, d);
        }
        let mut chunk_of: HashMap<String, (u32, u32)> = HashMap::new();
        let mut sem_keys = Vec::new();
        if let Some(q) = qvec {
            for (key, start, len) in self.vectors.lock().unwrap().nearest(q, kinds, n, 0.3) {
                chunk_of.insert(key.clone(), (start, len));
                sem_keys.push(key);
            }
        }
        let fused = rrf(&[lex_keys, sem_keys]);
        let mut out = Vec::new();
        for (key, score) in fused.into_iter().take(limit) {
            let d = match docs.remove(&key) {
                Some(d) => d,
                None => match self.find_key(&key)? {
                    Some(d) => d,
                    None => continue,
                },
            };
            let text = str_field(&d, self.f.text);
            let loc: SearchLocation = match serde_json::from_str(&str_field(&d, self.f.loc)) {
                Ok(l) => l,
                Err(_) => continue,
            };
            out.push(SearchHit {
                kind: str_field(&d, self.f.kind),
                id: str_field(&d, self.f.id),
                title: str_field(&d, self.f.title),
                snippet: make_snippet(&text, &tokens, chunk_of.get(&key).map(|c| c.0 as usize), 180),
                score,
                workspace_id: self.ws,
                location: loc,
            });
        }
        Ok(out)
    }
}

fn str_field(d: &TantivyDocument, f: Field) -> String {
    d.get_first(f).and_then(|v| v.as_str()).unwrap_or_default().to_string()
}

// ---- vectors --------------------------------------------------------------------------------------------

/// Embedded chunks of one workspace, quantized to i8 (vectors are unit length).
#[derive(Default)]
struct Vectors {
    dim: usize,
    entries: Vec<VecEntry>,
}

struct VecEntry {
    key: String,
    hash: u64,
    start: u32,
    len: u32,
    v: Vec<i8>,
}

const VEC_MAGIC: &[u8; 6] = b"BVEC1\n";

impl Vectors {
    fn has(&self, key: &str, hash: u64) -> bool {
        self.entries.iter().any(|e| e.key == key && e.hash == hash)
    }

    fn remove(&mut self, key: &str) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| e.key != key);
        before != self.entries.len()
    }

    fn replace(&mut self, key: &str, hash: u64, chunks: &[(usize, usize)], vecs: Vec<Vec<f32>>) {
        self.remove(key);
        let Some(dim) = vecs.first().map(|v| v.len()) else { return };
        if self.dim != dim {
            // Another model: older vectors are not comparable.
            self.entries.clear();
            self.dim = dim;
        }
        for ((start, len), v) in chunks.iter().zip(vecs) {
            if v.len() != dim {
                continue;
            }
            self.entries.push(VecEntry { key: key.to_string(), hash, start: *start as u32, len: *len as u32, v: quantize(&v) });
        }
    }

    /// Best chunk per item, most similar first: (key, chunk start, chunk length).
    fn nearest(&self, q: &[f32], kinds: &[String], n: usize, min: f32) -> Vec<(String, u32, u32)> {
        if q.len() != self.dim || self.entries.is_empty() {
            return Vec::new();
        }
        let q = normalize(q.to_vec());
        let mut best: HashMap<&str, (f32, u32, u32)> = HashMap::new();
        for e in &self.entries {
            if !kinds.is_empty() && !kinds.iter().any(|k| e.key.len() > k.len() && e.key.starts_with(k.as_str()) && e.key.as_bytes()[k.len()] == b':') {
                continue;
            }
            let s: f32 = e.v.iter().zip(&q).map(|(a, b)| *a as f32 * b).sum::<f32>() / 127.0;
            if s < min {
                continue;
            }
            let slot = best.entry(&e.key).or_insert((f32::MIN, 0, 0));
            if s > slot.0 {
                *slot = (s, e.start, e.len);
            }
        }
        let mut v: Vec<_> = best.into_iter().map(|(k, (s, st, l))| (s, k.to_string(), st, l)).collect();
        v.sort_by(|a, b| b.0.total_cmp(&a.0));
        v.into_iter().take(n).map(|(_, k, s, l)| (k, s, l)).collect()
    }

    fn save(&self, path: &Path) -> Result<()> {
        let mut out = Vec::with_capacity(16 + self.entries.len() * (self.dim + 40));
        out.extend_from_slice(VEC_MAGIC);
        out.extend_from_slice(&(self.dim as u32).to_le_bytes());
        out.extend_from_slice(&(self.entries.len() as u32).to_le_bytes());
        for e in &self.entries {
            let k = e.key.as_bytes();
            out.extend_from_slice(&(k.len() as u16).to_le_bytes());
            out.extend_from_slice(k);
            out.extend_from_slice(&e.hash.to_le_bytes());
            out.extend_from_slice(&e.start.to_le_bytes());
            out.extend_from_slice(&e.len.to_le_bytes());
            out.extend(e.v.iter().map(|x| *x as u8));
        }
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d)?;
        }
        let tmp = path.with_extension("bin.tmp");
        std::fs::write(&tmp, out)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    fn load(path: &Path) -> Result<Self> {
        let b = std::fs::read(path)?;
        let mut c = Cursor::new(b);
        let mut magic = [0u8; 6];
        c.read_exact(&mut magic)?;
        if &magic != VEC_MAGIC {
            bail!("not a vectors file");
        }
        let mut u32b = [0u8; 4];
        let mut u16b = [0u8; 2];
        let mut u64b = [0u8; 8];
        c.read_exact(&mut u32b)?;
        let dim = u32::from_le_bytes(u32b) as usize;
        c.read_exact(&mut u32b)?;
        let n = u32::from_le_bytes(u32b) as usize;
        let mut entries = Vec::with_capacity(n.min(1_000_000));
        for _ in 0..n {
            c.read_exact(&mut u16b)?;
            let mut k = vec![0u8; u16::from_le_bytes(u16b) as usize];
            c.read_exact(&mut k)?;
            c.read_exact(&mut u64b)?;
            let hash = u64::from_le_bytes(u64b);
            c.read_exact(&mut u32b)?;
            let start = u32::from_le_bytes(u32b);
            c.read_exact(&mut u32b)?;
            let len = u32::from_le_bytes(u32b);
            let mut v = vec![0u8; dim];
            c.read_exact(&mut v)?;
            entries.push(VecEntry { key: String::from_utf8(k)?, hash, start, len, v: v.into_iter().map(|x| x as i8).collect() });
        }
        Ok(Self { dim, entries })
    }
}

fn normalize(mut v: Vec<f32>) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
    v
}

fn quantize(v: &[f32]) -> Vec<i8> {
    normalize(v.to_vec()).into_iter().map(|x| (x * 127.0).round().clamp(-127.0, 127.0) as i8).collect()
}

/// Reciprocal rank fusion of ranked key lists: best first, with the fused score.
fn rrf(lists: &[Vec<String>]) -> Vec<(String, f32)> {
    let mut score: HashMap<&str, f32> = HashMap::new();
    let mut order: Vec<&str> = Vec::new();
    for list in lists {
        for (rank, key) in list.iter().enumerate() {
            let e = score.entry(key.as_str()).or_insert_with(|| {
                order.push(key.as_str());
                0.0
            });
            *e += 1.0 / (RRF_K + rank as f32 + 1.0);
        }
    }
    let mut out: Vec<(String, f32)> = order.into_iter().map(|k| (k.to_string(), score[k])).collect();
    // Stable: ties keep the order of the first list.
    out.sort_by(|a, b| b.1.total_cmp(&a.1));
    out
}

/// Split text into overlapping chunks of about `size` characters, ending at
/// whitespace where possible. Returns (start, length) in characters.
fn chunk(text: &str, size: usize, overlap: usize) -> Vec<(usize, usize)> {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut out = Vec::new();
    if n == 0 {
        return out;
    }
    let mut start = 0;
    loop {
        let mut end = (start + size).min(n);
        if end < n {
            // Back up to a space, but not further than a quarter chunk.
            if let Some(ws) = (start + size * 3 / 4..end).rev().find(|&i| chars[i].is_whitespace()) {
                end = ws + 1;
            }
        }
        out.push((start, end - start));
        if end >= n {
            break;
        }
        let mut next = end.saturating_sub(overlap).max(start + 1);
        // Start the next chunk at a word.
        while next < end && !chars[next - 1].is_whitespace() {
            next += 1;
        }
        start = if next >= end { end } else { next };
    }
    out
}

fn slice_chars(text: &str, start: usize, len: usize) -> String {
    text.chars().skip(start).take(len).collect()
}

/// Pick a few embedding jobs and run them. Returns whether anything happened.
async fn embed_some(r: &Arc<Runner>) -> bool {
    let Some(embed) = r.hooks.embed() else { return false };
    let kb = kb_of(r);
    let jobs: Vec<((Uuid, String), EmbedJob)> = {
        let mut q = kb.pending.lock().unwrap();
        let keys: Vec<_> = q.keys().take(4).cloned().collect();
        keys.into_iter().filter_map(|k| q.remove(&k).map(|j| (k, j))).collect()
    };
    if jobs.is_empty() {
        return false;
    }
    for ((ws, key), job) in jobs {
        let chunks: Vec<_> = chunk(&job.text, CHUNK, OVERLAP).into_iter().take(MAX_CHUNKS).collect();
        let texts: Vec<String> = chunks.iter().map(|(s, l)| format!("{}\n{}", job.title, slice_chars(&job.text, *s, *l))).collect();
        if texts.is_empty() {
            continue;
        }
        match embed(texts).await {
            Ok(vecs) if vecs.len() == chunks.len() => {
                if let Ok(ix) = kb.open(ws) {
                    // Still current? It may have changed while we waited.
                    if ix.manifest.lock().unwrap().get(&key) == Some(&job.hash) {
                        ix.vectors.lock().unwrap().replace(&key, job.hash, &chunks, vecs);
                        ix.vectors_dirty.store(true, Ordering::SeqCst);
                    }
                }
            }
            Ok(_) => tracing::warn!("knowledge: embedding count mismatch for {key}"),
            Err(e) => {
                tracing::debug!("knowledge: embedding failed: {e:#}");
                // Try again later rather than hammer a model that is down.
                kb.pending.lock().unwrap().entry((ws, key)).or_insert(job);
                tokio::time::sleep(Duration::from_secs(30)).await;
                return false;
            }
        }
    }
    true
}

async fn query_vector(r: &Arc<Runner>, query: &str) -> Option<Vec<f32>> {
    let embed = r.hooks.embed()?;
    let kb = kb_of(r);
    let q = query.trim().to_lowercase();
    if let Some(v) = kb.qcache.lock().unwrap().get(&q) {
        return Some(v.clone());
    }
    let v = tokio::time::timeout(Duration::from_millis(1500), embed(vec![query.to_string()])).await.ok()?.ok()?.into_iter().next()?;
    let mut c = kb.qcache.lock().unwrap();
    if c.len() > 128 {
        c.clear();
    }
    c.insert(q, v.clone());
    Some(v)
}

// ---- text helpers ----------------------------------------------------------------------------------------

/// FNV-1a over parts; stable across builds, unlike `DefaultHasher`.
fn fnv(parts: &[&[u8]]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for p in parts {
        for b in p.iter().chain(std::iter::once(&0xffu8)) {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    h
}

fn truncate_chars(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Words the way tantivy's default tokenizer sees them: alphanumeric runs, lowercased.
fn tokenize(q: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for w in q.split(|c: char| !c.is_alphanumeric()) {
        if w.is_empty() || w.len() > 40 {
            continue;
        }
        let w = w.to_lowercase();
        if !out.contains(&w) {
            out.push(w);
        }
    }
    out.truncate(12);
    out
}

fn lower1(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// A window of `text` around the first matching word, with matches marked.
/// `around` is a character offset to fall back to (a semantic chunk).
fn make_snippet(text: &str, tokens: &[String], around: Option<usize>, max: usize) -> SearchSnippet {
    let chars: Vec<char> = text.chars().collect();
    let lower: Vec<char> = chars.iter().map(|c| lower1(*c)).collect();
    let toks: Vec<Vec<char>> = tokens.iter().map(|t| t.chars().collect()).collect();
    let match_at = |l: &[char], i: usize| -> Option<usize> {
        if !l[i].is_alphanumeric() || (i > 0 && l[i - 1].is_alphanumeric()) {
            return None;
        }
        toks.iter().filter(|t| l.len() - i >= t.len() && l[i..i + t.len()] == t[..]).map(|t| t.len()).max()
    };
    let first = (0..lower.len()).find(|&i| match_at(&lower, i).is_some());
    let mut start = match (first, around) {
        (Some(p), _) => p.saturating_sub(max / 4),
        (None, Some(a)) => a.min(chars.len()),
        (None, None) => 0,
    };
    // Begin at a word.
    if start > 0 {
        while start < chars.len() && start > 0 && !chars[start - 1].is_whitespace() && first.is_none_or(|p| start < p) {
            start += 1;
        }
    }
    let mut end = (start + max).min(chars.len());
    if end < chars.len() {
        if let Some(ws) = (start + max * 3 / 4..end).rev().find(|&i| chars[i].is_whitespace()) {
            end = ws;
        }
    }
    // Collapse whitespace.
    let mut window: Vec<char> = Vec::with_capacity(end - start + 2);
    if start > 0 {
        window.push('…');
    }
    for c in &chars[start..end] {
        if c.is_whitespace() {
            if window.last().is_some_and(|l| *l != ' ' && *l != '…') {
                window.push(' ');
            }
        } else {
            window.push(*c);
        }
    }
    while window.last() == Some(&' ') {
        window.pop();
    }
    if end < chars.len() {
        window.push('…');
    }
    let wl: Vec<char> = window.iter().map(|c| lower1(*c)).collect();
    let mut highlights = Vec::new();
    let mut i = 0;
    let utf16 = |upto: usize| window[..upto].iter().map(|c| c.len_utf16() as u32).sum::<u32>();
    while i < wl.len() {
        if let Some(len) = match_at(&wl, i) {
            highlights.push((utf16(i), utf16(i + len)));
            i += len;
        } else {
            i += 1;
        }
    }
    SearchSnippet { text: window.into_iter().collect(), highlights }
}

// ---- indexing sources -----------------------------------------------------------------------------------

fn local_workspaces(r: &Runner) -> Vec<Uuid> {
    r.workspaces().into_iter().filter(|w| w.role.is_none()).map(|w| w.id).collect()
}

fn thread_text(r: &Runner, thread_id: Uuid) -> String {
    let mut out = String::new();
    for e in r.thread_events(thread_id).unwrap_or_default() {
        let t = match &e.event {
            ThreadEvent::UserMessage { text, .. } | ThreadEvent::AssistantText { text } => text,
            _ => continue,
        };
        if out.len() + t.len() > MAX_THREAD_TEXT {
            break;
        }
        out.push_str(t);
        out.push_str("\n\n");
    }
    out
}

fn index_thread(r: &Runner, kb: &Kb, ix: &WsIndex, t: &bouvio_protocol::Thread, semantic: bool) -> Result<()> {
    let doc = Doc {
        key: format!("thread:{}", t.id),
        kind: "thread".into(),
        id: t.id.to_string(),
        loc: SearchLocation::Thread { thread_id: t.id },
        hash: fnv(&[t.title.as_bytes(), &t.updated_at.timestamp_millis().to_le_bytes()]),
    };
    ix.upsert(kb, doc, semantic, || Some((t.title.clone(), thread_text(r, t.id))))?;
    Ok(())
}

fn index_issue(kb: &Kb, ix: &WsIndex, i: &bouvio_protocol::Issue, semantic: bool) -> Result<()> {
    let title = format!("{} {}", i.key, i.title);
    let doc = Doc {
        key: format!("issue:{}", i.id),
        kind: "issue".into(),
        id: i.id.to_string(),
        loc: SearchLocation::Issue { issue_id: i.id },
        hash: fnv(&[title.as_bytes(), i.body.as_bytes()]),
    };
    ix.upsert(kb, doc, semantic, || Some((title.clone(), i.body.clone())))?;
    Ok(())
}

/// Whether the file scan already covers this path (inside the root, not hidden).
fn under_root(root: Option<&Path>, path: &Path) -> bool {
    let Some(root) = root else { return false };
    match path.strip_prefix(root) {
        Ok(rel) => !rel.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.')),
        Err(_) => false,
    }
}

fn artifact_text(a: &Artifact) -> Option<String> {
    let path = Path::new(&a.path);
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > 20 * 1024 * 1024 {
        return None;
    }
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    match a.kind {
        ArtifactKind::Markdown | ArtifactKind::Code => std::fs::read_to_string(path).ok(),
        ArtifactKind::Html => std::fs::read_to_string(path).ok().map(|h| html_to_markdown(&h, None).1),
        ArtifactKind::Data | ArtifactKind::Pdf => {
            let bytes = std::fs::read(path).ok()?;
            match ext.as_str() {
                "json" => String::from_utf8(bytes).ok(),
                _ => convert(&a.path, &bytes).ok(),
            }
        }
        _ => None,
    }
}

fn index_artifact(r: &Runner, kb: &Kb, ix: &WsIndex, a: &Artifact, semantic: bool) -> Result<bool> {
    let root = r.workspace(a.workspace_id).and_then(|w| w.root).map(PathBuf::from);
    let path = Path::new(&a.path);
    let text_kind = matches!(a.kind, ArtifactKind::Markdown | ArtifactKind::Code | ArtifactKind::Html | ArtifactKind::Data | ArtifactKind::Pdf);
    if !text_kind || !path.exists() || under_root(root.as_deref(), path) {
        return Ok(false);
    }
    let meta = std::fs::metadata(path)?;
    let mtime = meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
    let doc = Doc {
        key: format!("artifact:{}", a.id),
        kind: "artifact".into(),
        id: a.id.to_string(),
        loc: SearchLocation::Artifact { artifact_id: a.id, path: a.path.clone() },
        hash: fnv(&[a.title.as_bytes(), a.path.as_bytes(), &meta.len().to_le_bytes(), &mtime.to_le_bytes()]),
    };
    ix.upsert(kb, doc, semantic, || artifact_text(a).map(|t| (a.title.clone(), t)))?;
    Ok(true)
}

const SKIP_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "tiff", "psd", "mp4", "webm", "mov", "mp3", "wav", "ogg", "m4a", "flac", "zip", "gz", "tgz",
    "bz2", "xz", "7z", "rar", "tar", "jar", "exe", "dll", "so", "dylib", "a", "o", "obj", "class", "wasm", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "odt", "ods", "woff", "woff2", "ttf", "otf", "eot", "bin", "dat", "db", "sqlite", "lock", "map", "pyc", "node",
];

fn is_text(bytes: &[u8]) -> bool {
    !bytes[..bytes.len().min(8000)].contains(&0) && std::str::from_utf8(bytes).is_ok()
}

/// Text files in the workspace folder, respecting `.gitignore`.
fn scan_files(kb: &Kb, ix: &WsIndex, root: &Path, semantic: bool) -> HashSet<String> {
    let mut seen = HashSet::new();
    let walker = ignore::WalkBuilder::new(root)
        .require_git(false)
        .filter_entry(|e| {
            let n = e.file_name();
            n != ".git" && n != "node_modules" && n != "target"
        })
        .build();
    for e in walker.flatten() {
        if seen.len() >= MAX_FILES {
            break;
        }
        if !e.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = e.path();
        let ext = path.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
        if SKIP_EXT.contains(&ext.as_str()) {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        if meta.len() > MAX_FILE || meta.len() == 0 {
            continue;
        }
        let Ok(rel) = path.strip_prefix(root) else { continue };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let key = format!("file:{rel}");
        let mtime = meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos() as u64).unwrap_or(0);
        let doc = Doc {
            key: key.clone(),
            kind: "file".into(),
            id: rel.clone(),
            loc: SearchLocation::File { path: rel.clone() },
            hash: fnv(&[&meta.len().to_le_bytes(), &mtime.to_le_bytes()]),
        };
        let res = ix.upsert(kb, doc, semantic, || {
            let bytes = std::fs::read(path).ok()?;
            if !is_text(&bytes) {
                return None;
            }
            Some((rel.clone(), String::from_utf8(bytes).ok()?))
        });
        if res.is_ok() && ix.manifest.lock().unwrap().contains_key(&key) {
            seen.insert(key);
        }
    }
    seen
}

/// Bring a workspace's whole index up to date.
fn full_reindex(r: &Runner, ws: Uuid) -> Result<KnowledgeIndexStatus> {
    let kb = kb_of(r);
    let ix = kb.open(ws)?;
    let semantic = r.hooks.embed().is_some();
    let workspace = r.workspace(ws).context("unknown workspace")?;

    let mut seen: HashSet<String> = HashSet::new();
    for t in r.threads(ws) {
        index_thread(r, &kb, &ix, &t, semantic)?;
        seen.insert(format!("thread:{}", t.id));
    }
    for i in r.list_issues(ws) {
        index_issue(&kb, &ix, &i, semantic)?;
        seen.insert(format!("issue:{}", i.id));
    }
    for a in r.list_artifacts(ws) {
        if index_artifact(r, &kb, &ix, &a, semantic)? {
            seen.insert(format!("artifact:{}", a.id));
        }
    }
    if let Some(root) = workspace.root.as_deref().map(PathBuf::from).filter(|p| p.is_dir()) {
        seen.extend(scan_files(&kb, &ix, &root, semantic));
    }
    for kind in ["thread", "issue", "artifact", "file"] {
        for key in ix.keys_of(kind) {
            if !seen.contains(&key) {
                ix.remove(&kb, &key);
            }
        }
    }
    *ix.last_scan.lock().unwrap() = Some(Utc::now());
    ix.flush()?;
    let s = status(r, ws);
    r.notice(ws, "knowledge-index", &s);
    Ok(s)
}

fn index_item(r: &Runner, it: Item) -> Result<()> {
    let kb = kb_of(r);
    let semantic = r.hooks.embed().is_some();
    match it {
        Item::Thread(id) => {
            let Some(t) = r.thread(id) else { return Ok(()) };
            if r.workspace(t.workspace_id).is_none_or(|w| w.role.is_some()) {
                return Ok(());
            }
            let ix = kb.open(t.workspace_id)?;
            index_thread(r, &kb, &ix, &t, semantic)?;
            kb.after_write(&ix);
        }
        Item::Issue(ws, id) => {
            let ix = kb.open(ws)?;
            match r.issues.find(|i| i.id == id) {
                Some(i) => index_issue(&kb, &ix, &i, semantic)?,
                None => ix.remove(&kb, &format!("issue:{id}")),
            }
            kb.after_write(&ix);
        }
        Item::IssueGone(ws, id) => {
            let ix = kb.open(ws)?;
            ix.remove(&kb, &format!("issue:{id}"));
            kb.after_write(&ix);
        }
        Item::Artifact(ws, id) => {
            let ix = kb.open(ws)?;
            if let Some(a) = r.artifacts.find(|a| a.id == id) {
                index_artifact(r, &kb, &ix, &a, semantic)?;
            }
            kb.after_write(&ix);
        }
    }
    Ok(())
}

fn status(r: &Runner, ws: Uuid) -> KnowledgeIndexStatus {
    let kb = kb_of(r);
    let Ok(ix) = kb.open(ws) else { return KnowledgeIndexStatus { workspace_id: ws, ..Default::default() } };
    let vectors = ix.vectors.lock().unwrap().entries.len() as u32;
    let last_scan = *ix.last_scan.lock().unwrap();
    KnowledgeIndexStatus {
        workspace_id: ws,
        docs: ix.num_docs() as u32,
        vectors,
        pending: kb.pending_for(ws) as u32,
        semantic: r.hooks.embed().is_some(),
        last_scan,
    }
}

async fn reindex_now(r: &Arc<Runner>, ws: Uuid) -> Result<KnowledgeIndexStatus> {
    if r.workspace(ws).is_none() {
        bail!("unknown workspace");
    }
    let r2 = r.clone();
    tokio::task::spawn_blocking(move || full_reindex(&r2, ws)).await?
}

async fn search(r: &Arc<Runner>, params: &Value) -> Result<Vec<SearchHit>> {
    let query: String = p(params, "query")?;
    let kinds: Vec<String> = opt(params, "kinds").unwrap_or_default();
    let limit = opt::<usize>(params, "limit").unwrap_or(30).clamp(1, 200);
    let wss = match opt::<Uuid>(params, "workspace_id") {
        Some(w) => vec![w],
        None => local_workspaces(r),
    };
    if tokenize(&query).is_empty() {
        return Ok(Vec::new());
    }
    let kb = kb_of(r);
    let has_vectors = wss.iter().any(|w| kb.open(*w).is_ok_and(|ix| !ix.vectors.lock().unwrap().entries.is_empty()));
    let qvec = if has_vectors && opt::<bool>(params, "semantic").unwrap_or(true) { query_vector(r, &query).await } else { None };
    tokio::task::spawn_blocking(move || {
        let mut all = Vec::new();
        for w in wss {
            let ix = kb.open(w)?;
            all.extend(ix.search(&query, &kinds, limit, qvec.as_deref())?);
        }
        all.sort_by(|a, b| b.score.total_cmp(&a.score));
        all.truncate(limit);
        Ok(all)
    })
    .await?
}

// ---- conversions to Markdown ----------------------------------------------------------------------------

/// Turn a file's bytes into Markdown, by its extension.
fn convert(name: &str, bytes: &[u8]) -> Result<String> {
    let ext = Path::new(name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "pdf" => pdf_to_markdown(bytes),
        "docx" => docx_to_markdown(bytes),
        "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" => sheets_to_markdown(bytes),
        "csv" => Ok(csv_to_markdown(&String::from_utf8_lossy(bytes), ',')),
        "tsv" => Ok(csv_to_markdown(&String::from_utf8_lossy(bytes), '\t')),
        "html" | "htm" => Ok(html_to_markdown(&String::from_utf8_lossy(bytes), None).1),
        _ if is_text(bytes) => Ok(String::from_utf8_lossy(bytes).into_owned()),
        _ => bail!("cannot import .{ext} files yet"),
    }
}

fn pdf_to_markdown(bytes: &[u8]) -> Result<String> {
    // pdf-extract panics on some malformed files; keep that inside.
    let owned = bytes.to_vec();
    let text = std::panic::catch_unwind(move || pdf_extract::extract_text_from_mem(&owned))
        .map_err(|_| anyhow!("could not read this PDF"))?
        .map_err(|e| anyhow!("could not read this PDF: {e}"))?;
    // Join wrapped lines into paragraphs; blank lines separate them.
    let mut out = String::new();
    for para in text.split("\n\n") {
        let p = para.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ");
        if !p.is_empty() {
            out.push_str(&p);
            out.push_str("\n\n");
        }
    }
    Ok(out.trim_end().to_string() + "\n")
}

fn md_cell(s: &str) -> String {
    s.replace('|', "\\|").replace(['\n', '\r'], " ").trim().to_string()
}

/// Rows to a Markdown table; the first row is the header.
fn md_table(rows: &[Vec<String>]) -> String {
    let width = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    if width == 0 {
        return String::new();
    }
    let mut out = String::new();
    for (i, row) in rows.iter().enumerate() {
        let cells: Vec<String> = (0..width).map(|j| md_cell(row.get(j).map(String::as_str).unwrap_or(""))).collect();
        out.push_str(&format!("| {} |\n", cells.join(" | ")));
        if i == 0 {
            out.push_str(&format!("|{}\n", " --- |".repeat(width)));
        }
    }
    out
}

fn sheets_to_markdown(bytes: &[u8]) -> Result<String> {
    use calamine::Reader;
    let mut wb = calamine::open_workbook_auto_from_rs(Cursor::new(bytes.to_vec())).map_err(|e| anyhow!("could not read this spreadsheet: {e}"))?;
    let names = wb.sheet_names();
    let mut out = String::new();
    for name in &names {
        let Ok(range) = wb.worksheet_range(name) else { continue };
        let rows: Vec<Vec<String>> = range
            .rows()
            .take(5000)
            .map(|r| r.iter().map(|c| c.to_string()).collect::<Vec<_>>())
            .filter(|r| r.iter().any(|c| !c.trim().is_empty()))
            .collect();
        if rows.is_empty() {
            continue;
        }
        if names.len() > 1 {
            out.push_str(&format!("## {name}\n\n"));
        }
        out.push_str(&md_table(&rows));
        out.push('\n');
    }
    Ok(out)
}

/// A small RFC 4180 reader: quoted fields, doubled quotes, newlines in quotes.
fn parse_csv(text: &str, sep: char) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.trim_start_matches('\u{feff}').chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
        } else if c == '"' && field.is_empty() {
            quoted = true;
        } else if c == sep {
            row.push(std::mem::take(&mut field));
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
        } else {
            field.push(c);
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows.retain(|r| r.iter().any(|c| !c.trim().is_empty()));
    rows
}

fn csv_to_markdown(text: &str, sep: char) -> String {
    let rows = parse_csv(text, sep);
    md_table(&rows[..rows.len().min(5000)])
}

/// Walk `word/document.xml`: headings, lists, tables and paragraphs.
fn docx_to_markdown(bytes: &[u8]) -> Result<String> {
    use quick_xml::events::Event;
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).context("not a .docx file")?;
    let mut xml = String::new();
    zip.by_name("word/document.xml").context("not a .docx file")?.read_to_string(&mut xml)?;

    let mut reader = quick_xml::Reader::from_str(&xml);
    let mut out: Vec<String> = Vec::new();
    let mut para = String::new();
    let mut style: Option<String> = None;
    let mut list_level: Option<usize> = None;
    let mut in_text = false;
    let mut table_depth = 0usize;
    let mut table: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell: Vec<String> = Vec::new();

    let attr = |e: &quick_xml::events::BytesStart, name: &str| -> Option<String> {
        e.attributes().with_checks(false).flatten().find(|a| a.key.as_ref() == name).map(|a| a.value.into_owned())
    };

    loop {
        let ev = reader.read_event().map_err(|e| anyhow!("broken .docx: {e}"))?;
        match ev {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let empty = matches!(ev, Event::Empty(_));
                match e.name().as_ref() {
                    "w:p" if !empty => {
                        para.clear();
                        style = None;
                        list_level = None;
                    }
                    "w:pStyle" => style = attr(e, "w:val"),
                    "w:numPr" => list_level = Some(list_level.unwrap_or(0)),
                    "w:ilvl" => list_level = attr(e, "w:val").and_then(|v| v.parse().ok()).or(Some(0)),
                    "w:t" if !empty => in_text = true,
                    "w:tab" => para.push('\t'),
                    "w:br" | "w:cr" => para.push(if table_depth > 0 { ' ' } else { '\n' }),
                    "w:tbl" if !empty => {
                        table_depth += 1;
                        if table_depth == 1 {
                            table.clear();
                        }
                    }
                    "w:tr" if !empty && table_depth == 1 => row.clear(),
                    "w:tc" if !empty && table_depth == 1 => cell.clear(),
                    _ => {}
                }
            }
            Event::Text(t) if in_text => para.push_str(&t.xml10_content()),
            Event::GeneralRef(r) if in_text => {
                if let Ok(Some(c)) = r.resolve_char_ref() {
                    para.push(c);
                } else {
                    para.push_str(match r.as_ref() {
                        "amp" => "&",
                        "lt" => "<",
                        "gt" => ">",
                        "quot" => "\"",
                        "apos" => "'",
                        _ => "",
                    });
                }
            }
            Event::End(ref e) => match e.name().as_ref() {
                "w:t" => in_text = false,
                "w:p" => {
                    let text = para.trim().to_string();
                    if table_depth > 0 {
                        if !text.is_empty() {
                            cell.push(text);
                        }
                    } else if !text.is_empty() {
                        let s = style.as_deref().unwrap_or("").to_ascii_lowercase().replace(' ', "");
                        let line = if s == "title" {
                            format!("# {text}")
                        } else if let Some(n) = s.strip_prefix("heading").and_then(|n| n.parse::<usize>().ok()) {
                            format!("{} {text}", "#".repeat((n + 1).clamp(2, 6)))
                        } else if let Some(l) = list_level.or(if s.contains("list") { Some(0) } else { None }) {
                            format!("{}- {text}", "  ".repeat(l))
                        } else {
                            text
                        };
                        out.push(line);
                    }
                }
                "w:tc" if table_depth == 1 => row.push(cell.join(" ")),
                "w:tr" if table_depth == 1 => table.push(std::mem::take(&mut row)),
                "w:tbl" => {
                    table_depth = table_depth.saturating_sub(1);
                    if table_depth == 0 {
                        out.push(md_table(&table).trim_end().to_string());
                        table.clear();
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    // Consecutive list items stay together; other blocks get a blank line.
    let mut md = String::new();
    for (i, line) in out.iter().enumerate() {
        if i > 0 {
            let both_list = line.trim_start().starts_with("- ") && out[i - 1].trim_start().starts_with("- ");
            md.push_str(if both_list { "\n" } else { "\n\n" });
        }
        md.push_str(line);
    }
    md.push('\n');
    Ok(md)
}

// ---- HTML to Markdown -----------------------------------------------------------------------------------

const DROP_TAGS: &[&str] = &[
    "script", "style", "noscript", "nav", "aside", "footer", "header", "form", "button", "svg", "iframe", "template", "select", "input", "textarea", "canvas", "dialog",
    "menu",
];

/// The main content of a page as Markdown, with its title.
fn html_to_markdown(html: &str, base: Option<&reqwest::Url>) -> (String, String) {
    use scraper::{ElementRef, Html, Selector};
    let doc = Html::parse_document(html);
    let sel = |s: &str| Selector::parse(s).expect("valid selector");
    let text_len = |e: ElementRef| e.text().map(|t| t.trim().len()).sum::<usize>();

    let title = doc
        .select(&sel("meta[property='og:title']"))
        .find_map(|m| m.value().attr("content").map(str::to_string))
        .or_else(|| doc.select(&sel("title")).next().map(|t| t.text().collect::<String>()))
        .or_else(|| doc.select(&sel("h1")).next().map(|t| t.text().collect::<String>()))
        .map(|t| collapse(&t))
        .unwrap_or_default();

    // Main content: the largest article, else main, else the block with the most paragraph text.
    let root = doc
        .select(&sel("article"))
        .max_by_key(|e| text_len(*e))
        .filter(|e| text_len(*e) > 200)
        .or_else(|| doc.select(&sel("main, [role=main]")).max_by_key(|e| text_len(*e)))
        .or_else(|| {
            doc.select(&sel("div, section, td"))
                .map(|e| {
                    let direct: usize = e.children().filter_map(ElementRef::wrap).filter(|c| c.value().name() == "p").map(text_len).sum();
                    (direct, e)
                })
                .filter(|(n, _)| *n > 0)
                .max_by_key(|(n, _)| *n)
                .map(|(_, e)| e)
        })
        .or_else(|| doc.select(&sel("body")).next())
        .unwrap_or_else(|| doc.root_element());

    let mut md = Md { base, out: String::new() };
    md.block(root);
    let mut body = tidy(&md.out);
    // Avoid repeating the title as the first heading.
    if !title.is_empty() {
        let first = body.lines().next().unwrap_or("").trim_start_matches('#').trim().to_string();
        if first == title {
            body = body.lines().skip(1).collect::<Vec<_>>().join("\n").trim_start().to_string();
        }
    }
    (title, body)
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Squeeze runs of blank lines and trailing spaces.
fn tidy(s: &str) -> String {
    let mut out = String::new();
    let mut blank = 0;
    for line in s.lines() {
        let l = line.trim_end();
        if l.trim().is_empty() {
            blank += 1;
            continue;
        }
        if !out.is_empty() {
            out.push_str(if blank > 0 { "\n\n" } else { "\n" });
        }
        blank = 0;
        out.push_str(l);
    }
    out.push('\n');
    out
}

struct Md<'a> {
    base: Option<&'a reqwest::Url>,
    out: String,
}

impl Md<'_> {
    fn url(&self, href: &str) -> String {
        match self.base.and_then(|b| b.join(href).ok()) {
            Some(u) => u.to_string(),
            None => href.to_string(),
        }
    }

    fn para(&mut self, s: &str) {
        let s = s.trim();
        if !s.is_empty() {
            self.out.push_str("\n\n");
            self.out.push_str(s);
            self.out.push_str("\n\n");
        }
    }

    fn block(&mut self, el: scraper::ElementRef) {
        use scraper::{ElementRef, Node};
        let mut inline = String::new();
        for child in el.children() {
            if let Some(c) = ElementRef::wrap(child) {
                let name = c.value().name();
                if DROP_TAGS.contains(&name) || c.value().attr("hidden").is_some() || c.value().attr("aria-hidden") == Some("true") {
                    continue;
                }
                if is_block(name) {
                    let pending = std::mem::take(&mut inline);
                    self.para(&pending);
                    self.block_el(c);
                } else {
                    inline.push_str(&self.inline(c));
                }
            } else if let Node::Text(t) = child.value() {
                inline.push_str(&squash(t));
            }
        }
        self.para(&inline);
    }

    fn block_el(&mut self, c: scraper::ElementRef) {
        let name = c.value().name();
        match name {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let level: usize = name[1..].parse().unwrap_or(2);
                let t = self.inline_children(c);
                if !t.trim().is_empty() {
                    self.para(&format!("{} {}", "#".repeat(level), t.trim()));
                }
            }
            "p" => {
                let t = self.inline_children(c);
                self.para(&t);
            }
            "pre" => {
                let code: String = c.text().collect();
                self.para(&format!("```\n{}\n```", code.trim_end()));
            }
            "blockquote" => {
                let mut inner = Md { base: self.base, out: String::new() };
                inner.block(c);
                let q = tidy(&inner.out).lines().map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n");
                self.para(&q);
            }
            "ul" | "ol" => {
                let list = self.list(c, 0);
                self.para(&list);
            }
            "table" => {
                let rows = self.table_rows(c);
                self.para(&md_table(&rows));
            }
            "hr" => self.para("---"),
            "br" => self.out.push('\n'),
            "figure" | "picture" => {
                let mut inner = Md { base: self.base, out: String::new() };
                inner.block(c);
                let s = inner.out;
                self.para(&s);
            }
            _ => self.block(c),
        }
    }

    fn list(&self, el: scraper::ElementRef, depth: usize) -> String {
        use scraper::ElementRef;
        let ordered = el.value().name() == "ol";
        let mut out = Vec::new();
        for (i, li) in el.children().filter_map(ElementRef::wrap).filter(|c| c.value().name() == "li").enumerate() {
            let mut text = String::new();
            let mut nested = Vec::new();
            for ch in li.children() {
                if let Some(ce) = ElementRef::wrap(ch) {
                    match ce.value().name() {
                        "ul" | "ol" => nested.push(self.list(ce, depth + 1)),
                        n if DROP_TAGS.contains(&n) => {}
                        _ => text.push_str(&self.inline(ce)),
                    }
                } else if let scraper::Node::Text(t) = ch.value() {
                    text.push_str(&squash(t));
                }
            }
            let marker = if ordered { format!("{}.", i + 1) } else { "-".into() };
            out.push(format!("{}{marker} {}", "  ".repeat(depth), collapse(&text)));
            out.extend(nested);
        }
        out.join("\n")
    }

    fn table_rows(&self, table: scraper::ElementRef) -> Vec<Vec<String>> {
        let tr = scraper::Selector::parse("tr").expect("valid selector");
        let cells = scraper::Selector::parse("th, td").expect("valid selector");
        table.select(&tr).map(|r| r.select(&cells).map(|c| collapse(&self.inline_children(c))).collect()).filter(|r: &Vec<String>| !r.is_empty()).collect()
    }

    fn inline_children(&self, el: scraper::ElementRef) -> String {
        use scraper::{ElementRef, Node};
        let mut s = String::new();
        for child in el.children() {
            if let Some(c) = ElementRef::wrap(child) {
                if !DROP_TAGS.contains(&c.value().name()) {
                    s.push_str(&self.inline(c));
                }
            } else if let Node::Text(t) = child.value() {
                s.push_str(&squash(t));
            }
        }
        collapse_keep_edges(&s)
    }

    fn inline(&self, c: scraper::ElementRef) -> String {
        let name = c.value().name();
        let inner = || self.inline_children(c);
        let wrap = |m: &str| {
            let t = inner();
            if t.trim().is_empty() {
                t
            } else {
                format!("{m}{}{m}", t.trim())
            }
        };
        match name {
            "a" => {
                let t = inner();
                match c.value().attr("href").filter(|h| !h.starts_with("javascript:") && !h.starts_with('#')) {
                    Some(h) if !t.trim().is_empty() => format!("[{}]({})", t.trim(), self.url(h)),
                    _ => t,
                }
            }
            "strong" | "b" => wrap("**"),
            "em" | "i" => wrap("*"),
            "code" | "kbd" => format!("`{}`", c.text().collect::<String>()),
            "br" => "\n".into(),
            "img" => match c.value().attr("src") {
                Some(src) if !src.starts_with("data:") => format!("![{}]({})", c.value().attr("alt").unwrap_or(""), self.url(src)),
                _ => String::new(),
            },
            n if DROP_TAGS.contains(&n) => String::new(),
            // Block elements inside inline context (a div in a link) flatten to text.
            _ => inner(),
        }
    }
}

fn is_block(name: &str) -> bool {
    matches!(
        name,
        "p" | "div" | "section" | "article" | "main" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "ul" | "ol" | "pre" | "blockquote" | "table" | "hr" | "figure" | "picture"
            | "figcaption" | "dl" | "dt" | "dd" | "details" | "summary" | "center" | "address"
    )
}

/// Whitespace in HTML text collapses to single spaces.
fn squash(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !space {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(c);
            space = false;
        }
    }
    out
}

fn collapse_keep_edges(s: &str) -> String {
    let lead = s.starts_with(char::is_whitespace);
    let trail = s.ends_with(char::is_whitespace);
    let mid = s.split(' ').filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" ");
    if mid.is_empty() {
        return if lead || trail { " ".into() } else { String::new() };
    }
    format!("{}{mid}{}", if lead { " " } else { "" }, if trail { " " } else { "" })
}

// ---- imports and clips --------------------------------------------------------------------------------

enum Source {
    File(String),
    Upload(String),
    Url(String),
}

fn imports_dir(r: &Runner, ws: Uuid) -> PathBuf {
    match r.workspace(ws).and_then(|w| w.root).map(PathBuf::from).filter(|p| p.is_dir()) {
        Some(root) => root.join(".bouvio").join("imports"),
        None => kb_of(r).dir.join(ws.to_string()).join("imports"),
    }
}

/// A safe file stem: letters, digits, dashes; never empty.
fn slug(name: &str) -> String {
    let mut s = String::new();
    for c in name.chars() {
        if c.is_alphanumeric() {
            s.extend(c.to_lowercase());
        } else if !s.ends_with('-') && !s.is_empty() {
            s.push('-');
        }
        if s.chars().count() >= 60 {
            break;
        }
    }
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "import".into()
    } else {
        s
    }
}

fn yaml_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', " "))
}

async fn import(r: &Arc<Runner>, ws: Uuid, name: &str, bytes: Vec<u8>, source: Source) -> Result<Artifact> {
    if r.workspace(ws).is_none() {
        bail!("unknown workspace");
    }
    if bytes.len() > 100 * 1024 * 1024 {
        bail!("file is larger than 100 MB");
    }
    let n = name.to_string();
    let md = tokio::task::spawn_blocking(move || convert(&n, &bytes)).await??;
    let stem = Path::new(name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| name.to_string());
    save_markdown(r, ws, &stem, name, &md, source).await
}

async fn save_markdown(r: &Arc<Runner>, ws: Uuid, stem: &str, title: &str, md: &str, source: Source) -> Result<Artifact> {
    let dir = imports_dir(r, ws);
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join(format!("{}.md", slug(stem)));
    let (key, src) = match &source {
        Source::File(p) => ("source", p.as_str()),
        Source::Upload(n) => ("source", n.as_str()),
        Source::Url(u) => ("url", u.as_str()),
    };
    let when = if matches!(source, Source::Url(_)) { "clipped" } else { "imported" };
    let front = format!("---\ntitle: {}\n{key}: {}\n{when}: {}\n---\n\n", yaml_str(title), yaml_str(src), Utc::now().to_rfc3339());
    let body = if md.trim_start().starts_with("# ") { md.to_string() } else { format!("# {title}\n\n{md}") };
    tokio::fs::write(&path, format!("{front}{body}")).await?;

    let p = path.to_string_lossy().into_owned();
    let a = match r.artifacts.find(|a| a.path == p) {
        Some(existing) => {
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let a = r
                .artifacts
                .update(|x| x.id == existing.id, |x| {
                    x.size = size;
                    x.title = title.to_string();
                    x.created_at = Utc::now();
                })?
                .unwrap_or(existing);
            r.notice(ws, "artifact-changed", &a);
            a
        }
        None => {
            let a = r.add_artifact(ws, None, &path, None, None)?;
            r.artifacts.update(|x| x.id == a.id, |x| x.title = title.to_string())?.unwrap_or(a)
        }
    };
    // Index it now: whoever imported it will search for it next.
    let r2 = r.clone();
    let a2 = a.clone();
    let _ = tokio::task::spawn_blocking(move || {
        let kb = kb_of(&r2);
        if let Ok(ix) = kb.open(ws) {
            let semantic = r2.hooks.embed().is_some();
            let doc = Doc {
                key: format!("artifact:{}", a2.id),
                kind: "artifact".into(),
                id: a2.id.to_string(),
                loc: SearchLocation::Artifact { artifact_id: a2.id, path: a2.path.clone() },
                hash: 0,
            };
            // Hash 0 forces the write; the scan replaces it with the file's own hash later.
            ix.manifest.lock().unwrap().remove(&doc.key);
            let _ = ix.upsert(&kb, doc, semantic, || artifact_text(&a2).map(|t| (a2.title.clone(), t)));
            let _ = ix.flush();
        }
    })
    .await;
    Ok(a)
}

fn http() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (compatible; Bouvio)")
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default()
    })
}

async fn clip_url(r: &Arc<Runner>, ws: Uuid, url: &str) -> Result<Artifact> {
    let url = reqwest::Url::parse(url.trim()).or_else(|_| reqwest::Url::parse(&format!("https://{}", url.trim()))).context("not a web address")?;
    if !matches!(url.scheme(), "http" | "https") {
        bail!("only http and https pages can be clipped");
    }
    let res = http().get(url.clone()).send().await?.error_for_status()?;
    let final_url = res.url().clone();
    let ctype = res.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    if res.content_length().is_some_and(|n| n > 30 * 1024 * 1024) {
        bail!("page is larger than 30 MB");
    }
    let bytes = res.bytes().await?;
    let name = final_url.path_segments().and_then(|mut s| s.next_back()).filter(|s| !s.is_empty()).unwrap_or("page").to_string();
    if ctype.contains("pdf") || name.to_ascii_lowercase().ends_with(".pdf") {
        let b = bytes.to_vec();
        let md = tokio::task::spawn_blocking(move || pdf_to_markdown(&b)).await??;
        let stem = Path::new(&name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or(name.clone());
        return save_markdown(r, ws, &stem, &name, &md, Source::Url(final_url.to_string())).await;
    }
    let html = String::from_utf8_lossy(&bytes).into_owned();
    let base = final_url.clone();
    let (title, md) = tokio::task::spawn_blocking(move || html_to_markdown(&html, Some(&base))).await?;
    if md.trim().is_empty() {
        bail!("found no readable text on that page");
    }
    let title = if title.is_empty() { final_url.host_str().unwrap_or("page").to_string() } else { title };
    save_markdown(r, ws, &title, &title, &md, Source::Url(final_url.to_string())).await
}

// ---- MCP registry ----------------------------------------------------------------------------------------

async fn search_mcp_registry(query: &str) -> Result<Vec<McpCatalogEntry>> {
    let mut req = http().get(MCP_REGISTRY).query(&[("limit", "40"), ("version", "latest")]);
    if !query.trim().is_empty() {
        req = req.query(&[("search", query.trim())]);
    }
    let v: Value = req.send().await.context("MCP registry unreachable")?.error_for_status()?.json().await?;
    Ok(map_registry(&v))
}

fn map_registry(v: &Value) -> Vec<McpCatalogEntry> {
    let mut seen = HashSet::new();
    v.get("servers")
        .and_then(|s| s.as_array())
        .into_iter()
        .flatten()
        .filter_map(|e| map_registry_entry(e.get("server").unwrap_or(e)))
        .filter(|e| seen.insert(e.name.clone()))
        .collect()
}

fn args_of(v: Option<&Value>) -> Vec<String> {
    let mut out = Vec::new();
    for a in v.and_then(|a| a.as_array()).into_iter().flatten() {
        let value = a.get("value").or_else(|| a.get("default")).and_then(|x| x.as_str());
        match a.get("type").and_then(|t| t.as_str()) {
            Some("named") => {
                if let (Some(n), Some(val)) = (a.get("name").and_then(|x| x.as_str()), value) {
                    out.push(n.to_string());
                    out.push(val.to_string());
                }
            }
            _ => {
                if let Some(val) = value {
                    out.push(val.to_string());
                }
            }
        }
    }
    out
}

fn map_registry_entry(s: &Value) -> Option<McpCatalogEntry> {
    let name = s.get("name")?.as_str()?.to_string();
    let short_name = name.rsplit('/').next().unwrap_or(&name).trim_start_matches("mcp-server-").to_string();
    let mut e = McpCatalogEntry {
        short_name,
        description: s.get("description").and_then(|d| d.as_str()).unwrap_or("").to_string(),
        version: s.get("version").and_then(|d| d.as_str()).map(str::to_string),
        repository: s.get("repository").and_then(|r| r.get("url")).and_then(|u| u.as_str()).filter(|u| !u.is_empty()).map(str::to_string),
        name,
        runtime: None,
        command: None,
        args: Vec::new(),
        env: Vec::new(),
    };
    let packages = s.get("packages").and_then(|p| p.as_array()).cloned().unwrap_or_default();
    let stdio = |p: &&Value| p.get("transport").and_then(|t| t.get("type")).and_then(|t| t.as_str()).is_none_or(|t| t == "stdio");
    let pkg = packages
        .iter()
        .filter(stdio)
        .find(|p| matches!(p.get("registryType").and_then(|t| t.as_str()), Some("npm" | "pypi" | "oci")));
    if let Some(pkg) = pkg {
        let id = pkg.get("identifier").and_then(|i| i.as_str()).unwrap_or("");
        let version = pkg.get("version").and_then(|i| i.as_str());
        e.env = pkg
            .get("environmentVariables")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .filter_map(|v| {
                Some(McpEnvVar {
                    name: v.get("name")?.as_str()?.to_string(),
                    description: v.get("description").and_then(|d| d.as_str()).map(str::to_string),
                    required: v.get("isRequired").and_then(|d| d.as_bool()).unwrap_or(false),
                    secret: v.get("isSecret").and_then(|d| d.as_bool()).unwrap_or(false),
                    default: v.get("default").and_then(|d| d.as_str()).map(str::to_string),
                })
            })
            .collect();
        let runtime_args = args_of(pkg.get("runtimeArguments"));
        let package_args = args_of(pkg.get("packageArguments"));
        match pkg.get("registryType").and_then(|t| t.as_str()) {
            Some("npm") => {
                e.runtime = Some("npx".into());
                e.command = Some("npx".into());
                e.args = if runtime_args.is_empty() { vec!["-y".into()] } else { runtime_args };
                e.args.push(match version {
                    Some(v) => format!("{id}@{v}"),
                    None => id.to_string(),
                });
            }
            Some("pypi") => {
                e.runtime = Some("uvx".into());
                e.command = Some("uvx".into());
                e.args = runtime_args;
                e.args.push(id.to_string());
            }
            Some("oci") => {
                e.runtime = Some("docker".into());
                e.command = Some("docker".into());
                e.args = vec!["run".into(), "-i".into(), "--rm".into()];
                for v in &e.env {
                    e.args.push("-e".into());
                    e.args.push(v.name.clone());
                }
                e.args.extend(runtime_args);
                e.args.push(id.to_string());
            }
            _ => {}
        }
        e.args.extend(package_args);
    } else if let Some(url) = s
        .get("remotes")
        .and_then(|r| r.as_array())
        .into_iter()
        .flatten()
        .filter(|r| !r.get("headers").and_then(|h| h.as_array()).is_some_and(|h| h.iter().any(|x| x.get("isRequired").and_then(|b| b.as_bool()).unwrap_or(false))))
        .find_map(|r| r.get("url").and_then(|u| u.as_str()))
    {
        // A hosted server without required headers: bridge it over stdio.
        e.runtime = Some("remote".into());
        e.command = Some("npx".into());
        e.args = vec!["-y".into(), "mcp-remote".into(), url.to_string()];
    }
    Some(e)
}

fn install_mcp(r: &Runner, ws: Uuid, server: McpServer) -> Result<bouvio_protocol::WorkspaceSettings> {
    if server.name.trim().is_empty() || server.command.trim().is_empty() {
        bail!("a server needs a name and a command");
    }
    if server.name == "bouvio" {
        bail!("`bouvio` is reserved for the fleet tools");
    }
    let mut s = r.settings(ws);
    match s.mcp_servers.iter_mut().find(|m| m.name == server.name) {
        Some(m) => *m = server,
        None => s.mcp_servers.push(server),
    }
    r.set_settings(ws, &s)?;
    Ok(s)
}

fn remove_mcp(r: &Runner, ws: Uuid, name: &str) -> Result<bouvio_protocol::WorkspaceSettings> {
    let mut s = r.settings(ws);
    s.mcp_servers.retain(|m| m.name != name);
    r.set_settings(ws, &s)?;
    Ok(s)
}

// ---- skills ----------------------------------------------------------------------------------------------

/// `name` and `description` from a SKILL.md front matter.
fn front_matter(md: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let md = md.trim_start_matches('\u{feff}');
    let Some(rest) = md.strip_prefix("---") else { return out };
    let Some(end) = rest.find("\n---") else { return out };
    let mut current: Option<String> = None;
    for line in rest[..end].lines() {
        if line.starts_with([' ', '\t']) {
            if let Some(k) = &current {
                let v = out.entry(k.clone()).or_insert_with(String::new);
                if !v.is_empty() {
                    v.push(' ');
                }
                v.push_str(line.trim());
            }
            continue;
        }
        let Some((k, v)) = line.split_once(':') else { continue };
        let k = k.trim().to_string();
        let mut v = v.trim();
        if matches!(v, ">" | "|" | ">-" | "|-") {
            v = "";
        }
        let v = v.strip_prefix('"').and_then(|x| x.strip_suffix('"')).or_else(|| v.strip_prefix('\'').and_then(|x| x.strip_suffix('\''))).unwrap_or(v);
        out.insert(k.clone(), v.to_string());
        current = Some(k);
    }
    out
}

/// `owner/repo`, `github.com/owner/repo/tree/<ref>/<path>` or `owner/repo/<path>`.
fn parse_source(s: &str) -> Option<(String, String, String)> {
    let s = s.trim().trim_end_matches('/');
    let s = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://")).unwrap_or(s);
    let s = s.strip_prefix("www.").unwrap_or(s);
    let s = s.strip_prefix("github.com/").unwrap_or(s);
    let parts: Vec<&str> = s.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 || parts[..2].iter().any(|p| !p.chars().all(|c| c.is_alphanumeric() || "-_.".contains(c))) {
        return None;
    }
    let repo = format!("{}/{}", parts[0], parts[1].trim_end_matches(".git"));
    let (git_ref, path) = match parts.get(2) {
        Some(&"tree") | Some(&"blob") => (parts.get(3).map(|s| s.to_string()).unwrap_or_else(|| "HEAD".into()), parts.get(4..).map(|p| p.join("/")).unwrap_or_default()),
        _ => ("HEAD".into(), parts[2..].join("/")),
    };
    Some((repo, git_ref, path))
}

fn skill_sources(r: &Runner) -> Vec<String> {
    store::load(&kb_of(r).dir.join("skill-sources.json")).unwrap_or_default()
}

fn set_skill_sources(r: &Runner, sources: Vec<String>) -> Result<Vec<String>> {
    let clean: Vec<String> = sources.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if let Some(bad) = clean.iter().find(|s| parse_source(s).is_none()) {
        bail!("not a GitHub repository: {bad}");
    }
    store::save(&kb_of(r).dir.join("skill-sources.json"), &clean)?;
    *kb_of(r).catalog.lock().unwrap() = None;
    Ok(clean)
}

async fn github_json(url: &str) -> Result<Value> {
    let res = http().get(url).header("Accept", "application/vnd.github+json").send().await.context("GitHub unreachable")?;
    if res.status() == reqwest::StatusCode::FORBIDDEN || res.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        bail!("GitHub's rate limit for anonymous requests is reached; try again within the hour");
    }
    Ok(res.error_for_status()?.json().await?)
}

/// Every file path in a repo at a ref, cached for an hour.
async fn repo_files(kb: &Kb, repo: &str, git_ref: &str) -> Result<Vec<String>> {
    let id = format!("{repo}@{git_ref}");
    if let Some((at, files)) = kb.trees.lock().unwrap().get(&id) {
        if at.elapsed() < CATALOG_TTL {
            return Ok(files.clone());
        }
    }
    let v = github_json(&format!("https://api.github.com/repos/{repo}/git/trees/{git_ref}?recursive=1")).await?;
    let files: Vec<String> = v
        .get("tree")
        .and_then(|t| t.as_array())
        .into_iter()
        .flatten()
        .filter(|e| e.get("type").and_then(|t| t.as_str()) == Some("blob"))
        .filter_map(|e| e.get("path").and_then(|p| p.as_str()).map(str::to_string))
        .collect();
    kb.trees.lock().unwrap().insert(id, (Instant::now(), files.clone()));
    Ok(files)
}

fn raw_url(repo: &str, git_ref: &str, path: &str) -> String {
    let enc: Vec<String> = path.split('/').map(|s| s.replace('%', "%25").replace(' ', "%20").replace('#', "%23").replace('?', "%3F")).collect();
    format!("https://raw.githubusercontent.com/{repo}/{git_ref}/{}", enc.join("/"))
}

/// Folders holding a SKILL.md, under `prefix`.
fn skill_dirs(files: &[String], prefix: &str) -> Vec<String> {
    let prefix = prefix.trim_matches('/');
    let mut dirs: Vec<String> = files
        .iter()
        .filter_map(|f| f.strip_suffix("/SKILL.md"))
        .filter(|d| prefix.is_empty() || *d == prefix || d.starts_with(&format!("{prefix}/")))
        .map(str::to_string)
        .collect();
    if files.iter().any(|f| f == "SKILL.md") && prefix.is_empty() {
        dirs.push(String::new());
    }
    if !prefix.is_empty() && files.iter().any(|f| *f == format!("{prefix}/SKILL.md")) && !dirs.contains(&prefix.to_string()) {
        dirs.push(prefix.to_string());
    }
    dirs.sort();
    dirs
}

async fn catalog_of(kb: &Kb, repo: &str, git_ref: &str, prefix: &str) -> Result<Vec<SkillEntry>> {
    use futures::StreamExt;
    let files = repo_files(kb, repo, git_ref).await?;
    let dirs = skill_dirs(&files, prefix);
    let entries = futures::stream::iter(dirs.into_iter().take(200).map(|dir| async move {
        let file = if dir.is_empty() { "SKILL.md".to_string() } else { format!("{dir}/SKILL.md") };
        let md = match http().get(raw_url(repo, git_ref, &file)).send().await {
            Ok(r) => r.text().await.unwrap_or_default(),
            Err(_) => String::new(),
        };
        let fm = front_matter(&md);
        let folder = dir.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or_else(|| repo.rsplit('/').next().unwrap_or(repo)).to_string();
        SkillEntry {
            name: fm.get("name").filter(|n| !n.is_empty()).cloned().unwrap_or(folder),
            description: fm.get("description").cloned().unwrap_or_default(),
            url: format!("https://github.com/{repo}/tree/{git_ref}/{dir}"),
            source: SkillSource { repo: repo.to_string(), path: dir, git_ref: git_ref.to_string() },
        }
    }))
    .buffer_unordered(8)
    .collect::<Vec<_>>()
    .await;
    Ok(entries)
}

async fn list_skills_catalog(r: &Arc<Runner>, refresh: bool) -> Result<Vec<SkillEntry>> {
    let kb = kb_of(r);
    let cache_file = kb.dir.join("skills-catalog.json");
    if !refresh {
        if let Some((at, list)) = kb.catalog.lock().unwrap().as_ref() {
            if at.elapsed() < CATALOG_TTL {
                return Ok(list.clone());
            }
        }
        // A cache on disk survives restarts, so the GitHub limit is rarely hit.
        let disk: Option<(DateTime<Utc>, Vec<SkillEntry>)> = std::fs::read(&cache_file).ok().and_then(|b| serde_json::from_slice(&b).ok());
        if let Some((at, list)) = disk {
            let age = (Utc::now() - at).to_std().unwrap_or(CATALOG_TTL);
            if age < CATALOG_TTL {
                *kb.catalog.lock().unwrap() = Some((Instant::now() - age, list.clone()));
                return Ok(list);
            }
        }
    }
    let mut sources = vec![(SKILLS_REPO.to_string(), "HEAD".to_string(), String::new())];
    sources.extend(skill_sources(r).iter().filter_map(|s| parse_source(s)));
    let mut all = Vec::new();
    let mut errors = Vec::new();
    for (repo, git_ref, prefix) in sources {
        match catalog_of(&kb, &repo, &git_ref, &prefix).await {
            Ok(list) => all.extend(list),
            Err(e) => errors.push(format!("{repo}: {e:#}")),
        }
    }
    if all.is_empty() && !errors.is_empty() {
        bail!("{}", errors.join("; "));
    }
    all.sort_by(|a, b| a.source.repo.cmp(&b.source.repo).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    *kb.catalog.lock().unwrap() = Some((Instant::now(), all.clone()));
    let _ = store::save(&cache_file, &(Utc::now(), &all));
    Ok(all)
}

fn skills_dir(r: &Runner, ws: Uuid) -> Result<PathBuf> {
    let root = r.workspace(ws).context("unknown workspace")?.root.context("skills install into a workspace folder; this workspace has none")?;
    Ok(PathBuf::from(root).join(".claude").join("skills"))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && name.chars().all(|c| c.is_alphanumeric() || "-_.".contains(c))
}

fn safe_rel(rel: &str) -> bool {
    let p = Path::new(rel);
    !rel.is_empty() && p.components().all(|c| matches!(c, Component::Normal(_)))
}

async fn install_skill(r: &Arc<Runner>, ws: Uuid, src: &SkillSource) -> Result<InstalledSkill> {
    if parse_source(&src.repo).is_none_or(|(repo, _, _)| repo != src.repo) || !src.git_ref.chars().all(|c| c.is_alphanumeric() || "-_./".contains(c)) {
        bail!("not a GitHub repository: {}", src.repo);
    }
    let base = skills_dir(r, ws)?;
    let kb = kb_of(r);
    let files = repo_files(&kb, &src.repo, &src.git_ref).await?;
    let prefix = src.path.trim_matches('/');
    let wanted: Vec<(String, String)> = files
        .iter()
        .filter_map(|f| {
            let rel = if prefix.is_empty() { Some(f.as_str()) } else { f.strip_prefix(&format!("{prefix}/")) }?;
            safe_rel(rel).then(|| (f.clone(), rel.to_string()))
        })
        .take(300)
        .collect();
    if !wanted.iter().any(|(_, rel)| rel == "SKILL.md") {
        bail!("no SKILL.md in {}/{}", src.repo, prefix);
    }
    let folder = prefix.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or_else(|| src.repo.rsplit('/').next().unwrap_or("skill"));
    let name = slug(folder);
    if !valid_name(&name) {
        bail!("cannot install a skill named {folder}");
    }
    // Download everything first so a failure leaves the old copy alone.
    let mut downloaded = Vec::new();
    for (path, rel) in wanted {
        let res = http().get(raw_url(&src.repo, &src.git_ref, &path)).send().await?.error_for_status()?;
        if res.content_length().is_some_and(|n| n > 5 * 1024 * 1024) {
            continue;
        }
        downloaded.push((rel, res.bytes().await?));
    }
    let dir = base.join(&name);
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir).await?;
    }
    for (rel, bytes) in downloaded {
        let p = dir.join(&rel);
        if let Some(d) = p.parent() {
            tokio::fs::create_dir_all(d).await?;
        }
        tokio::fs::write(&p, &bytes).await?;
    }
    let installed = read_installed(&dir).context("installed skill has no SKILL.md")?;
    r.notice(ws, "knowledge-skills", json!({ "installed": installed.name }));
    Ok(installed)
}

fn read_installed(dir: &Path) -> Option<InstalledSkill> {
    let md = std::fs::read_to_string(dir.join("SKILL.md")).ok()?;
    let fm = front_matter(&md);
    let folder = dir.file_name()?.to_string_lossy().into_owned();
    Some(InstalledSkill {
        name: fm.get("name").filter(|n| !n.is_empty()).cloned().unwrap_or_else(|| folder.clone()),
        description: fm.get("description").cloned().unwrap_or_default(),
        path: dir.to_string_lossy().into_owned(),
    })
}

fn list_installed_skills(r: &Runner, ws: Uuid) -> Vec<InstalledSkill> {
    let Ok(base) = skills_dir(r, ws) else { return Vec::new() };
    let mut out: Vec<InstalledSkill> = std::fs::read_dir(base).into_iter().flatten().flatten().filter(|e| e.path().is_dir()).filter_map(|e| read_installed(&e.path())).collect();
    out.sort_by_key(|s| s.name.to_lowercase());
    out
}

fn remove_skill(r: &Runner, ws: Uuid, name: &str) -> Result<()> {
    let base = skills_dir(r, ws)?;
    // `name` may be the folder or the SKILL.md name.
    let dir = std::fs::read_dir(&base)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .find(|p| p.file_name().is_some_and(|f| f == name) || read_installed(p).is_some_and(|s| s.name == name))
        .context("no such skill")?;
    if !dir.starts_with(&base) || !valid_name(&dir.file_name().unwrap_or_default().to_string_lossy()) {
        bail!("no such skill");
    }
    std::fs::remove_dir_all(&dir)?;
    r.notice(ws, "knowledge-skills", json!({ "removed": name }));
    Ok(())
}

// ---- tests ------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_of(files: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            for (name, body) in files {
                z.start_file(*name, opts).unwrap();
                z.write_all(str::as_bytes(body)).unwrap();
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn index_search_and_unindex() {
        let dir = tempfile::tempdir().unwrap();
        let r = Runner::open(dir.path()).unwrap();
        let ws = r.create_workspace("Bouvio".into(), None).unwrap();
        index(&r, ws.id, "doc", "d1", "Launch plan", "We ship the sign-up form on Friday after the review.");
        index(&r, ws.id, "note", "n1", "Groceries", "Milk, bread and coffee beans.");
        index(&r, ws.id, "doc", "d2", "Retro", "The signup flow broke twice; add tests for the form.");
        let ix = kb_of(&r).open(ws.id).unwrap();
        assert_eq!(ix.num_docs(), 3);

        let hits = ix.search("sign-up form", &[], 10, None).unwrap();
        assert_eq!(hits[0].id, "d1");
        assert_eq!(hits[0].location, SearchLocation::Doc { kind: "doc".into(), id: "d1".into() });
        let s = &hits[0].snippet;
        let marked: Vec<String> = s.highlights.iter().map(|(a, b)| s.text.chars().skip(*a as usize).take((*b - *a) as usize).collect()).collect();
        assert!(marked.contains(&"sign".to_string()) && marked.contains(&"form".to_string()), "{marked:?}");

        // The last word is a prefix while typing.
        let hits = ix.search("coff", &[], 10, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "n1");

        // Kinds filter, and a fallback to any word when not all match.
        assert!(ix.search("form", &["note".into()], 10, None).unwrap().is_empty());
        let any = ix.search("bread review", &[], 10, None).unwrap();
        assert_eq!(any.len(), 2);

        // Re-indexing the same content is a no-op; changing it replaces it.
        index(&r, ws.id, "doc", "d1", "Launch plan", "We ship the sign-up form on Friday after the review.");
        assert_eq!(ix.num_docs(), 3);
        index(&r, ws.id, "doc", "d1", "Launch plan", "Moved to Monday.");
        assert_eq!(ix.num_docs(), 3);
        assert!(ix.search("friday", &[], 10, None).unwrap().is_empty());

        unindex(&r, ws.id, "note", "n1");
        assert!(ix.search("coffee", &[], 10, None).unwrap().is_empty());
        assert_eq!(ix.num_docs(), 2);
    }

    #[tokio::test]
    async fn full_reindex_covers_issues_files_and_threads() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("build")).unwrap();
        std::fs::write(root.join(".gitignore"), "build/\n").unwrap();
        std::fs::write(root.join("src/billing.rs"), "fn invoice_total() { /* quarterly invoices */ }").unwrap();
        std::fs::write(root.join("build/out.txt"), "quarterly invoices generated").unwrap();
        std::fs::write(root.join("logo.bin"), [0u8, 1, 2, 3]).unwrap();

        let r = Runner::open(dir.path().join("data")).unwrap();
        let ws = r.create_workspace("Repo".into(), Some(root.to_string_lossy().into())).unwrap();
        r.create_issue(ws.id, "Quarterly invoices are off by one".into(), "Totals skip the last day.".into(), None, None).unwrap();
        let s = full_reindex(&r, ws.id).unwrap();
        assert_eq!(s.docs, 2, "issue + one file; build/ is ignored, binaries skipped");

        let hits = search(&r, &json!({ "workspace_id": ws.id, "query": "quarterly invoices" })).await.unwrap();
        let kinds: HashSet<_> = hits.iter().map(|h| h.kind.as_str()).collect();
        assert_eq!(kinds, HashSet::from(["issue", "file"]));
        assert!(hits.iter().any(|h| h.location == SearchLocation::File { path: "src/billing.rs".into() }));

        // Removed files leave the index on the next scan.
        std::fs::remove_file(root.join("src/billing.rs")).unwrap();
        let s = full_reindex(&r, ws.id).unwrap();
        assert_eq!(s.docs, 1);

        // Searching every workspace finds the issue too.
        let hits = search(&r, &json!({ "query": "invoices", "kinds": ["issue"] })).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].workspace_id, ws.id);
    }

    /// `cargo test --release -p bouvio-runner search_is_fast -- --ignored`
    #[test]
    #[ignore]
    fn search_is_fast() {
        let dir = tempfile::tempdir().unwrap();
        let r = Runner::open(dir.path()).unwrap();
        let ws = r.create_workspace("Big".into(), None).unwrap();
        let kb = kb_of(&r);
        kb.background.store(true, Ordering::SeqCst);
        let words = ["agent", "thread", "invoice", "deploy", "search", "board", "issue", "runner", "hub", "design", "token", "review"];
        for i in 0..20_000usize {
            let text: String = (0..300).map(|j| words[(i * 7 + j * 13) % words.len()]).collect::<Vec<_>>().join(" ");
            index(&r, ws.id, "doc", &i.to_string(), &format!("Doc {i}"), &text);
        }
        let ix = kb.open(ws.id).unwrap();
        ix.flush().unwrap();
        let t = Instant::now();
        for q in ["invoice deploy", "rev", "agent thread board"] {
            assert!(!ix.search(q, &[], 30, None).unwrap().is_empty());
        }
        let per = t.elapsed() / 3;
        assert!(per < Duration::from_millis(50), "{per:?}");
    }

    #[test]
    fn rrf_merges_ranked_lists() {
        let a = vec!["x".to_string(), "y".into(), "z".into()];
        let b = vec!["y".to_string(), "w".into(), "x".into()];
        let fused = rrf(&[a, b]);
        let keys: Vec<&str> = fused.iter().map(|(k, _)| k.as_str()).collect();
        // Found high in both lists beats first in one list only.
        assert_eq!(keys[0], "y");
        assert_eq!(keys[1], "x");
        assert_eq!(keys[2], "w");
        assert_eq!(keys.len(), 4);
        assert!(fused.windows(2).all(|w| w[0].1 >= w[1].1));
        let single = rrf(&[vec!["a".into(), "b".into()]]);
        assert_eq!(single[0].0, "a");
    }

    #[test]
    fn chunks_overlap_and_cover_everything() {
        let text = "word ".repeat(1000);
        let chunks = chunk(&text, 800, 150);
        assert!(chunks.len() > 5);
        assert_eq!(chunks[0].0, 0);
        let (ls, ll) = *chunks.last().unwrap();
        assert_eq!(ls + ll, text.chars().count());
        for w in chunks.windows(2) {
            let (s0, l0) = w[0];
            assert!(l0 <= 800);
            assert!(w[1].0 < s0 + l0, "chunks overlap");
            assert!(w[1].0 > s0, "chunks advance");
        }
        // Chunks start at words.
        assert!(chunks.iter().all(|(s, _)| text.chars().nth(*s) == Some('w')));
        assert!(chunk("", 800, 150).is_empty());
        assert_eq!(chunk("short", 800, 150), vec![(0, 5)]);
    }

    #[test]
    fn vectors_round_trip_and_rank() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vectors::default();
        v.replace("doc:a", 1, &[(0, 10)], vec![vec![1.0, 0.0, 0.0]]);
        v.replace("note:b", 2, &[(0, 10), (10, 10)], vec![vec![0.0, 1.0, 0.0], vec![0.7, 0.7, 0.0]]);
        v.save(&dir.path().join("v.bin")).unwrap();
        let v = Vectors::load(&dir.path().join("v.bin")).unwrap();
        assert_eq!(v.entries.len(), 3);
        assert!(v.has("note:b", 2) && !v.has("note:b", 3));
        let near = v.nearest(&[0.0, 1.0, 0.1], &[], 10, 0.3);
        assert_eq!(near[0], ("note:b".to_string(), 0, 10));
        let only_docs = v.nearest(&[0.0, 1.0, 0.1], &["doc".into()], 10, -1.0);
        assert_eq!(only_docs.len(), 1);
    }

    #[test]
    fn snippet_marks_words() {
        let text = format!("{} The Sign-up form fails on Safari. {}", "lorem ipsum ".repeat(40), "dolor ".repeat(40));
        let s = make_snippet(&text, &["form".into(), "safari".into()], None, 120);
        assert!(s.text.starts_with('…') && s.text.ends_with('…'));
        let marked: Vec<String> = s.highlights.iter().map(|(a, b)| s.text.chars().skip(*a as usize).take((*b - *a) as usize).collect()).collect();
        assert_eq!(marked, vec!["form", "Safari"]);
        // Not inside other words.
        let s = make_snippet("platform form", &["form".into()], None, 120);
        assert_eq!(s.highlights, vec![(9, 13)]);
    }

    #[test]
    fn docx_to_markdown_keeps_structure() {
        let doc = r#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Plan</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Goals &amp; scope</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Ship the </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>beta</w:t></w:r><w:r><w:t>.</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Nested</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Hub</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Tim | Ann</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>"#;
        let bytes = zip_of(&[("word/document.xml", doc)]);
        let md = docx_to_markdown(&bytes).unwrap();
        assert_eq!(
            md,
            "# Plan\n\n## Goals & scope\n\nShip the beta.\n\n- First\n  - Nested\n\n| Name | Owner |\n| --- | --- |\n| Hub | Tim \\| Ann |\n"
        );
        assert!(convert("plan.docx", &bytes).unwrap().contains("## Goals"));
    }

    #[test]
    fn xlsx_and_csv_to_tables() {
        let xlsx = zip_of(&[
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Cost</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Hosting</t></is></c><c r="B2"><v>12.5</v></c></row></sheetData></worksheet>"#,
            ),
        ]);
        let md = sheets_to_markdown(&xlsx).unwrap();
        assert_eq!(md, "| Item | Cost |\n| --- | --- |\n| Hosting | 12.5 |\n\n");

        let csv = "Name,Note\r\n\"Doe, Jane\",\"said \"\"hi\"\"\"\nBob,\"two\nlines\"\n\n";
        assert_eq!(csv_to_markdown(csv, ','), "| Name | Note |\n| --- | --- |\n| Doe, Jane | said \"hi\" |\n| Bob | two lines |\n");
        assert!(convert("a.tsv", b"a\tb\n1\t2\n").unwrap().contains("| 1 | 2 |"));
        assert!(convert("x.zip", &[0, 1, 2, 0]).is_err());
    }

    #[test]
    fn html_main_content_to_markdown() {
        let html = r#"<html><head><title>Fast search | Blog</title><script>var x = 1;</script></head><body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<aside>Subscribe to our newsletter</aside>
<article>
  <h1>Fast search</h1>
  <p>Search should feel <strong>instant</strong>, under <em>50 ms</em>. See <a href="/docs/bm25">BM25</a>.</p>
  <h2>How</h2>
  <ul><li>Keep an index</li><li>Fuse ranks<ul><li>with RRF</li></ul></li></ul>
  <pre><code>let k = 60;</code></pre>
  <table><tr><th>Size</th><th>Time</th></tr><tr><td>10k</td><td>4 ms</td></tr></table>
  <p>Inline <code>code</code> and an image <img src="/a.png" alt="chart">.</p>
</article>
<footer>Copyright</footer></body></html>"#;
        let base = reqwest::Url::parse("https://example.com/blog/post").unwrap();
        let (title, md) = html_to_markdown(html, Some(&base));
        assert_eq!(title, "Fast search | Blog");
        assert!(!md.contains("Subscribe") && !md.contains("Copyright") && !md.contains("var x") && !md.contains("About"), "{md}");
        assert!(md.contains("Search should feel **instant**, under *50 ms*. See [BM25](https://example.com/docs/bm25)."), "{md}");
        assert!(md.contains("## How"), "{md}");
        assert!(md.contains("- Keep an index\n- Fuse ranks\n  - with RRF"), "{md}");
        assert!(md.contains("```\nlet k = 60;\n```"), "{md}");
        assert!(md.contains("| Size | Time |\n| --- | --- |\n| 10k | 4 ms |"), "{md}");
        assert!(md.contains("Inline `code` and an image ![chart](https://example.com/a.png)."), "{md}");

        // Without an article: the block with the most paragraph text wins.
        let html = "<body><div class=menu><p>Menu</p></div><div><p>First long paragraph of the story.</p><p>Second paragraph.</p></div></body>";
        let (_, md) = html_to_markdown(html, None);
        assert_eq!(md, "First long paragraph of the story.\n\nSecond paragraph.\n");
    }

    #[test]
    fn registry_entries_map_to_commands() {
        let v = json!({ "servers": [
            { "server": { "name": "io.github.acme/mcp-server-notes", "description": "Notes", "version": "1.2.0",
              "repository": { "url": "https://github.com/acme/notes" },
              "packages": [{ "registryType": "npm", "identifier": "@acme/notes", "version": "1.2.0", "transport": { "type": "stdio" },
                "packageArguments": [{ "type": "named", "name": "--mode", "value": "read" }],
                "environmentVariables": [{ "name": "NOTES_TOKEN", "isRequired": true, "isSecret": true, "description": "Token" }] }] } },
            { "server": { "name": "io.github.acme/mcp-server-notes", "description": "dup" } },
            { "server": { "name": "py/thing", "packages": [{ "registryType": "pypi", "identifier": "thing-mcp" }] } },
            { "server": { "name": "oci/box", "packages": [{ "registryType": "oci", "identifier": "ghcr.io/x/box:1", "environmentVariables": [{ "name": "KEY" }] }] } },
            { "server": { "name": "remote/only", "remotes": [{ "type": "streamable-http", "url": "https://x.dev/mcp" }] } },
            { "server": { "name": "remote/auth", "remotes": [{ "type": "sse", "url": "https://y.dev", "headers": [{ "name": "Authorization", "isRequired": true }] }] } }
        ]});
        let list = map_registry(&v);
        assert_eq!(list.len(), 5);
        let n = &list[0];
        assert_eq!(n.short_name, "notes");
        assert_eq!(n.command.as_deref(), Some("npx"));
        assert_eq!(n.args, vec!["-y", "@acme/notes@1.2.0", "--mode", "read"]);
        assert!(n.env[0].required && n.env[0].secret);
        assert_eq!(list[1].args, vec!["thing-mcp"]);
        assert_eq!(list[1].runtime.as_deref(), Some("uvx"));
        assert_eq!(list[2].args, vec!["run", "-i", "--rm", "-e", "KEY", "ghcr.io/x/box:1"]);
        assert_eq!(list[3].args, vec!["-y", "mcp-remote", "https://x.dev/mcp"]);
        assert!(list[4].command.is_none());
    }

    #[test]
    fn install_and_remove_mcp() {
        let dir = tempfile::tempdir().unwrap();
        let r = Runner::open(dir.path()).unwrap();
        let ws = r.create_workspace("W".into(), None).unwrap();
        let s = McpServer { name: "notes".into(), command: "npx".into(), args: vec!["-y".into(), "notes".into()], env: vec![("TOKEN".into(), "x".into())] };
        install_mcp(&r, ws.id, s.clone()).unwrap();
        install_mcp(&r, ws.id, s).unwrap();
        assert_eq!(r.settings(ws.id).mcp_servers.len(), 1);
        assert!(install_mcp(&r, ws.id, McpServer { name: "bouvio".into(), command: "x".into(), ..Default::default() }).is_err());
        remove_mcp(&r, ws.id, "notes").unwrap();
        assert!(r.settings(ws.id).mcp_servers.is_empty());
    }

    #[test]
    fn skills_front_matter_and_sources() {
        let md = "---\nname: pdf\ndescription: \"Read and fill PDFs\"\nlicense: MIT\n---\n# PDF";
        let fm = front_matter(md);
        assert_eq!(fm["name"], "pdf");
        assert_eq!(fm["description"], "Read and fill PDFs");
        let fm = front_matter("---\nname: x\ndescription: >\n  spans\n  lines\n---\n");
        assert_eq!(fm["description"], "spans lines");
        assert!(front_matter("# no front matter").is_empty());

        assert_eq!(parse_source("acme/skills"), Some(("acme/skills".into(), "HEAD".into(), String::new())));
        assert_eq!(
            parse_source("https://github.com/acme/skills/tree/main/team/review"),
            Some(("acme/skills".into(), "main".into(), "team/review".into()))
        );
        assert_eq!(parse_source("acme/skills/extra"), Some(("acme/skills".into(), "HEAD".into(), "extra".into())));
        assert_eq!(parse_source("nope"), None);

        let files: Vec<String> = ["README.md", "skills/pdf/SKILL.md", "skills/pdf/scripts/fill.py", "skills/xlsx/SKILL.md", "template/SKILL.md"].iter().map(|s| s.to_string()).collect();
        assert_eq!(skill_dirs(&files, ""), vec!["skills/pdf", "skills/xlsx", "template"]);
        assert_eq!(skill_dirs(&files, "skills"), vec!["skills/pdf", "skills/xlsx"]);
        assert_eq!(skill_dirs(&files, "skills/pdf"), vec!["skills/pdf"]);
        assert!(safe_rel("scripts/fill.py") && !safe_rel("../x") && !safe_rel("/etc/passwd"));
    }

    #[test]
    fn installed_skills_list_and_remove() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        let skill = root.join(".claude/skills/review");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\nname: code-review\ndescription: Reviews diffs\n---\n").unwrap();
        let r = Runner::open(dir.path().join("data")).unwrap();
        let ws = r.create_workspace("W".into(), Some(root.to_string_lossy().into())).unwrap();
        let list = list_installed_skills(&r, ws.id);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "code-review");
        assert!(remove_skill(&r, ws.id, "..").is_err());
        remove_skill(&r, ws.id, "code-review").unwrap();
        assert!(list_installed_skills(&r, ws.id).is_empty());
    }

    #[tokio::test]
    async fn import_bytes_saves_indexes_and_registers() {
        let dir = tempfile::tempdir().unwrap();
        let r = Runner::open(dir.path()).unwrap();
        let ws = r.create_workspace("Notes".into(), None).unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode("Region,Revenue\nNorth,120\nSouth,80\n");
        let v = call(&r, "import_bytes", &json!({ "workspace_id": ws.id, "name": "Q3 sales.csv", "base64": b64 }), "me").await.unwrap().unwrap();
        let a: Artifact = serde_json::from_value(v).unwrap();
        assert_eq!(a.kind, ArtifactKind::Markdown);
        assert_eq!(a.title, "Q3 sales.csv");
        assert!(a.path.ends_with("q3-sales.md"));
        let text = std::fs::read_to_string(&a.path).unwrap();
        assert!(text.starts_with("---\ntitle: \"Q3 sales.csv\"\nsource: \"Q3 sales.csv\"\n"), "{text}");
        assert!(text.contains("| North | 120 |"));
        let hits = search(&r, &json!({ "workspace_id": ws.id, "query": "revenue north" })).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].location, SearchLocation::Artifact { artifact_id: a.id, path: a.path.clone() });
        // Importing again replaces the same artifact.
        call(&r, "import_bytes", &json!({ "workspace_id": ws.id, "name": "Q3 sales.csv", "base64": b64 }), "me").await.unwrap().unwrap();
        assert_eq!(r.list_artifacts(ws.id).len(), 1);
    }
}
