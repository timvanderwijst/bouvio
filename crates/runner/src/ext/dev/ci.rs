//! Checks: GitHub Actions runs through `gh`, with the user's own login.

use super::{root, run};
use crate::Runner;
use anyhow::{Context, Result};
use bouvio_protocol::dev::*;
use bouvio_protocol::*;
use serde::Deserialize;
use std::path::Path;
use std::sync::Arc;
use uuid::Uuid;

const LOG_CAP: usize = 200 * 1024;
/// How much of a failing log goes into an agent's prompt.
const PROMPT_LOG: usize = 40 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhRun {
    database_id: u64,
    #[serde(default)]
    display_title: String,
    #[serde(default)]
    head_branch: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: String,
    #[serde(default)]
    event: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    workflow_name: String,
}

/// Parse `gh run list --json …` and match each run to the thread on its branch.
pub fn parse_runs(raw: &str, threads: &[Thread]) -> Result<Vec<CiRun>> {
    let runs: Vec<GhRun> = serde_json::from_str(raw).context("read gh output")?;
    Ok(runs
        .into_iter()
        .map(|r| CiRun {
            id: r.database_id,
            thread_id: thread_on(threads, &r.head_branch),
            title: r.display_title,
            workflow: r.workflow_name,
            branch: r.head_branch,
            status: r.status.to_lowercase(),
            conclusion: Some(r.conclusion.to_lowercase()).filter(|c| !c.is_empty()),
            event: r.event,
            created_at: r.created_at,
            url: r.url,
        })
        .collect())
}

/// The thread working on `branch`: the newest one, isolated threads first.
fn thread_on(threads: &[Thread], branch: &str) -> Option<Uuid> {
    if branch.is_empty() {
        return None;
    }
    let mut v: Vec<&Thread> = threads.iter().filter(|t| t.branch.as_deref() == Some(branch)).collect();
    v.sort_by_key(|t| (!t.branch.as_deref().is_some_and(|b| b.starts_with("bouvio/")), std::cmp::Reverse(t.updated_at)));
    v.first().map(|t| t.id)
}

pub async fn ci_runs(r: &Runner, ws: Uuid) -> Result<Vec<CiRun>> {
    let root = root(r, ws)?;
    let raw = run(&root, "gh", &["run", "list", "--limit", "40", "--json", "databaseId,displayTitle,headBranch,status,conclusion,event,createdAt,url,workflowName"]).await?;
    parse_runs(&raw, &r.threads(ws))
}

pub fn cap_log(mut text: String, cap: usize) -> CiLog {
    let truncated = text.len() > cap;
    if truncated {
        // Keep the end: that is where the failure is.
        let mut start = text.len() - cap;
        while !text.is_char_boundary(start) {
            start += 1;
        }
        text = text[start..].to_string();
    }
    CiLog { text, truncated }
}

pub async fn get_ci_log(r: &Runner, ws: Uuid, run_id: u64) -> Result<CiLog> {
    let root = root(r, ws)?;
    let id = run_id.to_string();
    let mut text = run(&root, "gh", &["run", "view", &id, "--log-failed"]).await?;
    if text.trim().is_empty() {
        text = run(&root, "gh", &["run", "view", &id, "--log"]).await.unwrap_or_default();
    }
    Ok(cap_log(text, LOG_CAP))
}

async fn git_ok(dir: &Path, args: &[&str]) -> bool {
    run(dir, "git", args).await.is_ok()
}

