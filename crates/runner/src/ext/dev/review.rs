//! Line-by-line review comments on a thread's diff.

use crate::{store, Runner};
use anyhow::{bail, Context, Result};
use bouvio_protocol::dev::*;
use chrono::Utc;
use std::collections::HashMap;
use std::path::PathBuf;
use uuid::Uuid;

/// The numbered lines of a diff, per file and side.
#[derive(Default, Debug)]
pub struct DiffLines(HashMap<(String, ReviewSide), Vec<(u32, String)>>);

impl DiffLines {
    pub fn parse(raw: &str) -> Self {
        let mut out: HashMap<(String, ReviewSide), Vec<(u32, String)>> = HashMap::new();
        let mut path: Option<String> = None;
        let mut in_hunk = false;
        let (mut o, mut n) = (0u32, 0u32);
        for line in raw.lines() {
            if let Some(rest) = line.strip_prefix("diff --git ") {
                path = rest.rsplit_once(" b/").map(|(_, p)| p.to_string()).or_else(|| Some(rest.to_string()));
                in_hunk = false;
            } else if line.starts_with("@@") {
                let nums: Vec<u32> = line
                    .split(' ')
                    .skip(1)
                    .take(2)
                    .map(|s| s.trim_start_matches(['-', '+']).split(',').next().unwrap_or("0").parse().unwrap_or(0))
                    .collect();
                o = nums.first().copied().unwrap_or(0);
                n = nums.get(1).copied().unwrap_or(0);
                in_hunk = true;
            } else if !in_hunk {
                continue;
            } else if let Some(p) = &path {
                let mut push = |side, num, text: &str| out.entry((p.clone(), side)).or_default().push((num, text.to_string()));
                if let Some(t) = line.strip_prefix('+') {
                    push(ReviewSide::New, n, t);
                    n += 1;
                } else if let Some(t) = line.strip_prefix('-') {
                    push(ReviewSide::Old, o, t);
                    o += 1;
                } else if let Some(t) = line.strip_prefix(' ') {
                    push(ReviewSide::New, n, t);
                    o += 1;
                    n += 1;
                }
            }
        }
        Self(out)
    }

    pub fn text(&self, path: &str, side: ReviewSide, line: u32) -> Option<&str> {
        self.0.get(&(path.to_string(), side))?.iter().find(|(n, _)| *n == line).map(|(_, t)| t.as_str())
    }

    /// Follow a comment to where its line went. Returns the new line number,
    /// or None when the line is gone (the comment is outdated).
    pub fn locate(&self, c: &ReviewComment) -> Option<u32> {
        let lines = self.0.get(&(c.path.clone(), c.side))?;
        if lines.iter().any(|(n, t)| *n == c.line && *t == c.line_text) {
            return Some(c.line);
        }
        // The same content elsewhere in the file: take the closest.
        lines.iter().filter(|(_, t)| *t == c.line_text).min_by_key(|(n, _)| n.abs_diff(c.line)).map(|(n, _)| *n)
    }
}

fn path(r: &Runner, thread_id: Uuid) -> PathBuf {
    r.store().dir().join("dev").join("reviews").join(format!("{thread_id}.json"))
}

fn load(r: &Runner, thread_id: Uuid) -> Vec<ReviewComment> {
    store::load(&path(r, thread_id)).unwrap_or_default()
}

fn save(r: &Runner, thread_id: Uuid, v: &[ReviewComment]) -> Result<()> {
    store::save(&path(r, thread_id), &v)?;
    if let Some(t) = r.thread(thread_id) {
        r.notice(t.workspace_id, "dev-review", serde_json::json!({ "thread_id": thread_id }));
    }
    Ok(())
}

async fn diff(r: &Runner, thread_id: Uuid) -> DiffLines {
    DiffLines::parse(&r.thread_diff(thread_id).await.unwrap_or_default())
}

pub async fn add(r: &Runner, thread_id: Uuid, path: String, line: u32, side: ReviewSide, text: String, author: &str) -> Result<ReviewComment> {
    r.thread(thread_id).context("unknown thread")?;
    if text.trim().is_empty() {
        bail!("write a comment first");
    }
    let line_text = diff(r, thread_id).await.text(&path, side, line).map(String::from).context("that line is not in the diff any more")?;
    let c = ReviewComment {
        id: Uuid::new_v4(),
        thread_id,
        path,
        line,
        side,
        text: text.trim().to_string(),
        author: author.to_string(),
        line_text,
        resolved: false,
        outdated: false,
        created_at: Utc::now(),
    };
    let mut v = load(r, thread_id);
    v.push(c.clone());
    save(r, thread_id, &v)?;
    Ok(c)
}

