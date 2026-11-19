//! File tools: read, write, edit, list, glob, grep.

use super::{path_risky, resolve, show, Tool, ToolCtx};
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const MAX_LINE: usize = 2000;
const MAX_OUTPUT: usize = 100_000;

fn str_arg<'a>(input: &'a Value, key: &str) -> Result<&'a str> {
    input[key].as_str().ok_or_else(|| anyhow!("Missing string field `{key}`"))
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(8000)].contains(&0)
}

fn clip_line(line: &str) -> String {
    if line.chars().count() > MAX_LINE {
        line.chars().take(MAX_LINE).collect::<String>() + "…"
    } else {
        line.to_string()
    }
}

// ---- read_file -------------------------------------------------------------------

pub struct ReadFile {
    pub cwd: PathBuf,
}

#[async_trait]
impl Tool for ReadFile {
    fn name(&self) -> &str {
        "read_file"
    }
    fn display_name(&self) -> &str {
        "Read"
    }
    fn description(&self) -> &str {
        "Read a text file. Returns lines prefixed with their line number. Reads up to 2000 lines; use offset (1-based line) and limit for long files."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "file_path": { "type": "string", "description": "Path relative to the working directory, or absolute" },
                "offset": { "type": "integer", "description": "First line to read, 1-based" },
                "limit": { "type": "integer", "description": "Number of lines to read (default 2000)" }
            },
            "required": ["file_path"]
        })
    }
    fn risky(&self, input: &Value) -> bool {
        path_risky(&self.cwd, input, "file_path")
    }
    async fn call(&self, input: Value, ctx: &ToolCtx) -> Result<String> {
        let raw = str_arg(&input, "file_path")?;
        let r = resolve(&ctx.cwd, raw)?;
        let bytes = tokio::fs::read(&r.path).await.with_context(|| format!("Cannot read {raw}"))?;
        if is_binary(&bytes) {
            return Ok(format!("{raw} is a binary file ({} bytes)", bytes.len()));
        }
        let text = String::from_utf8_lossy(&bytes);
        if text.is_empty() {
            return Ok(format!("{raw} is empty"));
        }
        let offset = input["offset"].as_u64().unwrap_or(1).max(1) as usize;
        let limit = input["limit"].as_u64().unwrap_or(2000).max(1) as usize;
        let total = text.lines().count();
        let mut out = String::new();
        for (i, line) in text.lines().enumerate().skip(offset - 1).take(limit) {
            out.push_str(&format!("{:>6}\t{}\n", i + 1, clip_line(line)));
            if out.len() > MAX_OUTPUT {
                out.push_str("… output cut; read on with offset\n");
                return Ok(out);
            }
        }
        if offset > total {
            return Ok(format!("{raw} has only {total} lines"));
        }
        let shown_to = (offset - 1 + limit).min(total);
        if shown_to < total {
            out.push_str(&format!("… {} more lines; read on with offset {}\n", total - shown_to, shown_to + 1));
        }
        Ok(out)
    }
}

// ---- write_file ------------------------------------------------------------------

pub struct WriteFile {
    pub cwd: PathBuf,
}

#[async_trait]
impl Tool for WriteFile {
    fn name(&self) -> &str {
        "write_file"
    }
    fn display_name(&self) -> &str {
        "Write"
    }
    fn description(&self) -> &str {
        "Write a file, replacing it if it exists. Creates missing folders. Prefer edit_file for changes to an existing file."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "file_path": { "type": "string", "description": "Path relative to the working directory, or absolute" },
                "content": { "type": "string", "description": "The full new content" }
            },
            "required": ["file_path", "content"]
        })
    }
    fn risky(&self, input: &Value) -> bool {
        path_risky(&self.cwd, input, "file_path")
    }
    async fn call(&self, input: Value, ctx: &ToolCtx) -> Result<String> {
        let raw = str_arg(&input, "file_path")?;
        let content = str_arg(&input, "content")?;
        let r = resolve(&ctx.cwd, raw)?;
        if let Some(parent) = r.path.parent() {
            tokio::fs::create_dir_all(parent).await.with_context(|| format!("Cannot create the folder for {raw}"))?;
        }
        let existed = r.path.exists();
        tokio::fs::write(&r.path, content).await.with_context(|| format!("Cannot write {raw}"))?;
        Ok(format!("{} {raw} ({} bytes)", if existed { "Replaced" } else { "Created" }, content.len()))
    }
}

// ---- edit_file -------------------------------------------------------------------

pub struct EditFile {
    pub cwd: PathBuf,
}

