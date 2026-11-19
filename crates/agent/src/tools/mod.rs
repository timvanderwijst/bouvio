//! Tools the agent can call, and the built-in set: files, search, shell, web.
//!
//! File tools are confined to the working directory: a relative path that
//! escapes it (`../`, a symlink out) is refused; an absolute path outside it is
//! allowed but counts as risky, so it needs a person's yes under `AskRisky`.

mod bash;
mod fs;
mod web;

pub use bash::Bash;
pub use fs::{EditFile, Glob, Grep, ListDir, ReadFile, WriteFile};
pub use web::{html_to_text, WebFetch};

use anyhow::{bail, Result};
use async_trait::async_trait;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub struct ToolCtx {
    pub cwd: PathBuf,
    pub cancel: CancellationToken,
}

#[async_trait]
pub trait Tool: Send + Sync {
    /// Name the model calls the tool by.
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    /// JSON Schema of the input object.
    fn schema(&self) -> serde_json::Value;
    /// Needs approval under ApprovalLevel::AskRisky (shell, network, delete, write outside cwd…).
    /// Under AskAll every tool asks; under Free none.
    fn risky(&self, input: &serde_json::Value) -> bool;
    async fn call(&self, input: serde_json::Value, ctx: &ToolCtx) -> anyhow::Result<String>;
    /// Name shown in `ThreadEvent::ToolUse`, matching what the UI knows from
    /// Claude Code (`Read`, `Bash`, …). Defaults to [`Tool::name`].
    fn display_name(&self) -> &str {
        self.name()
    }
}

/// The built-in tools for an agent working in `cwd`.
pub fn builtin(cwd: &Path) -> Vec<Arc<dyn Tool>> {
    let cwd = cwd.to_path_buf();
    vec![
        Arc::new(ReadFile { cwd: cwd.clone() }),
        Arc::new(WriteFile { cwd: cwd.clone() }),
        Arc::new(EditFile { cwd: cwd.clone() }),
        Arc::new(ListDir { cwd: cwd.clone() }),
        Arc::new(Glob { cwd: cwd.clone() }),
        Arc::new(Grep { cwd }),
        Arc::new(Bash),
        Arc::new(WebFetch),
    ]
}

/// A path resolved against the working directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    /// Absolute, with `.` and `..` removed.
    pub path: PathBuf,
    /// Inside the working directory once symlinks are followed.
    pub inside: bool,
}

/// Resolve `raw` against `cwd`. Relative paths must stay inside `cwd`; absolute
/// paths may point anywhere and report whether they do.
pub fn resolve(cwd: &Path, raw: &str) -> Result<Resolved> {
    let raw = raw.trim();
    if raw.is_empty() {
        bail!("The path is empty");
    }
    let given = Path::new(raw);
    let absolute = given.is_absolute();
    let path = normalize(&if absolute { given.to_path_buf() } else { cwd.join(given) });
    let root = std::fs::canonicalize(cwd).unwrap_or_else(|_| normalize(cwd));
    let inside = canonical_prefix(&path).starts_with(&root);
    if !absolute && !inside {
        bail!("{raw} is outside the working directory. Use paths inside it, or an absolute path if you really mean another place.");
    }
    Ok(Resolved { path, inside })
}

/// `true` when the input's path field points outside the working directory.
pub(crate) fn path_risky(cwd: &Path, input: &serde_json::Value, key: &str) -> bool {
    input[key].as_str().and_then(|p| resolve(cwd, p).ok()).is_some_and(|r| !r.inside)
}

fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !matches!(out.components().next_back(), Some(Component::RootDir | Component::Prefix(_)) | None) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Canonicalize the longest existing ancestor (following symlinks) and append the rest.
fn canonical_prefix(p: &Path) -> PathBuf {
    let mut existing = p.to_path_buf();
    let mut rest = Vec::new();
    loop {
        if let Ok(c) = std::fs::canonicalize(&existing) {
            let mut out = c;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (existing.file_name().map(|f| f.to_os_string()), existing.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent.to_path_buf();
            }
            _ => return p.to_path_buf(),
        }
    }
}

/// Path as shown to the model: relative to `cwd` when inside it.
pub(crate) fn show(cwd: &Path, p: &Path) -> String {
    let root = normalize(cwd);
    match p.strip_prefix(&root) {
        Ok(rel) if !rel.as_os_str().is_empty() => rel.to_string_lossy().replace('\\', "/"),
        Ok(_) => ".".into(),
        Err(_) => p.display().to_string(),
    }
}

/// Keep the head and tail of a long output.
pub(crate) fn truncate_middle(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    let half = max / 2;
    let head: String = s.chars().take(half).collect();
    let tail: String = s.chars().skip(n - half).collect();
    format!("{head}\n\n… [{} characters cut] …\n\n{tail}", n - 2 * half)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confines_relative_paths() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path();
        let r = resolve(cwd, "src/../a.txt").unwrap();
        assert!(r.inside);
        assert_eq!(r.path, normalize(&cwd.join("a.txt")));
        assert!(resolve(cwd, "../escape.txt").is_err());
        assert!(resolve(cwd, "a/../../escape.txt").is_err());
        assert!(resolve(cwd, "").is_err());
    }

    #[test]
    fn absolute_paths_outside_are_risky() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("proj");
        std::fs::create_dir_all(&cwd).unwrap();
        let outside = dir.path().join("other.txt");
        let r = resolve(&cwd, outside.to_str().unwrap()).unwrap();
        assert!(!r.inside);
        let inside = cwd.join("x/y.txt");
        assert!(resolve(&cwd, inside.to_str().unwrap()).unwrap().inside);
        let input = serde_json::json!({ "file_path": outside.to_str().unwrap() });
        assert!(path_risky(&cwd, &input, "file_path"));
        assert!(!path_risky(&cwd, &serde_json::json!({ "file_path": "a.txt" }), "file_path"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_out_of_cwd_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("proj");
        let secret = dir.path().join("secret");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&secret).unwrap();
        std::os::unix::fs::symlink(&secret, cwd.join("link")).unwrap();
        assert!(resolve(&cwd, "link/key.txt").is_err());
    }

    #[test]
    fn truncates_in_the_middle() {
        let s = "a".repeat(50) + &"b".repeat(50);
        let t = truncate_middle(&s, 20);
        assert!(t.starts_with("aaaaaaaaaa\n"));
        assert!(t.ends_with("\nbbbbbbbbbb"));
        assert!(t.contains("80 characters cut"));
        assert_eq!(truncate_middle("short", 20), "short");
    }
}
