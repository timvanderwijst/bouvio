//! Work around threads: issues (own tracker + GitHub), pull requests through
//! `gh`, commits, and scheduled automations.

use crate::{title_from, Runner};
use anyhow::{bail, Context, Result};
use bouvio_protocol::*;
use chrono::{Local, Utc};
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Command;
use uuid::Uuid;

async fn run(cwd: &Path, prog: &str, args: &[&str]) -> Result<String> {
    let out = Command::new(prog).args(args).current_dir(cwd).output().await.with_context(|| format!("run {prog}; is it installed?"))?;
    if !out.status.success() {
        bail!("{prog} {}: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

impl Runner {
    fn root(&self, workspace_id: Uuid) -> Result<std::path::PathBuf> {
        let ws = self.workspace(workspace_id).context("unknown workspace")?;
        Ok(ws.root.context("this workspace has no folder")?.into())
    }

    // ---- issues ------------------------------------------------------------------

    pub fn list_issues(&self, workspace_id: Uuid) -> Vec<Issue> {
        let mut v = self.issues.filter(|i| i.workspace_id == workspace_id);
        v.sort_by(|a, b| b.number.cmp(&a.number));
        v
    }

    pub fn create_issue(&self, workspace_id: Uuid, title: String, body: String, status: Option<IssueStatus>, captain_id: Option<Uuid>) -> Result<Issue> {
        let prefix = self.settings(workspace_id).issue_prefix;
        let number = self.issues.filter(|i| i.workspace_id == workspace_id).iter().map(|i| i.number).max().unwrap_or(0) + 1;
        let now = Utc::now();
        let issue = Issue {
            id: Uuid::new_v4(),
            workspace_id,
            number,
            key: format!("{prefix}-{number}"),
            title,
            body,
            status: status.unwrap_or(IssueStatus::Todo),
            assignee: None,
            captain_id,
            thread_ids: vec![],
            github_number: None,
            created_at: now,
            updated_at: now,
        };
        self.issues.put(issue.clone(), |i| i.id)?;
        self.notice(workspace_id, "issue-changed", &issue);
        Ok(issue)
    }

    pub fn update_issue(&self, mut issue: Issue) -> Result<Issue> {
        let old = self.issues.find(|i| i.id == issue.id).context("unknown issue")?;
        issue.workspace_id = old.workspace_id;
        issue.key = old.key;
        issue.number = old.number;
        issue.updated_at = Utc::now();
        self.issues.put(issue.clone(), |i| i.id)?;
        self.notice(issue.workspace_id, "issue-changed", &issue);
        Ok(issue)
    }

    pub fn delete_issue(&self, id: Uuid) -> Result<()> {
        if let Some(i) = self.issues.find(|i| i.id == id) {
            self.issues.remove(|x| x.id == id)?;
            self.notice(i.workspace_id, "issue-deleted", serde_json::json!({ "id": id }));
        }
        Ok(())
    }

    /// Hand an issue to an agent: a new thread with the issue as its brief.
    pub async fn start_issue(self: &Arc<Self>, issue_id: Uuid, captain_id: Option<Uuid>, author: String) -> Result<Thread> {
        let issue = self.issues.find(|i| i.id == issue_id).context("unknown issue")?;
        let captain = captain_id.or(issue.captain_id).and_then(|c| self.store().captain(c));
        let t = self
            .create_thread(NewThread {
                workspace_id: issue.workspace_id,
                captain_id: captain.as_ref().map(|c| c.id),
                title: Some(format!("{} {}", issue.key, issue.title)),
                harness: captain.as_ref().map(|c| c.harness).unwrap_or(HarnessKind::ClaudeCode),
                model: captain.as_ref().and_then(|c| c.model.clone()),
                effort: captain.as_ref().map(|c| c.effort).unwrap_or(Effort::Medium),
                approval: captain.as_ref().map(|c| c.approval).unwrap_or(ApprovalLevel::AskRisky),
                isolate: true,
            })
            .await?;
        self.issues.update(
            |i| i.id == issue_id,
            |i| {
                i.thread_ids.push(t.id);
                i.status = IssueStatus::InProgress;
                i.updated_at = Utc::now();
            },
        )?;
        if let Some(i) = self.issues.find(|i| i.id == issue_id) {
            self.notice(i.workspace_id, "issue-changed", &i);
        }
        let prompt = format!("Work on {}: {}\n\n{}", issue.key, issue.title, issue.body);
        self.send_message(t.id, prompt, author).await?;
        Ok(t)
    }

    /// Two-way sync with GitHub Issues through the `gh` CLI (uses the user's own login).
    pub async fn sync_github_issues(&self, workspace_id: Uuid) -> Result<usize> {
        let repo = self.settings(workspace_id).github_repo.context("set the GitHub repo in workspace settings")?;
        let root = self.root(workspace_id)?;
        let raw = run(&root, "gh", &["issue", "list", "--repo", &repo, "--state", "all", "--limit", "200", "--json", "number,title,body,state"]).await?;
        let remote: Vec<Value> = serde_json::from_str(&raw)?;
        let mut changed = 0;
        for r in &remote {
            let n = r["number"].as_u64().unwrap_or(0) as u32;
            let status = if r["state"] == "CLOSED" { IssueStatus::Done } else { IssueStatus::Todo };
            match self.issues.find(|i| i.workspace_id == workspace_id && i.github_number == Some(n)) {
                Some(mut i) => {
                    let closed = status == IssueStatus::Done;
                    if closed && i.status != IssueStatus::Done {
                        i.status = IssueStatus::Done;
                        self.update_issue(i)?;
                        changed += 1;
                    }
                }
                None => {
                    let mut i = self.create_issue(workspace_id, r["title"].as_str().unwrap_or("").into(), r["body"].as_str().unwrap_or("").into(), Some(status), None)?;
                    i.github_number = Some(n);
                    self.update_issue(i)?;
                    changed += 1;
                }
            }
        }
        // Local issues without a GitHub twin are created there.
        for i in self.issues.filter(|i| i.workspace_id == workspace_id && i.github_number.is_none() && i.status != IssueStatus::Canceled) {
            let url = run(&root, "gh", &["issue", "create", "--repo", &repo, "--title", &i.title, "--body", if i.body.is_empty() { " " } else { &i.body }]).await?;
            if let Some(n) = url.trim().rsplit('/').next().and_then(|n| n.parse().ok()) {
                let mut i = i.clone();
                i.github_number = Some(n);
                self.update_issue(i)?;
                changed += 1;
            }
        }
        Ok(changed)
    }

    // ---- git: commits and pull requests -----------------------------------------------

    pub async fn commit_thread(&self, thread_id: Uuid, message: String) -> Result<String> {
        let t = self.thread(thread_id).context("unknown thread")?;
        let cwd = std::path::PathBuf::from(t.cwd.context("thread has no folder")?);
        run(&cwd, "git", &["add", "-A"]).await?;
        let msg = if message.trim().is_empty() { t.title.clone() } else { message };
        run(&cwd, "git", &["commit", "-m", &msg]).await?;
        run(&cwd, "git", &["rev-parse", "--short", "HEAD"]).await.map(|s| s.trim().to_string())
    }

    pub async fn list_pull_requests(&self, workspace_id: Uuid) -> Result<Vec<PullRequest>> {
        let root = self.root(workspace_id)?;
        let raw = run(&root, "gh", &["pr", "list", "--state", "all", "--limit", "50", "--json", "number,title,url,headRefName,baseRefName,state,isDraft,author,additions,deletions,updatedAt"]).await?;
        let v: Vec<Value> = serde_json::from_str(&raw)?;
        Ok(v.iter()
            .map(|p| PullRequest {
                number: p["number"].as_u64().unwrap_or(0) as u32,
                title: p["title"].as_str().unwrap_or("").into(),
                url: p["url"].as_str().unwrap_or("").into(),
                head: p["headRefName"].as_str().unwrap_or("").into(),
                base: p["baseRefName"].as_str().unwrap_or("").into(),
                state: p["state"].as_str().unwrap_or("").to_lowercase(),
                draft: p["isDraft"].as_bool().unwrap_or(false),
                author: p["author"]["login"].as_str().unwrap_or("").into(),
                additions: p["additions"].as_u64().unwrap_or(0) as u32,
                deletions: p["deletions"].as_u64().unwrap_or(0) as u32,
                updated_at: p["updatedAt"].as_str().unwrap_or("").into(),
            })
            .collect())
    }

    /// Commit what is left, push the thread's branch and open a PR for it.
    pub async fn create_pull_request(&self, thread_id: Uuid, title: Option<String>) -> Result<String> {
        let t = self.thread(thread_id).context("unknown thread")?;
        let branch = t.branch.clone().context("thread has no branch")?;
        let cwd = std::path::PathBuf::from(t.cwd.clone().context("thread has no folder")?);
        if !run(&cwd, "git", &["status", "--porcelain"]).await?.trim().is_empty() {
            self.commit_thread(thread_id, t.title.clone()).await?;
        }
        run(&cwd, "git", &["push", "-u", "origin", &branch]).await?;
        let title = title.unwrap_or(t.title);
        let body = "Opened from Bouvio.";
        let url = run(&cwd, "gh", &["pr", "create", "--head", &branch, "--title", &title, "--body", body]).await?;
        self.notice(t.workspace_id, "pull-requests-changed", serde_json::json!({}));
        Ok(url.trim().to_string())
    }

    pub async fn merge_pull_request(&self, workspace_id: Uuid, number: u32) -> Result<()> {
        let root = self.root(workspace_id)?;
        run(&root, "gh", &["pr", "merge", &number.to_string(), "--squash", "--delete-branch"]).await?;
        self.notice(workspace_id, "pull-requests-changed", serde_json::json!({}));
        Ok(())
    }

    // ---- automations ---------------------------------------------------------------------

    pub fn list_automations(&self, workspace_id: Uuid) -> Vec<Automation> {
        self.automations.filter(|a| a.workspace_id == workspace_id)
    }

    pub fn save_automation(&self, mut a: Automation) -> Result<Automation> {
        croner::Cron::new(&a.schedule).parse().map_err(|e| anyhow::anyhow!("schedule: {e}"))?;
        if a.id.is_nil() {
            a.id = Uuid::new_v4();
        }
        self.automations.put(a.clone(), |x| x.id)?;
        self.notice(a.workspace_id, "automation-changed", &a);
        Ok(a)
    }

    pub fn delete_automation(&self, id: Uuid) -> Result<()> {
        if let Some(a) = self.automations.find(|a| a.id == id) {
            self.automations.remove(|x| x.id == id)?;
            self.notice(a.workspace_id, "automation-deleted", serde_json::json!({ "id": id }));
        }
        Ok(())
    }

    pub async fn run_automation(self: &Arc<Self>, id: Uuid) -> Result<Thread> {
        let a = self.automations.find(|a| a.id == id).context("unknown automation")?;
        let captain = a.captain_id.and_then(|c| self.store().captain(c));
        let t = self
            .create_thread(NewThread {
                workspace_id: a.workspace_id,
                captain_id: captain.as_ref().map(|c| c.id),
                title: Some(format!("{} · {}", a.name, Local::now().format("%d %b %H:%M"))),
                harness: captain.as_ref().map(|c| c.harness).unwrap_or(HarnessKind::ClaudeCode),
                model: captain.as_ref().and_then(|c| c.model.clone()),
                effort: captain.as_ref().map(|c| c.effort).unwrap_or(Effort::Medium),
                approval: captain.as_ref().map(|c| c.approval).unwrap_or(ApprovalLevel::AskRisky),
                isolate: false,
            })
            .await?;
        let updated = self.automations.update(
            |x| x.id == id,
            |x| {
                x.last_run = Some(Utc::now());
                x.last_thread = Some(t.id);
            },
        )?;
        if let Some(a) = updated {
            self.notice(a.workspace_id, "automation-changed", &a);
        }
        self.send_message(t.id, a.prompt.clone(), a.name.clone()).await?;
        Ok(t)
    }
}

/// Check every 20 s which automations are due; local time, like cron.
pub fn spawn_scheduler(runner: Arc<Runner>) {
    tokio::spawn(async move {
        let mut last = Local::now();
        loop {
            tokio::time::sleep(Duration::from_secs(20)).await;
            let now = Local::now();
            for a in runner.automations.filter(|a| a.enabled) {
                let Ok(cron) = croner::Cron::new(&a.schedule).parse() else { continue };
                // Due when a scheduled moment fell between the previous check and now.
                if let Ok(next) = cron.find_next_occurrence(&last, false) {
                    if next <= now {
                        let r = runner.clone();
                        tokio::spawn(async move {
                            if let Err(e) = r.run_automation(a.id).await {
                                tracing::warn!("automation {}: {e:#}", a.name);
                            }
                        });
                    }
                }
            }
            last = now;
        }
    });
}

pub(crate) fn short_title(s: &str) -> String {
    title_from(s)
}
