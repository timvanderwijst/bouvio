//! Personal overview: brief, tasks and notes, costs and budgets, replay, evals.
//!
//! Everything lives under `<data>/personal`: `tasks.json`, `notes/*.md`,
//! `budgets.json`, `briefs/<date>.json` and `evals/{suites,runs}.json`.
//! Tasks, notes and the brief are this machine's own and never reachable
//! through the hub; costs, replay and evals are scoped to one workspace.

use crate::{store, title_from, Runner};
use anyhow::{bail, Context, Result};
use cuna_protocol::personal::*;
use cuna_protocol::*;
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone, Utc};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use uuid::Uuid;

const METHODS: &[&str] = &[
    "get_brief",
    "list_tasks",
    "create_task",
    "update_task",
    "delete_task",
    "reorder_tasks",
    "list_notes",
    "get_note",
    "save_note",
    "delete_note",
    "cost_summary",
    "set_budget",
    "list_budgets",
    "thread_replay",
    "list_evals",
    "save_eval",
    "delete_eval",
    "run_eval",
    "list_eval_runs",
    "get_eval_run",
];

fn p<T: DeserializeOwned>(params: &Value, key: &str) -> Result<T> {
    serde_json::from_value(params.get(key).cloned().unwrap_or(Value::Null)).with_context(|| format!("param `{key}`"))
}

fn opt<T: DeserializeOwned>(params: &Value, key: &str) -> Option<T> {
    params.get(key).cloned().and_then(|v| serde_json::from_value(v).ok())
}

fn ok<T: serde::Serialize>(v: T) -> Result<Value> {
    Ok(serde_json::to_value(v)?)
}

pub async fn call(r: &Arc<Runner>, method: &str, params: &Value, _actor: &str) -> Option<Result<Value>> {
    if !METHODS.contains(&method) {
        return None;
    }
    Some(handle(r, method, params).await)
}

async fn handle(r: &Arc<Runner>, method: &str, params: &Value) -> Result<Value> {
    match method {
        "get_brief" => ok(get_brief(r, opt(params, "date"), opt(params, "regenerate").unwrap_or(false)).await?),

        "list_tasks" => ok(list_tasks(r)),
        "create_task" => ok(create_task(r, p(params, "task")?)?),
        "update_task" => ok(update_task(r, p(params, "task")?)?),
        "delete_task" => ok(delete_task(r, p(params, "id")?)?),
        "reorder_tasks" => ok(reorder_tasks(r, p(params, "ids")?)?),

        "list_notes" => ok(list_notes(r)),
        "get_note" => ok(get_note(r, &p::<String>(params, "id")?)?),
        "save_note" => ok(save_note(r, opt(params, "id"), p(params, "text")?)?),
        "delete_note" => ok(delete_note(r, &p::<String>(params, "id")?)?),

        "cost_summary" => ok(cost_summary(r, opt(params, "workspace_id"), opt(params, "days").unwrap_or(30))),
        "set_budget" => ok(set_budget(r, p(params, "workspace_id")?, p(params, "scope")?, opt(params, "id"), opt(params, "monthly_usd").unwrap_or(0.0))?),
        "list_budgets" => ok(list_budgets(r, opt(params, "workspace_id"))),

        "thread_replay" => ok(thread_replay(r, p(params, "thread_id")?)?),

        "list_evals" => ok(list_evals(r, p(params, "workspace_id")?)),
        "save_eval" => ok(save_eval(r, p(params, "suite")?)?),
        "delete_eval" => ok(delete_eval(r, p(params, "id")?)?),
        "run_eval" => ok(run_eval(r, p(params, "suite_id")?, p(params, "targets")?)?),
        "list_eval_runs" => ok(list_eval_runs(r, opt(params, "workspace_id"), opt(params, "suite_id"))),
        "get_eval_run" => ok(get_eval_run(r, p(params, "id")?)?),
        m => bail!("unknown method `{m}`"),
    }
}

pub fn workspace_of(r: &Runner, method: &str, params: &Value) -> Option<Result<Uuid>> {
    let suite_ws = |id: Option<Uuid>| -> Result<Uuid> {
        let id = id.context("missing suite id")?;
        load_suites(r).into_iter().find(|s| s.id == id).map(|s| s.workspace_id).context("unknown eval suite")
    };
    match method {
        "run_eval" => Some(suite_ws(opt(params, "suite_id"))),
        "list_eval_runs" => Some(suite_ws(opt(params, "suite_id"))),
        "delete_eval" => Some(suite_ws(opt(params, "id"))),
        "save_eval" => {
            let suite = params.get("suite")?;
            match opt::<Uuid>(suite, "id").filter(|id| !id.is_nil()) {
                Some(id) => Some(suite_ws(Some(id))),
                None => Some(opt::<Uuid>(suite, "workspace_id").context("suite without workspace")),
            }
        }
        "get_eval_run" => Some(
            opt::<Uuid>(params, "id")
                .and_then(|id| load_runs(r).into_iter().find(|x| x.id == id))
                .map(|x| x.workspace_id)
                .context("unknown eval run"),
        ),
        _ => None,
    }
}

pub fn start(r: &Arc<Runner>) {
    // Eval runs that were going when the runner stopped will not finish now.
    let _g = lock();
    let mut runs = load_runs(r);
    let mut changed = false;
    for run in runs.iter_mut().filter(|x| x.finished_at.is_none()) {
        for res in run.results.iter_mut().filter(|x| matches!(x.status, EvalStatus::Pending | EvalStatus::Running)) {
            res.status = EvalStatus::Error;
            res.reason = Some("Interrupted: the runner stopped.".into());
        }
        run.finished_at = Some(Utc::now());
        changed = true;
    }
    if changed {
        let _ = store::save(&evals_dir(r).join("runs.json"), &runs);
    }
}

// ---- shared helpers ---------------------------------------------------------------------

fn dir(r: &Runner) -> PathBuf {
    r.store().dir().join("personal")
}

/// One lock around every read-modify-write of the files of this area.
fn lock() -> MutexGuard<'static, ()> {
    static L: Mutex<()> = Mutex::new(());
    L.lock().unwrap_or_else(|e| e.into_inner())
}

/// Workspaces this runner hosts (personal or shared by me), not ones others host.
fn local_workspaces(r: &Runner) -> Vec<Workspace> {
    r.workspaces().into_iter().filter(|w| w.role.is_none()).collect()
}

fn local_date(at: DateTime<Utc>) -> NaiveDate {
    at.with_timezone(&Local).date_naive()
}

fn local_midnight(d: NaiveDate) -> DateTime<Utc> {
    let naive = d.and_hms_opt(0, 0, 0).expect("midnight");
    Local.from_local_datetime(&naive).earliest().map(|x| x.with_timezone(&Utc)).unwrap_or_else(|| Utc.from_utc_datetime(&naive))
}

fn month_start(now: DateTime<Utc>) -> DateTime<Utc> {
    let d = local_date(now);
    local_midnight(d.with_day(1).unwrap_or(d))
}

fn parse_date(s: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").with_context(|| format!("`{s}` is not a date (YYYY-MM-DD)"))
}

fn harness_name(h: HarnessKind) -> &'static str {
    match h {
        HarnessKind::ClaudeCode => "Claude Code",
        HarnessKind::Codex => "Codex",
        HarnessKind::OpenCode => "OpenCode",
        HarnessKind::GeminiCli => "Gemini CLI",
        HarnessKind::Api => "API",
    }
}