#[async_trait]
impl Tool for EditFile {
    fn name(&self) -> &str {
        "edit_file"
    }
    fn display_name(&self) -> &str {
        "Edit"
    }
    fn description(&self) -> &str {
        "Replace an exact string in a file. old_string must match the file exactly (including whitespace) and be unique, unless replace_all is true. Read the file first."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "file_path": { "type": "string" },
                "old_string": { "type": "string", "description": "Exact text to replace" },
                "new_string": { "type": "string", "description": "Text to put in its place" },
                "replace_all": { "type": "boolean", "description": "Replace every occurrence (default false)" }
            },
            "required": ["file_path", "old_string", "new_string"]
        })
    }
    fn risky(&self, input: &Value) -> bool {
        path_risky(&self.cwd, input, "file_path")
    }
    async fn call(&self, input: Value, ctx: &ToolCtx) -> Result<String> {
        let raw = str_arg(&input, "file_path")?;
        let old = str_arg(&input, "old_string")?;
        let new = str_arg(&input, "new_string")?;
        let all = input["replace_all"].as_bool().unwrap_or(false);
        if old.is_empty() {
            bail!("old_string is empty; use write_file to create a file");
        }
        if old == new {
            bail!("old_string and new_string are the same");
        }
        let r = resolve(&ctx.cwd, raw)?;
        let text = tokio::fs::read_to_string(&r.path).await.with_context(|| format!("Cannot read {raw}"))?;
        let (updated, count) = replace(&text, old, new, all).map_err(|e| anyhow!("{e} in {raw}"))?;
        tokio::fs::write(&r.path, updated).await.with_context(|| format!("Cannot write {raw}"))?;
        Ok(format!("Edited {raw} ({count} replacement{})", if count == 1 { "" } else { "s" }))
    }
}

/// Replace `old` with `new`; it must occur exactly once unless `all`.
pub(crate) fn replace(text: &str, old: &str, new: &str, all: bool) -> std::result::Result<(String, usize), String> {
    let count = text.matches(old).count();
    match count {
        0 => Err("old_string was not found".into()),
        1 => Ok((text.replacen(old, new, 1), 1)),
        n if all => Ok((text.replace(old, new), n)),
        n => Err(format!("old_string occurs {n} times; add surrounding lines to make it unique, or set replace_all")),
    }
}

// ---- list_dir --------------------------------------------------------------------

pub struct ListDir {
    pub cwd: PathBuf,
}

#[async_trait]
impl Tool for ListDir {
    fn name(&self) -> &str {
        "list_dir"
    }
    fn display_name(&self) -> &str {
        "LS"
    }
    fn description(&self) -> &str {
        "List a folder: folders end with /, files show their size."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "path": { "type": "string", "description": "Folder (default: the working directory)" } }
        })
    }
    fn risky(&self, input: &Value) -> bool {
        path_risky(&self.cwd, input, "path")
    }
    async fn call(&self, input: Value, ctx: &ToolCtx) -> Result<String> {
        let raw = input["path"].as_str().unwrap_or(".");
        let r = resolve(&ctx.cwd, raw)?;
        let mut rd = tokio::fs::read_dir(&r.path).await.with_context(|| format!("Cannot list {raw}"))?;
        let mut entries = Vec::new();
        while let Some(e) = rd.next_entry().await? {
            let name = e.file_name().to_string_lossy().to_string();
            let meta = e.metadata().await.ok();
            let dir = meta.as_ref().is_some_and(|m| m.is_dir());
            entries.push((dir, name, meta.map(|m| m.len()).unwrap_or(0)));
        }
        if entries.is_empty() {
            return Ok(format!("{raw} is empty"));
        }
        entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase())));
        let total = entries.len();
        let mut out: Vec<String> = entries
            .into_iter()
            .take(1000)
            .map(|(dir, name, size)| if dir { format!("{name}/") } else { format!("{name}  ({size} B)") })
            .collect();
        if total > 1000 {
            out.push(format!("… and {} more", total - 1000));
        }
        Ok(out.join("\n"))
    }
}

// ---- glob ------------------------------------------------------------------------

pub struct Glob {
    pub cwd: PathBuf,
}

fn walker(base: &Path) -> ignore::Walk {
    ignore::WalkBuilder::new(base)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build()
}

