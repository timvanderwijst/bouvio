//! Git helpers: worktrees per thread and diffs for the review panel.

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use tokio::process::Command;

async fn git(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .await
        .context("run git")?;
    if !out.status.success() {
        bail!("git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub async fn is_repo(dir: &Path) -> bool {
    git(dir, &["rev-parse", "--is-inside-work-tree"]).await.map(|s| s.trim() == "true").unwrap_or(false)
}

pub async fn current_branch(dir: &Path) -> Option<String> {
    git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).await.ok().map(|s| s.trim().to_string())
}

/// Create `branch` in a new worktree under `base`, starting from HEAD of `repo`.
pub async fn add_worktree(repo: &Path, base: &Path, branch: &str) -> Result<PathBuf> {
    let name = branch.replace('/', "-");
    let path = base.join(name);
    std::fs::create_dir_all(base)?;
    let p = path.to_string_lossy().into_owned();
    git(repo, &["worktree", "add", "-b", branch, &p, "HEAD"]).await?;
    Ok(path)
}

/// Everything changed in `dir` against HEAD, untracked files included.
pub async fn diff(dir: &Path) -> Result<String> {
    // Intent-to-add makes new files show up in `git diff` without staging content.
    let untracked = git(dir, &["ls-files", "--others", "--exclude-standard"]).await?;
    let files: Vec<&str> = untracked.lines().filter(|l| !l.is_empty()).collect();
    if !files.is_empty() {
        let mut args = vec!["add", "--intent-to-add", "--"];
        args.extend(files);
        git(dir, &args).await?;
    }
    match git(dir, &["diff", "HEAD", "--no-color", "--no-ext-diff"]).await {
        Ok(d) => Ok(d),
        // A repo without commits has no HEAD yet.
        Err(_) => git(dir, &["diff", "--no-color", "--no-ext-diff"]).await,
    }
}