fn harness_id(h: HarnessKind) -> String {
    serde_json::to_value(h).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

// ---- tasks ------------------------------------------------------------------------------

fn tasks_path(r: &Runner) -> PathBuf {
    dir(r).join("tasks.json")
}

pub fn list_tasks(r: &Runner) -> Vec<Task> {
    let mut v: Vec<Task> = store::load(&tasks_path(r)).unwrap_or_default();
    v.sort_by(|a, b| a.sort.total_cmp(&b.sort).then(a.created_at.cmp(&b.created_at)));
    v
}

fn save_tasks(r: &Runner, tasks: &[Task]) -> Result<()> {
    store::save(&tasks_path(r), &tasks)?;
    r.notice(Uuid::nil(), "personal-tasks", tasks);
    Ok(())
}

fn check_due(due: &Option<String>) -> Result<Option<String>> {
    match due.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => Ok(Some(parse_date(d)?.format("%Y-%m-%d").to_string())),
        None => Ok(None),
    }
}

pub fn create_task(r: &Runner, new: NewTask) -> Result<Task> {
    let title = new.title.trim().to_string();
    if title.is_empty() {
        bail!("a task needs a title");
    }
    let _g = lock();
    let mut tasks = list_tasks(r);
    let task = Task {
        id: Uuid::new_v4(),
        title,
        notes: new.notes.filter(|n| !n.trim().is_empty()),
        done: false,
        due: check_due(&new.due)?,
        priority: new.priority.unwrap_or_default(),
        workspace_id: new.workspace_id,
        thread_id: new.thread_id,
        created_at: Utc::now(),
        done_at: None,
        sort: tasks.iter().map(|t| t.sort).fold(0.0, f64::max) + 1.0,
    };
    tasks.push(task.clone());
    save_tasks(r, &tasks)?;
    Ok(task)
}

pub fn update_task(r: &Runner, mut task: Task) -> Result<Task> {
    let _g = lock();
    let mut tasks = list_tasks(r);
    let slot = tasks.iter_mut().find(|t| t.id == task.id).context("unknown task")?;
    task.title = task.title.trim().to_string();
    if task.title.is_empty() {
        bail!("a task needs a title");
    }
    task.due = check_due(&task.due)?;
    task.created_at = slot.created_at;
    task.done_at = match (task.done, slot.done_at) {
        (false, _) => None,
        (true, Some(at)) => Some(at),
        (true, None) => Some(Utc::now()),
    };
    *slot = task.clone();
    save_tasks(r, &tasks)?;
    Ok(task)
}

pub fn delete_task(r: &Runner, id: Uuid) -> Result<()> {
    let _g = lock();
    let mut tasks = list_tasks(r);
    tasks.retain(|t| t.id != id);
    save_tasks(r, &tasks)
}

/// Put these tasks in this order; tasks not named keep their place.
pub fn reorder_tasks(r: &Runner, ids: Vec<Uuid>) -> Result<Vec<Task>> {
    let _g = lock();
    let mut tasks = list_tasks(r);
    let mut slots: Vec<f64> = tasks.iter().filter(|t| ids.contains(&t.id)).map(|t| t.sort).collect();
    slots.sort_by(f64::total_cmp);
    for (id, sort) in ids.iter().zip(slots) {
        if let Some(t) = tasks.iter_mut().find(|t| t.id == *id) {
            t.sort = sort;
        }
    }
    tasks.sort_by(|a, b| a.sort.total_cmp(&b.sort));
    save_tasks(r, &tasks)?;
    Ok(tasks)
}

// ---- notes ------------------------------------------------------------------------------

fn notes_dir(r: &Runner) -> PathBuf {
    dir(r).join("notes")
}

fn note_path(r: &Runner, id: &str) -> Result<PathBuf> {
    let valid = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        bail!("not a note id: `{id}`");
    }
    Ok(notes_dir(r).join(format!("{id}.md")))
}

/// The first non-empty line, without Markdown heading marks.
pub fn note_title(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let t = line.trim_start_matches('#').trim();
    if t.is_empty() {
        "Untitled".into()
    } else {
        clip(t, 80)
    }
}

fn note_excerpt(text: &str) -> String {
    let line = text.lines().map(str::trim).filter(|l| !l.is_empty()).nth(1).unwrap_or("");
    clip(line.trim_start_matches(['#', '-', '*', '>', ' ']), 120)
}

fn modified(path: &Path) -> DateTime<Utc> {
    std::fs::metadata(path).and_then(|m| m.modified()).map(DateTime::<Utc>::from).unwrap_or_else(|_| Utc::now())
}

pub fn list_notes(r: &Runner) -> Vec<NoteMeta> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(notes_dir(r)) else { return out };
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else { continue };
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        out.push(NoteMeta { id, title: note_title(&text), excerpt: note_excerpt(&text), updated_at: modified(&path) });
    }
    out.sort_by_key(|n| std::cmp::Reverse(n.updated_at));
    out
}

pub fn get_note(r: &Runner, id: &str) -> Result<Note> {
    let path = note_path(r, id)?;
    let text = std::fs::read_to_string(&path).context("unknown note")?;
    Ok(Note { id: id.to_string(), title: note_title(&text), updated_at: modified(&path), text })
}

pub fn save_note(r: &Runner, id: Option<String>, text: String) -> Result<Note> {
    let id = id.filter(|i| !i.is_empty()).unwrap_or_else(|| Uuid::new_v4().simple().to_string()[..12].to_string());
    let path = note_path(r, &id)?;
    std::fs::create_dir_all(notes_dir(r))?;
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, &text)?;
    std::fs::rename(&tmp, &path)?;
    let title = note_title(&text);
    crate::ext::knowledge::index(r, Uuid::nil(), "note", &id, &title, &text);
    Ok(Note { id, title, updated_at: modified(&path), text })
}

pub fn delete_note(r: &Runner, id: &str) -> Result<()> {
    let path = note_path(r, id)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    crate::ext::knowledge::unindex(r, Uuid::nil(), "note", id);
    Ok(())
}

// ---- costs ------------------------------------------------------------------------------

/// One finished turn: when, what it cost (if the harness said), who asked for it.
#[derive(Debug, Clone)]
struct Turn {
    at: DateTime<Utc>,
    cost: Option<f64>,
    author: Option<String>,
}

/// A thread's turns, parsed once per event-file length.
fn thread_turns(r: &Runner, thread_id: Uuid) -> Arc<Vec<Turn>> {
    type Cache = Mutex<HashMap<PathBuf, (u64, Arc<Vec<Turn>>)>>;
    static CACHE: OnceLock<Cache> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let path = r.store().dir().join("events").join(format!("{thread_id}.jsonl"));
    let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if let Some((l, turns)) = cache.lock().unwrap().get(&path) {
        if *l == len {
            return turns.clone();
        }
    }
    let mut turns = Vec::new();
    let mut author = None;
    for e in r.thread_events(thread_id).unwrap_or_default() {
        match e.event {
            ThreadEvent::UserMessage { author: a, .. } => author = Some(a),
            ThreadEvent::TurnComplete { cost_usd, .. } => turns.push(Turn { at: e.at, cost: cost_usd, author: author.clone() }),
            _ => {}
        }
    }
    let turns = Arc::new(turns);
    cache.lock().unwrap().insert(path, (len, turns.clone()));
    turns
}

#[derive(Default)]
struct Acc(HashMap<String, CostRow>);