#[async_trait]
impl Tool for Glob {
    fn name(&self) -> &str {
        "glob"
    }
    fn display_name(&self) -> &str {
        "Glob"
    }
    fn description(&self) -> &str {
        "Find files by glob pattern, e.g. `**/*.rs` or `src/**/*.tsx`. Skips files ignored by .gitignore and hidden files. Newest first, at most 500."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string" },
                "path": { "type": "string", "description": "Folder to search (default: the working directory)" }
            },
            "required": ["pattern"]
        })
    }
    fn risky(&self, input: &Value) -> bool {
        path_risky(&self.cwd, input, "path")
    }
    async fn call(&self, input: Value, ctx: &ToolCtx) -> Result<String> {
        let pattern = str_arg(&input, "pattern")?.to_string();
        let base = resolve(&ctx.cwd, input["path"].as_str().unwrap_or("."))?.path;
        let matcher = globset::GlobBuilder::new(&pattern)
            .literal_separator(true)
            .build()
            .with_context(|| format!("Bad glob pattern {pattern}"))?
            .compile_matcher();
        let cwd = ctx.cwd.clone();
        let cancel = ctx.cancel.clone();
        tokio::task::spawn_blocking(move || {
            let mut hits: Vec<(SystemTime, PathBuf)> = Vec::new();
            for e in walker(&base).flatten() {
                if cancel.is_cancelled() {
                    bail!("Cancelled");
                }
                if !e.file_type().is_some_and(|t| t.is_file()) {
                    continue;
                }
                let Ok(rel) = e.path().strip_prefix(&base) else { continue };
                if matcher.is_match(rel) {
                    let mtime = e.metadata().ok().and_then(|m| m.modified().ok()).unwrap_or(SystemTime::UNIX_EPOCH);
                    hits.push((mtime, e.path().to_path_buf()));
                }
            }
            if hits.is_empty() {
                return Ok("No files found.".to_string());
            }
            hits.sort_by(|a, b| b.0.cmp(&a.0));
            let total = hits.len();
            let mut out: Vec<String> = hits.iter().take(500).map(|(_, p)| show(&cwd, p)).collect();
            if total > 500 {
                out.push(format!("… and {} more; narrow the pattern", total - 500));
            }
            Ok(out.join("\n"))
        })
        .await?
    }
}

// ---- grep ------------------------------------------------------------------------

pub struct Grep {
    pub cwd: PathBuf,
}

const MAX_MATCHES: usize = 250;