/// Hand a failing run to an agent: a thread on the run's branch with the log as its brief.
pub async fn fix_ci_run(r: &Arc<Runner>, ws: Uuid, run_id: u64, actor: &str) -> Result<Thread> {
    let root = root(r, ws)?;
    let id = run_id.to_string();
    let meta = run(&root, "gh", &["run", "view", &id, "--json", "headBranch,displayTitle,workflowName,url"]).await?;
    let meta: serde_json::Value = serde_json::from_str(&meta)?;
    let branch = meta["headBranch"].as_str().unwrap_or("").to_string();
    let title = meta["displayTitle"].as_str().unwrap_or("").to_string();
    let workflow = meta["workflowName"].as_str().unwrap_or("CI").to_string();
    let log = get_ci_log(r, ws, run_id).await?;
    let log = cap_log(log.text, PROMPT_LOG);

    let owner = r.threads(ws).into_iter().find(|t| t.branch.as_deref() == Some(branch.as_str()) && t.cwd.is_some());
    let captain = owner.as_ref().and_then(|t| t.captain_id).and_then(|c| r.store().captain(c));
    let t = r
        .create_thread(NewThread {
            workspace_id: ws,
            captain_id: captain.as_ref().map(|c| c.id),
            title: Some(format!("Fix {workflow} on {}", if branch.is_empty() { "main" } else { &branch })),
            harness: owner.as_ref().map(|t| t.harness).or(captain.as_ref().map(|c| c.harness)).unwrap_or(HarnessKind::ClaudeCode),
            model: owner.as_ref().and_then(|t| t.model.clone()),
            effort: owner.as_ref().map(|t| t.effort).unwrap_or(Effort::Medium),
            approval: owner.as_ref().map(|t| t.approval).unwrap_or(ApprovalLevel::AskRisky),
            isolate: false,
        })
        .await?;

    // Work where the branch lives: the thread that owns it, or a new worktree of it.
    let place = if let Some(o) = &owner {
        o.cwd.clone().map(|c| (c, branch.clone()))
    } else if !branch.is_empty() && super::valid_branch(&branch) {
        let dir = r.store().dir().join("worktrees").join(ws.to_string()).join(format!("ci-{}", &t.id.simple().to_string()[..8]));
        let p = dir.to_string_lossy().into_owned();
        std::fs::create_dir_all(dir.parent().unwrap_or(&dir)).ok();
        let fetched = git_ok(&root, &["fetch", "-q", "origin", &branch]).await;
        let ok = git_ok(&root, &["worktree", "add", &p, &branch]).await
            || (fetched && git_ok(&root, &["worktree", "add", "--track", "-b", &branch, &p, &format!("origin/{branch}")]).await);
        ok.then(|| (p, branch.clone()))
    } else {
        None
    };
    let t = match place {
        Some((cwd, b)) => r.store().update_thread(t.id, |t| {
            t.cwd = Some(cwd);
            t.branch = Some(b);
        })?.unwrap_or(t),
        None => t,
    };
    let _ = r.threads.send(t.clone());

    let url = meta["url"].as_str().unwrap_or("");
    let mut prompt = format!("The GitHub Actions run \"{title}\" ({workflow}) failed on branch `{branch}`. {url}\n\nFind the cause, fix it, and run the failing check locally if you can.\n\nFailing log");
    if log.truncated {
        prompt.push_str(" (last 40 kB)");
    }
    prompt.push_str(&format!(":\n\n```\n{}\n```", log.text.trim()));
    r.send_message(t.id, prompt, actor.to_string()).await?;
    Ok(t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    const FIXTURE: &str = r#"[
      {"conclusion":"failure","createdAt":"2026-11-19T21:04:11Z","databaseId":12001,"displayTitle":"Keep a draft per thread","event":"push","headBranch":"bouvio/3f9a2c1e","status":"completed","url":"https://github.com/o/r/actions/runs/12001","workflowName":"CI"},
      {"conclusion":"","createdAt":"2026-11-19T21:10:00Z","databaseId":12002,"displayTitle":"Bump deps","event":"pull_request","headBranch":"renovate/deps","status":"in_progress","url":"https://github.com/o/r/actions/runs/12002","workflowName":"CI"},
      {"conclusion":"success","createdAt":"2026-11-19T20:00:00Z","databaseId":11990,"displayTitle":"Release","event":"push","headBranch":"main","status":"completed","url":"u","workflowName":"Release"}
    ]"#;

    fn thread(branch: &str) -> Thread {
        Thread {
            id: Uuid::new_v4(),
            workspace_id: Uuid::nil(),
            captain_id: None,
            title: "t".into(),
            harness: HarnessKind::ClaudeCode,
            model: None,
            effort: Effort::Medium,
            approval: ApprovalLevel::AskRisky,
            status: AgentStatus::Idle,
            cwd: None,
            branch: Some(branch.into()),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            cost_usd: 0.0,
            session_id: None,
        }
    }

    #[test]
    fn parses_gh_runs_and_matches_threads() {
        let draft = thread("bouvio/3f9a2c1e");
        let v = parse_runs(FIXTURE, &[draft.clone(), thread("other")]).unwrap();
        assert_eq!(v.len(), 3);
        assert_eq!(v[0].id, 12001);
        assert_eq!(v[0].conclusion.as_deref(), Some("failure"));
        assert_eq!(v[0].thread_id, Some(draft.id));
        assert_eq!(v[1].conclusion, None);
        assert_eq!(v[1].status, "in_progress");
        assert_eq!(v[1].thread_id, None);
        assert_eq!(v[2].workflow, "Release");
    }

    #[test]
    fn rejects_non_json() {
        assert!(parse_runs("gh: not logged in", &[]).is_err());
    }

    #[test]
    fn log_keeps_the_tail() {
        let l = cap_log("é".repeat(10) + "END", 8);
        assert!(l.truncated);
        assert!(l.text.ends_with("END"));
        assert!(l.text.len() <= 8);
    }
}