impl Acc {
    fn add(&mut self, key: String, label: String, cost: f64) {
        let row = self.0.entry(key.clone()).or_insert_with(|| CostRow { key, label, ..Default::default() });
        row.cost_usd += cost;
        row.turns += 1;
    }
    fn rows(self) -> Vec<CostRow> {
        let mut v: Vec<CostRow> = self.0.into_values().collect();
        v.sort_by(|a, b| b.cost_usd.total_cmp(&a.cost_usd).then(b.turns.cmp(&a.turns)));
        v
    }
}

pub fn cost_summary(r: &Runner, workspace_id: Option<Uuid>, days: u32) -> CostSummary {
    cost_summary_at(r, workspace_id, days, Utc::now())
}

fn cost_summary_at(r: &Runner, workspace_id: Option<Uuid>, days: u32, now: DateTime<Utc>) -> CostSummary {
    let days = days.clamp(1, 366);
    let today = local_date(now);
    let first = today - Duration::days(days as i64 - 1);
    let since = local_midnight(first);
    let mut per_day: Vec<CostDay> = (0..days)
        .map(|i| CostDay { date: (first + Duration::days(i as i64)).format("%Y-%m-%d").to_string(), ..Default::default() })
        .collect();
    let (mut total, mut turns_n, mut unknown) = (0.0, 0u32, 0u32);
    let (mut leads, mut models, mut people) = (Acc::default(), Acc::default(), Acc::default());
    let mut threads: Vec<CostThread> = Vec::new();

    let scope: Vec<Workspace> = match workspace_id {
        Some(id) => r.workspace(id).into_iter().collect(),
        None => local_workspaces(r),
    };
    for ws in &scope {
        let names: HashMap<Uuid, String> = r.leads(ws.id).into_iter().map(|c| (c.id, c.name)).collect();
        for t in r.threads(ws.id) {
            let mut row = CostThread { thread_id: t.id, workspace_id: ws.id, title: t.title.clone(), cost_usd: 0.0, turns: 0 };
            for turn in thread_turns(r, t.id).iter().filter(|x| x.at >= since && x.at <= now) {
                let c = turn.cost.unwrap_or(0.0);
                if turn.cost.is_none() {
                    unknown += 1;
                }
                total += c;
                turns_n += 1;
                let idx = (local_date(turn.at) - first).num_days();
                if let Some(d) = usize::try_from(idx).ok().and_then(|i| per_day.get_mut(i)) {
                    d.cost_usd += c;
                    d.turns += 1;
                }
                match t.lead_id {
                    Some(cid) => leads.add(cid.to_string(), names.get(&cid).cloned().unwrap_or_default(), c),
                    None => leads.add(String::new(), String::new(), c),
                }
                let model = t.model.clone().unwrap_or_default();
                let label = if model.is_empty() { harness_name(t.harness).to_string() } else { format!("{} · {model}", harness_name(t.harness)) };
                models.add(format!("{}:{model}", harness_id(t.harness)), label, c);
                let who = turn.author.clone().unwrap_or_default();
                people.add(who.clone(), who, c);
                row.cost_usd += c;
                row.turns += 1;
            }
            if row.turns > 0 {
                threads.push(row);
            }
        }
    }
    threads.sort_by(|a, b| b.cost_usd.total_cmp(&a.cost_usd));
    threads.truncate(10);

    CostSummary {
        workspace_id,
        days,
        since,
        total_usd: total,
        turns: turns_n,
        unknown_turns: unknown,
        per_day,
        per_lead: leads.rows(),
        per_model: models.rows(),
        per_person: people.rows(),
        top_threads: threads,
        budgets: list_budgets_at(r, workspace_id, now),
    }
}

/// What a workspace (or one lead in it) spent since `since`.
fn spent_since(r: &Runner, workspace_id: Uuid, lead: Option<Uuid>, since: DateTime<Utc>) -> f64 {
    r.threads(workspace_id)
        .into_iter()
        .filter(|t| lead.is_none() || t.lead_id == lead)
        .map(|t| thread_turns(r, t.id).iter().filter(|x| x.at >= since).filter_map(|x| x.cost).sum::<f64>())
        .sum()
}

// ---- budgets ----------------------------------------------------------------------------

fn budgets_path(r: &Runner) -> PathBuf {
    dir(r).join("budgets.json")
}

fn load_budgets(r: &Runner) -> Vec<Budget> {
    store::load(&budgets_path(r)).unwrap_or_default()
}

fn budget_label(r: &Runner, b: &Budget) -> String {
    match (b.scope, b.id) {
        (BudgetScope::Lead, Some(id)) => r.store().lead(id).map(|c| c.name).unwrap_or_else(|| "a removed lead".into()),
        _ => r.workspace(b.workspace_id).map(|w| w.name).unwrap_or_else(|| "this workspace".into()),
    }
}

pub fn list_budgets(r: &Runner, workspace_id: Option<Uuid>) -> Vec<BudgetStatus> {
    list_budgets_at(r, workspace_id, Utc::now())
}

fn list_budgets_at(r: &Runner, workspace_id: Option<Uuid>, now: DateTime<Utc>) -> Vec<BudgetStatus> {
    let since = month_start(now);
    let mut v: Vec<BudgetStatus> = load_budgets(r)
        .into_iter()
        .filter(|b| workspace_id.is_none_or(|w| w == b.workspace_id))
        .map(|b| {
            let lead = if b.scope == BudgetScope::Lead { b.id } else { None };
            BudgetStatus { label: budget_label(r, &b), spent_usd: spent_since(r, b.workspace_id, lead, since), budget: b }
        })
        .collect();
    v.sort_by_key(|b| (b.budget.scope == BudgetScope::Lead, b.label.to_lowercase()));
    v
}

/// Set a monthly budget; zero or less removes it. Returns the workspace's budgets.
pub fn set_budget(r: &Runner, workspace_id: Uuid, scope: BudgetScope, id: Option<Uuid>, monthly_usd: f64) -> Result<Vec<BudgetStatus>> {
    r.workspace(workspace_id).context("unknown workspace")?;
    let id = match scope {
        BudgetScope::Workspace => None,
        BudgetScope::Lead => {
            let id = id.context("a lead budget needs the lead")?;
            r.store().lead(id).filter(|c| c.workspace_id == workspace_id).context("unknown lead")?;
            Some(id)
        }
    };
    if !monthly_usd.is_finite() {
        bail!("not an amount");
    }
    {
        let _g = lock();
        let mut all = load_budgets(r);
        all.retain(|b| !(b.workspace_id == workspace_id && b.scope == scope && b.id == id));
        if monthly_usd > 0.0 {
            all.push(Budget { workspace_id, scope, id, monthly_usd });
        }
        store::save(&budgets_path(r), &all)?;
    }
    let out = list_budgets(r, Some(workspace_id));
    r.notice(workspace_id, "personal-budgets", &out);
    Ok(out)
}

/// Refuse a new turn when the thread's lead or workspace is over its budget.
pub fn check_budget(r: &Runner, thread: &cuna_protocol::Thread) -> Result<()> {
    let budgets: Vec<Budget> = load_budgets(r).into_iter().filter(|b| b.workspace_id == thread.workspace_id).collect();
    if budgets.is_empty() {
        return Ok(());
    }
    let since = month_start(Utc::now());
    let lead = budgets.iter().find(|b| b.scope == BudgetScope::Lead && b.id.is_some() && b.id == thread.lead_id);
    let workspace = budgets.iter().find(|b| b.scope == BudgetScope::Workspace);
    for b in [lead, workspace].into_iter().flatten() {
        let who = if b.scope == BudgetScope::Lead { b.id } else { None };
        let spent = spent_since(r, thread.workspace_id, who, since);
        if spent >= b.monthly_usd {
            bail!("Budget reached for {} (${spent:.2} of ${:.2} this month). Raise it in Costs.", budget_label(r, b), b.monthly_usd);
        }
    }
    Ok(())
}

