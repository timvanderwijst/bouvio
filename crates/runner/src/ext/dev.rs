//! Developer tools: review comments, CI runs, database viewer, API client, git graph, element-picker proxy.
//!
//! Data lives under `<data>/dev`: `reviews/<thread>.json` and `<workspace>/{db,api}.json`.

mod api;
mod ci;
mod db;
mod graph;
mod proxy;
mod review;

pub use proxy::{inject as inject_picker, PICKER_JS};

use crate::Runner;
use anyhow::{bail, Context, Result};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::process::Command;
use uuid::Uuid;

fn p<T: DeserializeOwned>(params: &Value, key: &str) -> Result<T> {
    serde_json::from_value(params.get(key).cloned().unwrap_or(Value::Null)).with_context(|| format!("param `{key}`"))
}

fn opt<T: DeserializeOwned>(params: &Value, key: &str) -> Option<T> {
    params.get(key).cloned().filter(|v| !v.is_null()).and_then(|v| serde_json::from_value(v).ok())
}

fn ok<T: serde::Serialize>(v: T) -> Result<Value> {
    Ok(serde_json::to_value(v)?)
}

pub(crate) async fn run(cwd: &Path, prog: &str, args: &[&str]) -> Result<String> {
    let out = Command::new(prog)
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .with_context(|| format!("run {prog}; is it installed?"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        bail!("{prog} {}: {}", args.first().unwrap_or(&""), err.trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub(crate) fn root(r: &Runner, ws: Uuid) -> Result<PathBuf> {
    let w = r.workspace(ws).context("unknown workspace")?;
    Ok(w.root.context("this workspace has no folder")?.into())
}

pub(crate) fn dev_dir(r: &Runner, ws: Uuid) -> PathBuf {
    r.store().dir().join("dev").join(ws.to_string())
}

pub(crate) fn valid_sha(s: &str) -> bool {
    (4..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// A branch name we can pass to git without it reading as an option.
pub(crate) fn valid_branch(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && !s.contains("..") && s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+".contains(c))
}

/// The workspace a DB call works in: the one named, or the connection's own.
fn db_ws(r: &Runner, params: &Value) -> Result<(Uuid, Uuid)> {
    let conn: Uuid = p(params, "conn")?;
    let ws = opt::<Uuid>(params, "workspace_id").or_else(|| db::workspace_of(r, conn)).context("unknown connection")?;
    Ok((ws, conn))
}

fn w(params: &Value) -> Result<Uuid> {
    p(params, "workspace_id")
}

fn th(params: &Value) -> Result<Uuid> {
    p(params, "thread_id")
}

pub async fn call(r: &Arc<Runner>, method: &str, params: &Value, actor: &str) -> Option<Result<Value>> {
    const MINE: &[&str] = &[
        "dev_proxy", "stop_dev_proxy", "add_review_comment", "list_review_comments", "resolve_review_comment", "delete_review_comment", "ci_runs", "get_ci_log",
        "fix_ci_run", "list_db_connections", "save_db_connection", "delete_db_connection", "list_db_tables", "get_db_rows", "run_db_query", "http_request",
        "list_api_requests", "save_api_request", "delete_api_request", "save_api_environments", "clear_api_history", "git_graph", "get_commit",
    ];
    if !MINE.contains(&method) {
        return None;
    }
    Some(dispatch(r, method, params, actor).await)
}

fn dispatch<'a>(r: &'a Arc<Runner>, method: &'a str, params: &'a Value, actor: &'a str) -> futures::future::BoxFuture<'a, Result<Value>> {
    Box::pin(async move { match method {
        // element picker
        "dev_proxy" => ok(proxy::dev_proxy(r, th(params)?).await?),
        "stop_dev_proxy" => {
            proxy::stop(th(params)?);
            ok(())
        }

        // review
        "add_review_comment" => ok(review::add(r, th(params)?, p(params, "path")?, p(params, "line")?, p(params, "side")?, p(params, "text")?, actor).await?),
        "list_review_comments" => ok(review::list(r, th(params)?).await?),
        "resolve_review_comment" => ok(review::resolve(r, p(params, "id")?, opt(params, "resolved").unwrap_or(true))?),
        "delete_review_comment" => ok(review::delete(r, p(params, "id")?)?),

        // checks
        "ci_runs" => ok(ci::ci_runs(r, w(params)?).await?),
        "get_ci_log" => ok(ci::get_ci_log(r, w(params)?, p(params, "run_id")?).await?),
        "fix_ci_run" => ok(ci::fix_ci_run(r, w(params)?, p(params, "run_id")?, actor).await?),

        // data
        "list_db_connections" => ok(db::list(r, w(params)?)),
        "save_db_connection" => ok(db::save(r, w(params)?, p(params, "connection")?)?),
        "delete_db_connection" => ok(db::delete(r, w(params)?, p(params, "id")?)?),
        "list_db_tables" => {
            let (ws, conn) = db_ws(r, params)?;
            ok(db::tables(r, ws, conn).await?)
        }
        "get_db_rows" => {
            let (ws, conn) = db_ws(r, params)?;
            let table: String = p(params, "table")?;
            let (limit, offset, order) = (opt(params, "limit").unwrap_or(100), opt(params, "offset").unwrap_or(0), opt(params, "order"));
            ok(db::rows(r, ws, conn, &table, limit, offset, order).await?)
        }
        "run_db_query" => {
            let (ws, conn) = db_ws(r, params)?;
            let sql: String = p(params, "sql")?;
            ok(db::query(r, ws, conn, &sql).await?)
        }

        // API client
        "http_request" => {
            let req = api::Outgoing {
                method: opt(params, "method").unwrap_or_else(|| "GET".into()),
                url: p(params, "url")?,
                headers: opt(params, "headers").unwrap_or_default(),
                body: opt(params, "body").unwrap_or_default(),
                timeout_ms: opt(params, "timeout_ms"),
            };
            ok(api::http_request(r, opt(params, "workspace_id"), opt(params, "env_id"), req, opt(params, "name")).await?)
        }
        "list_api_requests" => ok(api::load(r, w(params)?)),
        "save_api_request" => ok(api::save_request(r, w(params)?, p(params, "request")?)?),
        "delete_api_request" => ok(api::delete_request(r, w(params)?, p(params, "id")?)?),
        "save_api_environments" => ok(api::save_environments(r, w(params)?, p(params, "environments")?, opt(params, "active_env"))?),
        "clear_api_history" => ok(api::clear_history(r, w(params)?)?),

        // git
        "git_graph" => {
            let root = root(r, w(params)?)?;
            ok(graph::git_graph(&root, opt(params, "limit").unwrap_or(300)).await?)
        }
        "get_commit" => {
            let root = root(r, w(params)?)?;
            let sha: String = p(params, "sha")?;
            ok(graph::get_commit(&root, &sha).await?)
        }
        m => bail!("unknown method `{m}`"),
    } })
}

pub fn workspace_of(r: &Runner, method: &str, params: &Value) -> Option<Result<Uuid>> {
    match method {
        "resolve_review_comment" | "delete_review_comment" => {
            let id: Uuid = match p(params, "id") {
                Ok(id) => id,
                Err(e) => return Some(Err(e)),
            };
            Some(review::thread_of(r, id).and_then(|t| r.thread(t)).map(|t| t.workspace_id).context("unknown comment"))
        }
        "list_db_tables" | "get_db_rows" | "run_db_query" => Some(db_ws(r, params).map(|(w, _)| w)),
        _ => None,
    }
}

pub fn start(_r: &Arc<Runner>) {}

#[cfg(test)]
mod tests {
    use super::*;
    use bouvio_protocol::dev::*;
    use bouvio_protocol::*;
    use serde_json::json;

    #[tokio::test]
    async fn review_through_the_dispatcher() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let sh = |args: &[&str]| assert!(std::process::Command::new("git").arg("-C").arg(&repo).args(args).status().unwrap().success());
        sh(&["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
        sh(&["add", "."]);
        sh(&["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);

        let r = Runner::open(dir.path().join("data")).unwrap();
        let ws = r.create_workspace("Repo".into(), Some(repo.to_string_lossy().into())).unwrap();
        let t = r
            .create_thread(NewThread {
                workspace_id: ws.id,
                lead_id: None,
                title: Some("x".into()),
                harness: HarnessKind::ClaudeCode,
                model: None,
                effort: Effort::Medium,
                approval: ApprovalLevel::AskRisky,
                isolate: false,
            })
            .await
            .unwrap();
        std::fs::write(repo.join("a.txt"), "one\nTWO\n").unwrap();

        let c: ReviewComment = serde_json::from_value(
            r.call("add_review_comment", json!({ "thread_id": t.id, "path": "a.txt", "line": 2, "side": "new", "text": "why caps?" }), "Jonas").await.unwrap(),
        )
        .unwrap();
        assert_eq!(c.author, "Jonas");
        assert_eq!(c.line_text, "TWO");
        // A line that is not in the diff is refused.
        assert!(r.call("add_review_comment", json!({ "thread_id": t.id, "path": "a.txt", "line": 9, "side": "new", "text": "?" }), "Jonas").await.is_err());

        // The agent adds a line on top: the comment follows.
        std::fs::write(repo.join("a.txt"), "zero\none\nTWO\n").unwrap();
        let list: Vec<ReviewComment> = serde_json::from_value(r.call("list_review_comments", json!({ "thread_id": t.id }), "Jonas").await.unwrap()).unwrap();
        assert_eq!((list[0].line, list[0].outdated), (3, false));

        // Scoped calls find the comment's workspace by its id.
        assert!(r.call_scoped(ws.id, "resolve_review_comment", json!({ "id": c.id }), "Jonas").await.is_ok());
        assert!(r.call_scoped(Uuid::new_v4(), "resolve_review_comment", json!({ "id": c.id }), "Jonas").await.is_err());

        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
        let list: Vec<ReviewComment> = serde_json::from_value(r.call("list_review_comments", json!({ "thread_id": t.id }), "Jonas").await.unwrap()).unwrap();
        assert!(list[0].resolved);

        // Git graph and commit details on the same repo.
        let g: GitGraph = serde_json::from_value(r.call("git_graph", json!({ "workspace_id": ws.id }), "Jonas").await.unwrap()).unwrap();
        assert_eq!(g.commits.len(), 1);
        assert_eq!(g.commits[0].refs, ["HEAD", "main"]);
        let d: CommitDetail = serde_json::from_value(r.call("get_commit", json!({ "workspace_id": ws.id, "sha": g.commits[0].sha }), "Jonas").await.unwrap()).unwrap();
        assert_eq!(d.subject, "init");
        assert_eq!(d.files[0].path, "a.txt");
        assert!(r.call("get_commit", json!({ "workspace_id": ws.id, "sha": "--output=/tmp/x" }), "Jonas").await.is_err());
    }

    #[test]
    fn branch_names() {
        assert!(valid_branch("bouvio/3f9a2c1e"));
        assert!(!valid_branch("--upload-pack=x"));
        assert!(!valid_branch("a b"));
    }
}
