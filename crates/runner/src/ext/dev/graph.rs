//! Git: the commit graph with lanes, and one commit's details.

use super::{run, valid_sha};
use anyhow::{bail, Result};
use cuna_protocol::dev::*;
use std::path::Path;

const FS: char = '\x1f';
const RS: char = '\x1e';

pub async fn git_graph(root: &Path, limit: usize) -> Result<GitGraph> {
    let limit = limit.clamp(1, 5000).to_string();
    let format = "--format=%H%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e";
    let raw = match run(root, "git", &["log", "--all", "--date-order", "-n", &limit, format]).await {
        Ok(r) => r,
        // A repository without commits has nothing to draw.
        Err(e) if e.to_string().contains("does not have any commits") => String::new(),
        Err(e) => return Err(e),
    };
    let head = run(root, "git", &["rev-parse", "HEAD"]).await.ok().map(|s| s.trim().to_string());
    let mut commits = parse_log(&raw);
    let lanes = assign_lanes(&mut commits);
    Ok(GitGraph { commits, lanes, head })
}

pub fn parse_log(raw: &str) -> Vec<GraphCommit> {
    raw.split(RS)
        .filter_map(|rec| {
            let rec = rec.trim_start_matches(['\n', '\r']);
            let f: Vec<&str> = rec.split(FS).collect();
            if f.len() < 7 || f[0].is_empty() {
                return None;
            }
            Some(GraphCommit {
                sha: f[0].to_string(),
                parents: f[1].split_whitespace().map(String::from).collect(),
                refs: parse_refs(f[2]),
                author: f[3].to_string(),
                email: f[4].to_string(),
                date: f[5].to_string(),
                subject: f[6].trim_end().to_string(),
                lane: 0,
                color: 0,
                edges: vec![],
            })
        })
        .collect()
}

/// `HEAD -> main, origin/main, tag: v1.0` → `HEAD`, `main`, `origin/main`, `v1.0`.
fn parse_refs(d: &str) -> Vec<String> {
    let mut out = vec![];
    for part in d.split(", ").map(str::trim).filter(|p| !p.is_empty()) {
        if let Some(b) = part.strip_prefix("HEAD -> ") {
            out.insert(0, "HEAD".into());
            out.push(b.to_string());
        } else if let Some(t) = part.strip_prefix("tag: ") {
            out.push(t.to_string());
        } else if !part.ends_with("/HEAD") {
            out.push(part.to_string());
        }
    }
    out
}

/// Give every commit a lane and the lines that run down to the next row.
///
/// Columns hold the sha each one is waiting for. A commit takes the leftmost
/// column waiting for it (other columns waiting for it merge in), hands its
/// column to its first parent, and opens columns for further parents. Returns
/// the widest row.
pub fn assign_lanes(commits: &mut [GraphCommit]) -> u32 {
    // (sha awaited, color)
    let mut cols: Vec<Option<(String, u32)>> = vec![];
    let mut next_color = 0u32;
    let mut width = 0usize;
    let mut new_color = || {
        let c = next_color;
        next_color += 1;
        c
    };

    // First pass: lanes, colors and the columns after each row.
    let mut afters: Vec<Vec<Option<(String, u32)>>> = Vec::with_capacity(commits.len());
    let mut opened: Vec<Vec<usize>> = Vec::with_capacity(commits.len());
    let mut joins: Vec<Vec<usize>> = Vec::with_capacity(commits.len());
    for c in commits.iter_mut() {
        let waiting: Vec<usize> = cols.iter().enumerate().filter(|(_, x)| x.as_ref().is_some_and(|(s, _)| *s == c.sha)).map(|(i, _)| i).collect();
        let (lane, color) = match waiting.first() {
            Some(&i) => (i, cols[i].as_ref().unwrap().1),
            None => {
                let i = cols.iter().position(Option::is_none).unwrap_or(cols.len());
                if i == cols.len() {
                    cols.push(None);
                }
                (i, new_color())
            }
        };
        for &i in &waiting {
            cols[i] = None;
        }
        c.lane = lane as u32;
        c.color = color;

        let mut opened_here = vec![];
        let mut joined_here = vec![];
        for (n, p) in c.parents.iter().enumerate() {
            if let Some(i) = cols.iter().position(|x| x.as_ref().is_some_and(|(s, _)| s == p)) {
                // Another column already waits for this parent: draw into it.
                joined_here.push(i);
            } else if n == 0 {
                cols[lane] = Some((p.clone(), color));
            } else {
                let i = cols.iter().position(Option::is_none).unwrap_or(cols.len());
                if i == cols.len() {
                    cols.push(None);
                }
                cols[i] = Some((p.clone(), new_color()));
                opened_here.push(i);
            }
        }
        while cols.last().is_some_and(Option::is_none) {
            cols.pop();
        }
        width = width.max(cols.len()).max(lane + 1);
        afters.push(cols.clone());
        opened.push(opened_here);
        joins.push(joined_here);
    }

    // Second pass: lines from each row to the next.
    for i in 0..commits.len() {
        let next = commits.get(i + 1).map(|n| (n.sha.clone(), n.lane));
        let target = |k: usize, sha: &str| match &next {
            Some((s, l)) if s == sha => *l,
            _ => k as u32,
        };
        let lane = commits[i].lane;
        let mut edges = vec![];
        for (k, slot) in afters[i].iter().enumerate() {
            let Some((sha, color)) = slot else { continue };
            let from = if opened[i].contains(&k) { lane } else { k as u32 };
            edges.push(GraphEdge { from, to: target(k, sha), color: *color });
        }
        for &k in &joins[i] {
            if k as u32 == lane {
                continue;
            }
            if let Some((sha, _)) = &afters[i][k] {
                edges.push(GraphEdge { from: lane, to: target(k, sha), color: commits[i].color });
            }
        }
        commits[i].edges = edges;
    }
    width as u32
}