// ---- replay -----------------------------------------------------------------------------

fn tool_summary(name: &str, input: &Value) -> String {
    for k in ["file_path", "path", "command", "pattern", "url", "query", "description"] {
        if let Some(s) = input.get(k).and_then(Value::as_str) {
            return format!("{name} {}", clip(s.lines().next().unwrap_or(""), 80));
        }
    }
    name.to_string()
}

pub fn thread_replay(r: &Runner, thread_id: Uuid) -> Result<Replay> {
    let t = r.thread(thread_id).context("unknown thread")?;
    let events = r.thread_events(thread_id)?;
    Ok(replay_of(thread_id, t.title, &events))
}

fn replay_of(thread_id: Uuid, title: String, events: &[ThreadEnvelope]) -> Replay {
    let first = events.first().map(|e| e.at);
    let mut steps: Vec<ReplayStep> = Vec::new();
    let mut open: HashMap<String, usize> = HashMap::new();
    let mut cost = 0.0;
    let mut last = first;
    for e in events {
        let ms = |a: DateTime<Utc>, b: Option<DateTime<Utc>>| b.map(|b| (a - b).num_milliseconds().max(0)).unwrap_or(0);
        // Results and answers fold into the step that asked for them.
        match &e.event {
            ThreadEvent::Status { .. } => continue,
            ThreadEvent::ToolResult { tool_use_id, output, is_error } => {
                if let Some(s) = open.remove(&format!("tool:{tool_use_id}")).and_then(|i| steps.get_mut(i)) {
                    s.output = Some(clip(output, 20_000));
                    s.is_error = *is_error;
                    s.duration_ms = Some(ms(e.at, Some(s.at)));
                    continue;
                }
            }
            ThreadEvent::ApprovalResolved { id, allowed, by } => {
                if let Some(s) = open.remove(&format!("approval:{id}")).and_then(|i| steps.get_mut(i)) {
                    s.output = Some(format!("{} by {by}", if *allowed { "Allowed" } else { "Declined" }));
                    s.is_error = !allowed;
                    s.duration_ms = Some(ms(e.at, Some(s.at)));
                    continue;
                }
            }
            ThreadEvent::TurnComplete { cost_usd, .. } => cost += cost_usd.unwrap_or(0.0),
            _ => {}
        }
        let (kind, label, is_error) = match &e.event {
            ThreadEvent::UserMessage { text, author } => (ReplayKind::Message, format!("{author}: {}", title_from(text)), false),
            ThreadEvent::AssistantText { text } => (ReplayKind::Reply, title_from(text), false),
            ThreadEvent::ToolUse { id, name, input } => {
                open.insert(format!("tool:{id}"), steps.len());
                (ReplayKind::Tool, tool_summary(name, input), false)
            }
            ThreadEvent::ToolResult { output, is_error, .. } => (ReplayKind::Tool, title_from(output), *is_error),
            ThreadEvent::ApprovalRequest { id, tool, .. } => {
                open.insert(format!("approval:{id}"), steps.len());
                (ReplayKind::Approval, tool.clone(), false)
            }
            ThreadEvent::ApprovalResolved { allowed, by, .. } => (ReplayKind::Approval, format!("{} by {by}", if *allowed { "Allowed" } else { "Declined" }), !allowed),
            ThreadEvent::Error { message } => (ReplayKind::Error, title_from(message), true),
            ThreadEvent::TurnComplete { duration_ms, cost_usd } => (
                ReplayKind::Turn,
                match cost_usd {
                    Some(c) => format!("Turn done in {:.1}s · ${c:.2}", *duration_ms as f64 / 1000.0),
                    None => format!("Turn done in {:.1}s", *duration_ms as f64 / 1000.0),
                },
                false,
            ),
            ThreadEvent::ThreadSpawned { title, .. } => (ReplayKind::Other, format!("Started thread {title}"), false),
            ThreadEvent::ArtifactCreated { artifact } => (ReplayKind::Other, format!("Made {}", artifact.title), false),
            ThreadEvent::Status { .. } => unreachable!(),
        };
        steps.push(ReplayStep {
            seq: e.seq,
            at: e.at,
            offset_ms: ms(e.at, first),
            gap_ms: ms(e.at, last),
            duration_ms: None,
            kind,
            label,
            event: e.event.clone(),
            output: None,
            is_error,
            cost_so_far: cost,
        });
        last = Some(e.at);
    }
    Replay {
        thread_id,
        title,
        started_at: first,
        total_ms: events.last().map(|e| (e.at - first.unwrap_or(e.at)).num_milliseconds().max(0)).unwrap_or(0),
        total_cost: cost,
        steps,
    }
}

// ---- morning brief ------------------------------------------------------------------------

const BRIEF_SYSTEM: &str = "You write a morning brief for one person who runs AI agents across several projects. \
Write 5 to 8 Markdown bullet lines, nothing else: no heading, no greeting, no sign-off. \
Lead with what waits on them or failed, then what finished, then issues, automations and their tasks for today. \
Merge related facts into one line. Use the names exactly as given, in **bold**. Plain words, no hype, no emoji.";

fn briefs_dir(r: &Runner) -> PathBuf {
    dir(r).join("briefs")
}

pub async fn get_brief(r: &Arc<Runner>, date: Option<String>, regenerate: bool) -> Result<Brief> {
    let now = Utc::now();
    let date = match date.as_deref().filter(|d| !d.is_empty()) {
        Some(d) => parse_date(d)?,
        None => local_date(now),
    };
    let key = date.format("%Y-%m-%d").to_string();
    let path = briefs_dir(r).join(format!("{key}.json"));
    if !regenerate {
        if let Ok(Some(b)) = store::load::<Option<Brief>>(&path) {
            return Ok(b);
        }
    }
    let items = brief_items(r, date, now);
    let mut ai = false;
    let mut markdown = fallback_markdown(&items);
    if !items.is_empty() {
        if let Some(complete) = r.hooks.complete() {
            match complete(None, BRIEF_SYSTEM.into(), brief_prompt(&key, &items)).await {
                Ok(text) if !text.trim().is_empty() => {
                    markdown = text.trim().to_string();
                    ai = true;
                }
                Ok(_) => {}
                Err(e) => tracing::warn!("brief: {e:#}"),
            }
        }
    }
    let brief = Brief { date: key, markdown, items, generated_at: now, ai };
    store::save(&path, &brief)?;
    Ok(brief)
}