#[async_trait]
impl Tool for Grep {
    fn name(&self) -> &str {
        "grep"
    }
    fn display_name(&self) -> &str {
        "Grep"
    }
    fn description(&self) -> &str {
        "Search file contents with a regular expression (Rust regex syntax). Respects .gitignore. Returns `path:line: text`, or only file paths with files_only."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Regular expression" },
                "path": { "type": "string", "description": "File or folder to search (default: the working directory)" },
                "glob": { "type": "string", "description": "Only files matching this glob, e.g. `*.rs` or `src/**/*.ts`" },
                "case_insensitive": { "type": "boolean" },
                "files_only": { "type": "boolean", "description": "List matching files instead of lines" }
            },
            "required": ["pattern"]
        })
    }
    fn risky(&self, input: &Value) -> bool {
        path_risky(&self.cwd, input, "path")
    }
    async fn call(&self, input: Value, ctx: &ToolCtx) -> Result<String> {
        let pattern = str_arg(&input, "pattern")?;
        let re = regex::RegexBuilder::new(pattern)
            .case_insensitive(input["case_insensitive"].as_bool().unwrap_or(false))
            .build()
            .with_context(|| format!("Bad regular expression {pattern}"))?;
        let filter = match input["glob"].as_str().filter(|g| !g.is_empty()) {
            Some(g) => Some((
                g.contains('/'),
                globset::GlobBuilder::new(g).literal_separator(true).build().with_context(|| format!("Bad glob {g}"))?.compile_matcher(),
            )),
            None => None,
        };
        let files_only = input["files_only"].as_bool().unwrap_or(false);
        let base = resolve(&ctx.cwd, input["path"].as_str().unwrap_or("."))?.path;
        let cwd = ctx.cwd.clone();
        let cancel = ctx.cancel.clone();
        tokio::task::spawn_blocking(move || {
            let mut out = Vec::new();
            let mut more = false;
            for e in walker(&base).flatten() {
                if cancel.is_cancelled() {
                    bail!("Cancelled");
                }
                if !e.file_type().is_some_and(|t| t.is_file()) {
                    continue;
                }
                if let Some((by_path, m)) = &filter {
                    let ok = if *by_path {
                        e.path().strip_prefix(&base).is_ok_and(|rel| m.is_match(rel))
                    } else {
                        m.is_match(e.file_name())
                    };
                    if !ok {
                        continue;
                    }
                }
                if e.metadata().is_ok_and(|m| m.len() > 5_000_000) {
                    continue;
                }
                let Ok(bytes) = std::fs::read(e.path()) else { continue };
                if is_binary(&bytes) {
                    continue;
                }
                let text = String::from_utf8_lossy(&bytes);
                let shown = show(&cwd, e.path());
                for (i, line) in text.lines().enumerate() {
                    if re.is_match(line) {
                        if out.len() >= MAX_MATCHES {
                            more = true;
                            break;
                        }
                        if files_only {
                            out.push(shown.clone());
                            break;
                        }
                        let line = if line.chars().count() > 300 { line.chars().take(300).collect::<String>() + "…" } else { line.to_string() };
                        out.push(format!("{shown}:{}: {}", i + 1, line.trim_end()));
                    }
                }
                if more {
                    break;
                }
            }
            if out.is_empty() {
                return Ok("No matches.".to_string());
            }
            if more {
                out.push(format!("… stopped after {MAX_MATCHES} results; narrow the search"));
            }
            Ok(out.join("\n"))
        })
        .await?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    fn ctx(dir: &Path) -> ToolCtx {
        ToolCtx { cwd: dir.to_path_buf(), cancel: CancellationToken::new() }
    }

    #[test]
    fn edit_must_be_unique() {
        assert_eq!(replace("a b a", "b", "c", false).unwrap(), ("a c a".to_string(), 1));
        assert!(replace("a b a", "a", "c", false).unwrap_err().contains("occurs 2 times"));
        assert_eq!(replace("a b a", "a", "c", true).unwrap(), ("c b c".to_string(), 2));
        assert!(replace("a b a", "z", "c", false).unwrap_err().contains("not found"));
    }

    #[tokio::test]
    async fn write_read_edit_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let c = ctx(dir.path());
        let w = WriteFile { cwd: dir.path().into() };
        w.call(json!({"file_path":"a/b.txt","content":"one\ntwo\ntwo\n"}), &c).await.unwrap();
        let r = ReadFile { cwd: dir.path().into() };
        let out = r.call(json!({"file_path":"a/b.txt"}), &c).await.unwrap();
        assert_eq!(out, "     1\tone\n     2\ttwo\n     3\ttwo\n");
        let out = r.call(json!({"file_path":"a/b.txt","offset":2,"limit":1}), &c).await.unwrap();
        assert!(out.starts_with("     2\ttwo\n"));
        assert!(out.contains("1 more lines; read on with offset 3"));
        let e = EditFile { cwd: dir.path().into() };
        let err = e.call(json!({"file_path":"a/b.txt","old_string":"two","new_string":"2"}), &c).await.unwrap_err();
        assert!(err.to_string().contains("occurs 2 times"));
        e.call(json!({"file_path":"a/b.txt","old_string":"one","new_string":"1"}), &c).await.unwrap();
        e.call(json!({"file_path":"a/b.txt","old_string":"two","new_string":"2","replace_all":true}), &c).await.unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("a/b.txt")).unwrap(), "1\n2\n2\n");
        assert!(r.call(json!({"file_path":"../x"}), &c).await.is_err());
        assert!(w.call(json!({"file_path":"../x","content":""}), &c).await.is_err());
    }

    #[tokio::test]
    async fn grep_respects_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join(".gitignore"), "target/\n").unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("target")).unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {\n    println!(\"Hello\");\n}\n").unwrap();
        std::fs::write(root.join("src/lib.ts"), "export const hello = 1;\n").unwrap();
        std::fs::write(root.join("target/gen.rs"), "fn hello() {}\n").unwrap();
        let g = Grep { cwd: root.into() };
        let c = ctx(root);
        let out = g.call(json!({"pattern":"hello","case_insensitive":true}), &c).await.unwrap();
        assert!(out.contains("src/main.rs:2:"), "{out}");
        assert!(out.contains("src/lib.ts:1:"), "{out}");
        assert!(!out.contains("target"), "{out}");
        let out = g.call(json!({"pattern":"hello","case_insensitive":true,"glob":"*.rs","files_only":true}), &c).await.unwrap();
        assert_eq!(out, "src/main.rs");
        let out = g.call(json!({"pattern":"nothing here"}), &c).await.unwrap();
        assert_eq!(out, "No matches.");
        assert!(g.call(json!({"pattern":"("}), &c).await.is_err());

        let gl = Glob { cwd: root.into() };
        let out = gl.call(json!({"pattern":"**/*.rs"}), &c).await.unwrap();
        assert_eq!(out, "src/main.rs");
        let out = gl.call(json!({"pattern":"*.ts","path":"src"}), &c).await.unwrap();
        assert_eq!(out, "src/lib.ts");

        let ls = ListDir { cwd: root.into() };
        let out = ls.call(json!({}), &c).await.unwrap();
        assert!(out.starts_with("src/\ntarget/\n"), "{out}");
    }
}