pub async fn get_commit(root: &Path, sha: &str) -> Result<CommitDetail> {
    if !valid_sha(sha) {
        bail!("not a commit hash");
    }
    let head = run(root, "git", &["show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b", sha]).await?;
    let f: Vec<&str> = head.splitn(7, FS).collect();
    if f.len() < 7 {
        bail!("unexpected git output");
    }
    let numstat = run(root, "git", &["show", "--numstat", "--format=", "-M", sha]).await?;
    let stat = run(root, "git", &["show", "--stat", "--format=", "-M", sha]).await?;
    Ok(CommitDetail {
        sha: f[0].to_string(),
        parents: f[1].split_whitespace().map(String::from).collect(),
        author: f[2].to_string(),
        email: f[3].to_string(),
        date: f[4].to_string(),
        subject: f[5].to_string(),
        body: f[6].trim().to_string(),
        files: parse_numstat(&numstat),
        stat: stat.trim_matches('\n').to_string(),
    })
}

fn parse_numstat(raw: &str) -> Vec<CommitFile> {
    raw.lines()
        .filter_map(|l| {
            let mut it = l.splitn(3, '\t');
            let (a, d, p) = (it.next()?, it.next()?, it.next()?);
            Some(CommitFile { path: p.to_string(), adds: a.parse().ok(), dels: d.parse().ok() })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(sha: &str, parents: &[&str]) -> GraphCommit {
        GraphCommit {
            sha: sha.into(),
            parents: parents.iter().map(|s| s.to_string()).collect(),
            refs: vec![],
            author: String::new(),
            email: String::new(),
            date: String::new(),
            subject: String::new(),
            lane: 0,
            color: 0,
            edges: vec![],
        }
    }

    fn lanes(v: &[GraphCommit]) -> Vec<u32> {
        v.iter().map(|c| c.lane).collect()
    }

    #[test]
    fn straight_line_stays_in_lane_zero() {
        let mut v = vec![c("c", &["b"]), c("b", &["a"]), c("a", &[])];
        assert_eq!(assign_lanes(&mut v), 1);
        assert_eq!(lanes(&v), [0, 0, 0]);
        assert_eq!(v[0].edges, [GraphEdge { from: 0, to: 0, color: 0 }]);
        assert!(v[2].edges.is_empty());
    }

    #[test]
    fn branch_and_merge() {
        // m merges f into main; f and b both come from a.
        //   m
        //   |\
        //   b f
        //   |/
        //   a
        let mut v = vec![c("m", &["b", "f"]), c("b", &["a"]), c("f", &["a"]), c("a", &[])];
        assert_eq!(assign_lanes(&mut v), 2);
        assert_eq!(lanes(&v), [0, 0, 1, 0]);
        // The merge opens a lane for its second parent.
        assert!(v[0].edges.contains(&GraphEdge { from: 0, to: 0, color: 0 }));
        assert!(v[0].edges.iter().any(|e| e.from == 0 && e.to == 1 && e.color != 0));
        // f's lane runs back into a's lane.
        assert!(v[2].edges.iter().any(|e| e.from == 1 && e.to == 0));
        assert!(v[1].edges.iter().any(|e| e.from == 0 && e.to == 0));
        assert!(v[3].edges.is_empty());
    }

    #[test]
    fn two_branch_heads_share_a_parent() {
        // x and y are tips of two branches off a.
        let mut v = vec![c("x", &["a"]), c("y", &["a"]), c("a", &[])];
        assign_lanes(&mut v);
        assert_eq!(lanes(&v), [0, 1, 0]);
        assert_ne!(v[0].color, v[1].color);
        // Row y: lane 0 (waiting for a) continues, and y joins into it.
        assert!(v[1].edges.iter().any(|e| e.from == 1 && e.to == 0));
        assert!(v[1].edges.iter().any(|e| e.from == 0 && e.to == 0));
    }

    #[test]
    fn freed_lanes_are_reused() {
        let mut v = vec![c("x", &["a"]), c("y", &["b"]), c("b", &["a"]), c("z", &["a"]), c("a", &[])];
        let w = assign_lanes(&mut v);
        assert_eq!(lanes(&v), [0, 1, 1, 1, 0]);
        assert_eq!(w, 2);
    }

    #[test]
    fn parses_log_and_refs() {
        let raw = "aaa\x1fbbb ccc\x1fHEAD -> main, origin/main, origin/HEAD, tag: v1\x1fTim\x1ft@x\x1f2026-01-01T10:00:00+01:00\x1fMerge it\x1e\nbbb\x1f\x1f\x1fTim\x1ft@x\x1f2026-01-01T09:00:00+01:00\x1fFirst\x1e\n";
        let v = parse_log(raw);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].parents, ["bbb", "ccc"]);
        assert_eq!(v[0].refs, ["HEAD", "main", "origin/main", "v1"]);
        assert!(v[1].parents.is_empty() && v[1].refs.is_empty());
        assert_eq!(v[1].subject, "First");
    }

    #[test]
    fn parses_numstat() {
        let v = parse_numstat("3\t1\tsrc/a.rs\n-\t-\tlogo.png\n");
        assert_eq!(v[0].adds, Some(3));
        assert_eq!(v[1].adds, None);
        assert_eq!(v[1].path, "logo.png");
    }
}