/// The facts of the 24 hours before the end of `date` (or before now, for today).
fn brief_items(r: &Runner, date: NaiveDate, now: DateTime<Utc>) -> Vec<BriefItem> {
    let end = local_midnight(date + Duration::days(1)).min(now);
    let start = end - Duration::hours(24);
    let within = |at: DateTime<Utc>| at > start && at <= end;
    let mut items = Vec::new();
    let mut names = HashMap::new();

    for ws in local_workspaces(r) {
        names.insert(ws.id, ws.name.clone());
        let item = |kind, id, title: String, detail: Option<String>, thread_id, at| BriefItem {
            kind,
            id,
            workspace_id: Some(ws.id),
            workspace: Some(ws.name.clone()),
            title,
            detail,
            thread_id,
            at,
        };
        for t in r.threads(ws.id) {
            let kind = match t.status {
                AgentStatus::Blocked => Some(BriefKind::Waiting),
                AgentStatus::Error if within(t.updated_at) => Some(BriefKind::Failed),
                AgentStatus::Idle | AgentStatus::Done if thread_turns(r, t.id).iter().any(|x| within(x.at)) => Some(BriefKind::Finished),
                _ => None,
            };
            if let Some(kind) = kind {
                items.push(item(kind, t.id, t.title.clone(), None, Some(t.id), Some(t.updated_at)));
            }
        }
        for i in r.issues.filter(|i| i.workspace_id == ws.id && within(i.updated_at)) {
            let status = serde_json::to_value(i.status).ok().and_then(|v| v.as_str().map(String::from));
            items.push(item(BriefKind::Issue, i.id, format!("{} {}", i.key, i.title), status, i.thread_ids.last().copied(), Some(i.updated_at)));
        }
        for a in r.automations.filter(|a| a.workspace_id == ws.id && a.last_run.is_some_and(within)) {
            items.push(item(BriefKind::Automation, a.id, a.name.clone(), None, a.last_thread, a.last_run));
        }
    }
    for task in list_tasks(r).into_iter().filter(|t| !t.done) {
        let Some(due) = task.due.as_deref().and_then(|d| parse_date(d).ok()) else { continue };
        if due > date {
            continue;
        }
        items.push(BriefItem {
            kind: BriefKind::Task,
            id: task.id,
            workspace_id: task.workspace_id,
            workspace: task.workspace_id.and_then(|w| names.get(&w).cloned()),
            title: task.title,
            detail: (due < date).then(|| "overdue".to_string()),
            thread_id: task.thread_id,
            at: None,
        });
    }
    items.sort_by_key(|i| (kind_rank(i.kind), std::cmp::Reverse(i.at)));
    // Keep each kind short: the brief is a glance, the pages have the rest.
    let mut seen: HashMap<BriefKind, usize> = HashMap::new();
    items.retain(|i| {
        let n = seen.entry(i.kind).or_default();
        *n += 1;
        *n <= 12
    });
    items
}

fn kind_rank(k: BriefKind) -> u8 {
    match k {
        BriefKind::Waiting => 0,
        BriefKind::Failed => 1,
        BriefKind::Finished => 2,
        BriefKind::Issue => 3,
        BriefKind::Automation => 4,
        BriefKind::Task => 5,
    }
}

fn kind_heading(k: BriefKind) -> &'static str {
    match k {
        BriefKind::Waiting => "Waiting on you",
        BriefKind::Failed => "Failed",
        BriefKind::Finished => "Finished",
        BriefKind::Issue => "Issues",
        BriefKind::Automation => "Automations that ran",
        BriefKind::Task => "Your tasks for today",
    }
}

fn item_line(i: &BriefItem) -> String {
    let mut line = i.title.clone();
    if let Some(w) = &i.workspace {
        line.push_str(&format!(" · {w}"));
    }
    if let Some(d) = &i.detail {
        line.push_str(&format!(" ({})", d.replace('_', " ")));
    }
    line
}

/// The facts as a plain grouped list, for when no model is set up.
pub fn fallback_markdown(items: &[BriefItem]) -> String {
    if items.is_empty() {
        return "Nothing happened in the last 24 hours.".into();
    }
    let mut out = String::new();
    let mut current = None;
    for i in items {
        if current != Some(i.kind) {
            if current.is_some() {
                out.push('\n');
            }
            out.push_str(&format!("**{}**\n", kind_heading(i.kind)));
            current = Some(i.kind);
        }
        out.push_str(&format!("- {}\n", item_line(i)));
    }
    out.trim_end().to_string()
}

fn brief_prompt(date: &str, items: &[BriefItem]) -> String {
    let mut s = format!("Date: {date}. What happened in the last 24 hours:\n");
    for i in items {
        s.push_str(&format!("- [{}] {}\n", kind_heading(i.kind).to_lowercase(), item_line(i)));
    }
    s
}

// ---- evals ------------------------------------------------------------------------------

/// How long one case may take before it counts as an error.
const EVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);
/// Agents running at once per eval run.
const EVAL_PARALLEL: usize = 3;

fn evals_dir(r: &Runner) -> PathBuf {
    dir(r).join("evals")
}

fn load_suites(r: &Runner) -> Vec<EvalSuite> {
    store::load(&evals_dir(r).join("suites.json")).unwrap_or_default()
}

fn load_runs(r: &Runner) -> Vec<EvalRun> {
    store::load(&evals_dir(r).join("runs.json")).unwrap_or_default()
}

pub fn list_evals(r: &Runner, workspace_id: Uuid) -> Vec<EvalSuite> {
    let mut v: Vec<EvalSuite> = load_suites(r).into_iter().filter(|s| s.workspace_id == workspace_id).collect();
    v.sort_by_key(|s| s.name.to_lowercase());
    v
}

pub fn save_eval(r: &Runner, mut suite: EvalSuite) -> Result<EvalSuite> {
    suite.name = suite.name.trim().to_string();
    if suite.name.is_empty() {
        bail!("a suite needs a name");
    }
    r.workspace(suite.workspace_id).context("unknown workspace")?;
    let _g = lock();
    let mut all = load_suites(r);
    if suite.id.is_nil() {
        suite.id = Uuid::new_v4();
    } else if let Some(old) = all.iter().find(|s| s.id == suite.id) {
        suite.workspace_id = old.workspace_id;
    }
    suite.updated_at = Utc::now();
    all.retain(|s| s.id != suite.id);
    all.push(suite.clone());
    store::save(&evals_dir(r).join("suites.json"), &all)?;
    Ok(suite)
}

pub fn delete_eval(r: &Runner, id: Uuid) -> Result<()> {
    let _g = lock();
    let mut all = load_suites(r);
    all.retain(|s| s.id != id);
    store::save(&evals_dir(r).join("suites.json"), &all)
}

pub fn list_eval_runs(r: &Runner, workspace_id: Option<Uuid>, suite_id: Option<Uuid>) -> Vec<EvalRun> {
    let mut v: Vec<EvalRun> = load_runs(r)
        .into_iter()
        .filter(|x| workspace_id.is_none_or(|w| w == x.workspace_id) && suite_id.is_none_or(|s| s == x.suite_id))
        .collect();
    v.sort_by_key(|x| std::cmp::Reverse(x.started_at));
    v
}

pub fn get_eval_run(r: &Runner, id: Uuid) -> Result<EvalRun> {
    load_runs(r).into_iter().find(|x| x.id == id).context("unknown eval run")
}

/// Change one run on disk and tell the UI.
fn update_run(r: &Runner, id: Uuid, f: impl FnOnce(&mut EvalRun)) -> Option<EvalRun> {
    let out = {
        let _g = lock();
        let mut runs = load_runs(r);
        let run = runs.iter_mut().find(|x| x.id == id)?;
        f(run);
        let out = run.clone();
        if let Err(e) = store::save(&evals_dir(r).join("runs.json"), &runs) {
            tracing::warn!("eval run: {e:#}");
        }
        out
    };
    r.notice(out.workspace_id, "personal-eval", &out);
    Some(out)
}

fn target_label(t: &EvalTarget) -> String {
    match &t.model {
        Some(m) if !m.is_empty() => format!("{} · {m}", harness_name(t.harness)),
        _ => harness_name(t.harness).to_string(),
    }
}