/// Comments with their lines followed through the current diff.
pub async fn list(r: &Runner, thread_id: Uuid) -> Result<Vec<ReviewComment>> {
    r.thread(thread_id).context("unknown thread")?;
    let mut v = load(r, thread_id);
    if v.is_empty() {
        return Ok(v);
    }
    let d = diff(r, thread_id).await;
    if follow(&d, &mut v) {
        store::save(&path(r, thread_id), &v)?;
    }
    Ok(v)
}

/// Move comments with their lines; mark the ones whose line is gone. True when anything changed.
pub fn follow(d: &DiffLines, v: &mut [ReviewComment]) -> bool {
    let mut changed = false;
    for c in v.iter_mut().filter(|c| !c.resolved) {
        match d.locate(c) {
            Some(n) if n != c.line || c.outdated => {
                c.line = n;
                c.outdated = false;
                changed = true;
            }
            None if !c.outdated => {
                c.outdated = true;
                changed = true;
            }
            _ => {}
        }
    }
    changed
}

/// The thread a comment belongs to, by scanning the review files.
pub fn thread_of(r: &Runner, id: Uuid) -> Option<Uuid> {
    let dir = r.store().dir().join("dev").join("reviews");
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let Some(t) = e.path().file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse::<Uuid>().ok()) else { continue };
        if load(r, t).iter().any(|c| c.id == id) {
            return Some(t);
        }
    }
    None
}

pub fn resolve(r: &Runner, id: Uuid, resolved: bool) -> Result<ReviewComment> {
    let t = thread_of(r, id).context("unknown comment")?;
    let mut v = load(r, t);
    let c = v.iter_mut().find(|c| c.id == id).context("unknown comment")?;
    c.resolved = resolved;
    let out = c.clone();
    save(r, t, &v)?;
    Ok(out)
}

pub fn delete(r: &Runner, id: Uuid) -> Result<()> {
    let t = thread_of(r, id).context("unknown comment")?;
    let mut v = load(r, t);
    v.retain(|c| c.id != id);
    save(r, t, &v)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BEFORE: &str = "diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 import x from \"x\";
-const a = 1;
+const a = 2;
+const b = 3;
 export { a };
";

    const AFTER: &str = "diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,6 @@
 import x from \"x\";
+// two new lines
+// push everything down
-const a = 1;
+const a = 2;
 export { a };
";

    fn comment(line: u32, side: ReviewSide, text: &str) -> ReviewComment {
        ReviewComment {
            id: Uuid::new_v4(),
            thread_id: Uuid::nil(),
            path: "src/app.ts".into(),
            line,
            side,
            text: "why?".into(),
            author: "Tim".into(),
            line_text: text.into(),
            resolved: false,
            outdated: false,
            created_at: Utc::now(),
        }
    }

    #[test]
    fn numbers_lines_per_side() {
        let d = DiffLines::parse(BEFORE);
        assert_eq!(d.text("src/app.ts", ReviewSide::New, 2), Some("const a = 2;"));
        assert_eq!(d.text("src/app.ts", ReviewSide::New, 3), Some("const b = 3;"));
        assert_eq!(d.text("src/app.ts", ReviewSide::New, 4), Some("export { a };"));
        assert_eq!(d.text("src/app.ts", ReviewSide::Old, 2), Some("const a = 1;"));
    }

    #[test]
    fn comments_follow_moved_lines_and_go_outdated() {
        let d = DiffLines::parse(BEFORE);
        let mut v = vec![
            comment(2, ReviewSide::New, d.text("src/app.ts", ReviewSide::New, 2).unwrap()),
            comment(3, ReviewSide::New, d.text("src/app.ts", ReviewSide::New, 3).unwrap()),
            comment(2, ReviewSide::Old, d.text("src/app.ts", ReviewSide::Old, 2).unwrap()),
        ];
        assert!(!follow(&d, &mut v));

        let d2 = DiffLines::parse(AFTER);
        assert!(follow(&d2, &mut v));
        // `const a = 2;` moved from line 2 to line 4.
        assert_eq!((v[0].line, v[0].outdated), (4, false));
        // `const b = 3;` is gone.
        assert!(v[1].outdated);
        // The removed line kept its old number.
        assert_eq!((v[2].line, v[2].outdated), (2, false));

        // Coming back clears outdated.
        assert!(follow(&d, &mut v));
        assert!(!v[1].outdated);
        assert_eq!(v[0].line, 2);
    }

    #[test]
    fn empty_diff_outdates_everything() {
        let mut v = vec![comment(2, ReviewSide::New, "const a = 2;")];
        assert!(follow(&DiffLines::default(), &mut v));
        assert!(v[0].outdated);
    }
}