/// Start a run in the background: one isolated thread per case and target.
pub fn run_eval(r: &Arc<Runner>, suite_id: Uuid, targets: Vec<EvalTarget>) -> Result<EvalRun> {
    let suite = load_suites(r).into_iter().find(|s| s.id == suite_id).context("unknown eval suite")?;
    if suite.cases.is_empty() {
        bail!("this suite has no cases");
    }
    if targets.is_empty() {
        bail!("pick at least one agent to run");
    }
    let mut results = Vec::new();
    for c in 0..suite.cases.len() {
        for t in 0..targets.len() {
            results.push(EvalResult { case_index: c as u32, target_index: t as u32, thread_id: None, status: EvalStatus::Pending, reason: None, duration_ms: None, cost_usd: None });
        }
    }
    let run = EvalRun {
        id: Uuid::new_v4(),
        suite_id,
        workspace_id: suite.workspace_id,
        suite_name: suite.name.clone(),
        cases: suite.cases.clone(),
        targets,
        results,
        started_at: Utc::now(),
        finished_at: None,
    };
    {
        let _g = lock();
        let mut runs = load_runs(r);
        runs.push(run.clone());
        // Keep the latest 100 runs.
        runs.sort_by_key(|x| std::cmp::Reverse(x.started_at));
        runs.truncate(100);
        store::save(&evals_dir(r).join("runs.json"), &runs)?;
    }
    r.notice(run.workspace_id, "personal-eval", &run);

    let me = r.clone();
    let id = run.id;
    let n = run.results.len();
    tokio::spawn(async move {
        let gate = Arc::new(tokio::sync::Semaphore::new(EVAL_PARALLEL));
        let mut jobs = Vec::new();
        for idx in 0..n {
            let (me, gate) = (me.clone(), gate.clone());
            jobs.push(tokio::spawn(async move {
                let _permit = gate.acquire_owned().await;
                eval_one(&me, id, idx).await;
            }));
        }
        for j in jobs {
            let _ = j.await;
        }
        update_run(&me, id, |run| run.finished_at = Some(Utc::now()));
    });
    Ok(run)
}

async fn eval_one(r: &Arc<Runner>, run_id: Uuid, idx: usize) {
    let Some(run) = update_run(r, run_id, |run| run.results[idx].status = EvalStatus::Running) else { return };
    let res = run.results[idx].clone();
    let case = run.cases[res.case_index as usize].clone();
    let target = run.targets[res.target_index as usize].clone();
    let started = std::time::Instant::now();
    let outcome = eval_case(r, &run, &case, &target, |thread_id| {
        update_run(r, run_id, |run| run.results[idx].thread_id = Some(thread_id));
    })
    .await;
    update_run(r, run_id, |run| {
        let res = &mut run.results[idx];
        res.duration_ms = Some(started.elapsed().as_millis() as u64);
        match outcome {
            Ok((passed, reason, cost)) => {
                res.status = if passed { EvalStatus::Passed } else { EvalStatus::Failed };
                res.reason = Some(reason);
                res.cost_usd = cost;
            }
            Err(e) => {
                res.status = EvalStatus::Error;
                res.reason = Some(format!("{e:#}"));
            }
        }
    });
}

/// Run one case on one target: (passed, reason, cost).
async fn eval_case(r: &Arc<Runner>, run: &EvalRun, case: &EvalCase, target: &EvalTarget, on_thread: impl FnOnce(Uuid)) -> Result<(bool, String, Option<f64>)> {
    let t = r
        .create_thread(NewThread {
            workspace_id: run.workspace_id,
            lead_id: None,
            title: Some(format!("Eval · {} · {}", run.suite_name, target_label(target))),
            harness: target.harness,
            model: target.model.clone().filter(|m| !m.is_empty()),
            effort: Effort::Medium,
            approval: ApprovalLevel::AskRisky,
            isolate: true,
        })
        .await?;
    on_thread(t.id);

    // Subscribe before sending, so the end of a fast turn is not missed.
    let mut rx = r.subscribe_events();
    r.send_message(t.id, case.prompt.clone(), "Eval".into()).await?;
    let waited = tokio::time::timeout(EVAL_TIMEOUT, async {
        loop {
            match rx.recv().await {
                Ok(env) if env.thread_id == t.id => match env.event {
                    ThreadEvent::TurnComplete { .. } => return Ok(()),
                    ThreadEvent::Error { message } => bail!("{message}"),
                    _ => {}
                },
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    // Missed events: the log on disk has them.
                    for e in r.thread_events(t.id)? {
                        match e.event {
                            ThreadEvent::TurnComplete { .. } => return Ok(()),
                            ThreadEvent::Error { message } => bail!("{message}"),
                            _ => {}
                        }
                    }
                }
                Err(_) => bail!("the runner stopped"),
            }
        }
    })
    .await;
    let _ = r.stop_thread(t.id).await;
    match waited {
        Ok(r) => r?,
        Err(_) => bail!("timed out after {} minutes", EVAL_TIMEOUT.as_secs() / 60),
    }

    let events = r.thread_events(t.id)?;
    let reply = events
        .iter()
        .filter_map(|e| match &e.event {
            ThreadEvent::AssistantText { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let costs: Vec<Option<f64>> = events
        .iter()
        .filter_map(|e| match e.event {
            ThreadEvent::TurnComplete { cost_usd, .. } => Some(cost_usd),
            _ => None,
        })
        .collect();
    let cost = if costs.iter().any(Option::is_some) { Some(costs.iter().flatten().sum()) } else { None };

    let (passed, reason) = match case.check {
        EvalCheck::CommandExitZero => {
            let cwd = r.thread_cwd(t.id).filter(|p| p.exists()).context("the eval thread has no folder to run the command in")?;
            run_check_command(&case.expected, &cwd).await?
        }
        EvalCheck::Judge => judge(r, case, &reply).await?,
        _ => check_text(case.check, &case.expected, &reply)?,
    };
    Ok((passed, reason, cost))
}

/// Checks that only look at the reply: contains, not_contains, regex.
pub fn check_text(check: EvalCheck, expected: &str, reply: &str) -> Result<(bool, String)> {
    let has = || reply.to_lowercase().contains(&expected.to_lowercase());
    Ok(match check {
        EvalCheck::Contains => {
            let ok = has();
            (ok, if ok { format!("Contains “{expected}”.") } else { format!("Does not contain “{expected}”.") })
        }
        EvalCheck::NotContains => {
            let ok = !has();
            (ok, if ok { format!("Does not contain “{expected}”.") } else { format!("Contains “{expected}”.") })
        }
        EvalCheck::Regex => {
            let re = regex::Regex::new(expected).with_context(|| format!("not a valid pattern: {expected}"))?;
            match re.find(reply) {
                Some(m) => (true, format!("Matched “{}”.", clip(m.as_str(), 80))),
                None => (false, format!("No match for /{expected}/.")),
            }
        }
        other => bail!("{other:?} is not a text check"),
    })
}

/// Run `cmd` through the shell in `cwd`; passes when it exits 0.
pub async fn run_check_command(cmd: &str, cwd: &Path) -> Result<(bool, String)> {
    let mut c = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(cmd);
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(cmd);
        c
    };
    c.current_dir(cwd).kill_on_drop(true);
    let out = tokio::time::timeout(std::time::Duration::from_secs(600), c.output()).await.context("the check command took longer than 10 minutes")??;
    let mut text = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if text.is_empty() {
        text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    }
    let tail: String = text.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
    let code = out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "a signal".into());
    let head = if out.status.success() { "Exited 0.".to_string() } else { format!("Exited with {code}.") };
    Ok((out.status.success(), if tail.is_empty() { head } else { format!("{head}\n{}", clip(&tail, 600)) }))
}

const JUDGE_SYSTEM: &str = "You grade an AI agent's answer against criteria. \
Reply with PASS or FAIL on the first line, then one short sentence with the reason. Nothing else.";

async fn judge(r: &Runner, case: &EvalCase, reply: &str) -> Result<(bool, String)> {
    let complete = r.hooks.complete().context("the judge check needs a model: add a key or a local model in Settings")?;
    let prompt = format!("Task given to the agent:\n{}\n\nCriteria:\n{}\n\nThe agent's answer:\n{}", case.prompt, case.expected, clip(reply, 30_000));
    let answer = complete(None, JUDGE_SYSTEM.into(), prompt).await?;
    parse_verdict(&answer).with_context(|| format!("the judge did not say PASS or FAIL: {}", clip(answer.trim(), 200)))
}

/// `PASS`/`FAIL` on the first line, the reason after it.
pub fn parse_verdict(answer: &str) -> Option<(bool, String)> {
    let text = answer.trim();
    let first: String = text.chars().take_while(|c| c.is_alphabetic() || *c == '*').filter(|c| c.is_alphabetic()).collect::<String>().to_uppercase();
    let passed = match first.as_str() {
        "PASS" | "PASSED" => true,
        "FAIL" | "FAILED" => false,
        _ => return None,
    };
    let rest = text.trim_start_matches(|c: char| c.is_alphabetic() || c == '*').trim_start_matches([':', '.', '-', ' ', '—', '\n']).trim();
    Some((passed, if rest.is_empty() { (if passed { "PASS" } else { "FAIL" }).to_string() } else { clip(rest, 400) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runner() -> (tempfile::TempDir, Arc<Runner>) {
        let dir = tempfile::tempdir().unwrap();
        let r = Runner::open(dir.path()).unwrap();
        (dir, r)
    }

    async fn thread(r: &Arc<Runner>, ws: Uuid, lead: Option<Uuid>, model: Option<&str>) -> Thread {
        r.create_thread(NewThread {
            workspace_id: ws,
            lead_id: lead,
            title: Some("T".into()),
            harness: HarnessKind::ClaudeCode,
            model: model.map(String::from),
            effort: Effort::Medium,
            approval: ApprovalLevel::AskRisky,
            isolate: false,
        })
        .await
        .unwrap()
    }

    fn lead(r: &Runner, ws: Uuid, name: &str) -> Lead {
        r.create_lead(NewLead {
            workspace_id: ws,
            name: name.into(),
            instructions: String::new(),
            harness: HarnessKind::ClaudeCode,
            model: None,
            effort: Effort::Medium,
            approval: ApprovalLevel::AskRisky,
        })
        .unwrap()
    }

    /// Append a turn (a message, then its completion) to a thread's log at a given time.
    fn turn(r: &Runner, thread: Uuid, seq: u64, at: DateTime<Utc>, author: &str, cost: Option<f64>) {
        let env = |seq, event| ThreadEnvelope { thread_id: thread, seq, at, event };
        r.store().append_event(&env(seq, ThreadEvent::UserMessage { text: "go".into(), author: author.into() })).unwrap();
        r.store().append_event(&env(seq + 1, ThreadEvent::TurnComplete { duration_ms: 1000, cost_usd: cost })).unwrap();
    }

    #[tokio::test]
    async fn costs_aggregate_from_event_logs() {
        let (_d, r) = runner();
        let ws = r.create_workspace("Cuna".into(), None).unwrap();
        let cap = lead(&r, ws.id, "Runner");
        let a = thread(&r, ws.id, Some(cap.id), Some("opus")).await;
        let b = thread(&r, ws.id, None, None).await;
        let now = Utc::now();
        turn(&r, a.id, 0, now - Duration::days(2), "Maya", Some(0.50));
        turn(&r, a.id, 2, now - Duration::minutes(5), "Jonas", Some(0.25));
        turn(&r, b.id, 0, now - Duration::minutes(1), "Maya", None);
        turn(&r, b.id, 2, now - Duration::days(40), "Maya", Some(9.0)); // outside 7 days

        let s = cost_summary_at(&r, Some(ws.id), 7, now);
        assert_eq!(s.per_day.len(), 7);
        assert!((s.total_usd - 0.75).abs() < 1e-9, "{}", s.total_usd);
        assert_eq!(s.turns, 3);
        assert_eq!(s.unknown_turns, 1);
        assert!((s.per_day.iter().map(|d| d.cost_usd).sum::<f64>() - 0.75).abs() < 1e-9);
        assert!((s.per_day.last().unwrap().cost_usd - 0.25).abs() < 1e-9);
        assert_eq!(s.per_lead[0].label, "Runner");
        assert_eq!(s.per_lead[1].key, "");
        let maya = s.per_person.iter().find(|p| p.key == "Maya").unwrap();
        assert_eq!((maya.turns, maya.cost_usd), (2, 0.5));
        assert_eq!(s.per_model[0].label, "Claude Code · opus");
        assert_eq!(s.top_threads[0].thread_id, a.id);

        // A new turn changes the file length, so the cache sees it.
        turn(&r, b.id, 4, now, "Maya", Some(1.0));
        let s = cost_summary_at(&r, None, 90, now + Duration::seconds(1));
        assert!((s.total_usd - 10.75).abs() < 1e-9, "{}", s.total_usd);
    }

    #[tokio::test]
    async fn budget_refuses_turns_over_the_limit() {
        let (_d, r) = runner();
        let ws = r.create_workspace("Cuna".into(), None).unwrap();
        let cap = lead(&r, ws.id, "Runner");
        let a = thread(&r, ws.id, Some(cap.id), None).await;
        let b = thread(&r, ws.id, None, None).await;
        turn(&r, a.id, 0, Utc::now(), "Maya", Some(1.20));
        assert!(check_budget(&r, &a).is_ok());

        set_budget(&r, ws.id, BudgetScope::Lead, Some(cap.id), 1.0).unwrap();
        let err = check_budget(&r, &a).unwrap_err().to_string();
        assert_eq!(err, "Budget reached for Runner ($1.20 of $1.00 this month). Raise it in Costs.");
        // Another thread without that lead is not affected by its budget.
        assert!(check_budget(&r, &b).is_ok());

        set_budget(&r, ws.id, BudgetScope::Workspace, None, 5.0).unwrap();
        assert!(check_budget(&r, &b).is_ok());
        set_budget(&r, ws.id, BudgetScope::Workspace, None, 1.2).unwrap();
        assert!(check_budget(&r, &b).unwrap_err().to_string().starts_with("Budget reached for Cuna ($1.20 of $1.20"));

        // Zero removes; send_message goes through again.
        set_budget(&r, ws.id, BudgetScope::Workspace, None, 0.0).unwrap();
        set_budget(&r, ws.id, BudgetScope::Lead, Some(cap.id), 0.0).unwrap();
        assert!(list_budgets(&r, Some(ws.id)).is_empty());
        assert!(check_budget(&r, &a).is_ok());

        // And send_message itself refuses.
        set_budget(&r, ws.id, BudgetScope::Lead, Some(cap.id), 0.5).unwrap();
        assert!(r.send_message(a.id, "more".into(), "Maya".into()).await.is_err());
        let st = list_budgets(&r, Some(ws.id));
        assert!((st[0].spent_usd - 1.2).abs() < 1e-9);
    }

    #[test]
    fn text_checks() {
        let reply = "The answer is 42.\nDone.";
        assert!(check_text(EvalCheck::Contains, "answer IS 42", reply).unwrap().0);
        assert!(!check_text(EvalCheck::Contains, "43", reply).unwrap().0);
        assert!(check_text(EvalCheck::NotContains, "error", reply).unwrap().0);
        assert!(!check_text(EvalCheck::NotContains, "done", reply).unwrap().0);
        assert!(check_text(EvalCheck::Regex, r"\b4\d\b", reply).unwrap().0);
        assert!(!check_text(EvalCheck::Regex, r"^Done\.$", "Done!").unwrap().0);
        assert!(check_text(EvalCheck::Regex, "(", reply).is_err());
        assert!(check_text(EvalCheck::Judge, "x", reply).is_err());
    }

    #[tokio::test]
    async fn command_check_uses_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("ok.txt"), "x").unwrap();
        let (ok, _) = run_check_command("exit 0", dir.path()).await.unwrap();
        assert!(ok);
        let (ok, reason) = run_check_command("exit 3", dir.path()).await.unwrap();
        assert!(!ok);
        assert!(reason.starts_with("Exited with 3."), "{reason}");
        #[cfg(unix)]
        assert!(run_check_command("test -f ok.txt", dir.path()).await.unwrap().0);
    }

    #[test]
    fn judge_verdicts() {
        assert_eq!(parse_verdict("PASS\nIt names the file."), Some((true, "It names the file.".into())));
        assert_eq!(parse_verdict("**FAIL**: wrong port"), Some((false, "wrong port".into())));
        assert_eq!(parse_verdict("fail"), Some((false, "FAIL".into())));
        assert_eq!(parse_verdict("Maybe"), None);
    }

    #[test]
    fn brief_fallback_groups_facts() {
        let item = |kind, title: &str, detail: Option<&str>| BriefItem {
            kind,
            id: Uuid::new_v4(),
            workspace_id: None,
            workspace: Some("Cuna".into()),
            title: title.into(),
            detail: detail.map(String::from),
            thread_id: None,
            at: None,
        };
        let md = fallback_markdown(&[
            item(BriefKind::Waiting, "Magic link sign-in", None),
            item(BriefKind::Issue, "BOU-12 Drafts", Some("in_progress")),
            item(BriefKind::Issue, "BOU-9 Rail", Some("done")),
            item(BriefKind::Task, "Reply to Jonas", Some("overdue")),
        ]);
        assert_eq!(
            md,
            "**Waiting on you**\n- Magic link sign-in · Cuna\n\n**Issues**\n- BOU-12 Drafts · Cuna (in progress)\n- BOU-9 Rail · Cuna (done)\n\n**Your tasks for today**\n- Reply to Jonas · Cuna (overdue)"
        );
        assert_eq!(fallback_markdown(&[]), "Nothing happened in the last 24 hours.");
    }

    #[tokio::test]
    async fn brief_without_model_lists_facts_and_caches() {
        let (_d, r) = runner();
        let ws = r.create_workspace("Cuna".into(), None).unwrap();
        let t = thread(&r, ws.id, None, None).await;
        r.store().update_thread(t.id, |t| t.status = AgentStatus::Blocked).unwrap();
        let today = local_date(Utc::now()).format("%Y-%m-%d").to_string();
        create_task(&r, NewTask { title: "Reply to Jonas".into(), notes: None, due: Some(today.clone()), priority: None, workspace_id: None, thread_id: None }).unwrap();
        create_task(&r, NewTask { title: "Later".into(), notes: None, due: Some("2999-01-01".into()), priority: None, workspace_id: None, thread_id: None }).unwrap();

        let b = get_brief(&r, None, false).await.unwrap();
        assert!(!b.ai);
        assert_eq!(b.date, today);
        assert_eq!(b.items.iter().map(|i| i.kind).collect::<Vec<_>>(), vec![BriefKind::Waiting, BriefKind::Task]);
        assert_eq!(b.items[0].thread_id, Some(t.id));
        assert!(b.markdown.contains("**Waiting on you**"));

        // Cached for the day until asked again.
        delete_task(&r, b.items[1].id).unwrap();
        assert_eq!(get_brief(&r, None, false).await.unwrap().items.len(), 2);
        assert_eq!(get_brief(&r, None, true).await.unwrap().items.len(), 1);
    }

    #[tokio::test]
    async fn tasks_and_notes_round_trip() {
        let (_d, r) = runner();
        let mk = |title: &str| NewTask { title: title.into(), notes: None, due: None, priority: Some(TaskPriority::High), workspace_id: None, thread_id: None };
        let a = create_task(&r, mk("A")).unwrap();
        let b = create_task(&r, mk("B")).unwrap();
        assert!(create_task(&r, mk(" ")).is_err());
        let mut bad = a.clone();
        bad.due = Some("friday".into());
        assert!(update_task(&r, bad).is_err());
        let mut done = a.clone();
        done.done = true;
        assert!(update_task(&r, done).unwrap().done_at.is_some());
        reorder_tasks(&r, vec![b.id, a.id]).unwrap();
        assert_eq!(list_tasks(&r).iter().map(|t| t.id).collect::<Vec<_>>(), vec![b.id, a.id]);

        let n = save_note(&r, None, "# Groceries\n\n- milk".into()).unwrap();
        assert_eq!(n.title, "Groceries");
        assert_eq!(list_notes(&r)[0].excerpt, "milk");
        assert_eq!(get_note(&r, &n.id).unwrap().text, "# Groceries\n\n- milk");
        assert!(get_note(&r, "../tasks").is_err());
        delete_note(&r, &n.id).unwrap();
        assert!(list_notes(&r).is_empty());
    }

    #[test]
    fn replay_folds_results_into_steps() {
        let id = Uuid::new_v4();
        let t0 = Utc::now();
        let env = |seq, ms: i64, event| ThreadEnvelope { thread_id: id, seq, at: t0 + Duration::milliseconds(ms), event };
        let events = vec![
            env(0, 0, ThreadEvent::UserMessage { text: "Fix it".into(), author: "Maya".into() }),
            env(1, 10, ThreadEvent::Status { status: AgentStatus::Working }),
            env(2, 500, ThreadEvent::ToolUse { id: "a".into(), name: "Bash".into(), input: serde_json::json!({ "command": "ls" }) }),
            env(3, 1500, ThreadEvent::ToolResult { tool_use_id: "a".into(), output: "x.rs".into(), is_error: false }),
            env(4, 2000, ThreadEvent::TurnComplete { duration_ms: 2000, cost_usd: Some(0.1) }),
        ];
        let rp = replay_of(id, "T".into(), &events);
        assert_eq!(rp.steps.len(), 3);
        assert_eq!(rp.steps[1].label, "Bash ls");
        assert_eq!(rp.steps[1].output.as_deref(), Some("x.rs"));
        assert_eq!(rp.steps[1].duration_ms, Some(1000));
        assert_eq!(rp.steps[1].gap_ms, 500);
        assert_eq!(rp.steps[2].offset_ms, 2000);
        assert!((rp.total_cost - 0.1).abs() < 1e-9);
        assert_eq!(rp.total_ms, 2000);
    }
}
