//! The web client under `/app/`, when `CUNA_HUB_WEB_DIR` points at a build.
//! A single-page app: unknown paths get `index.html`.

use std::path::{Component, Path, PathBuf};

use axum::extract::{Path as UrlPath, State};
use axum::http::{header, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Redirect, Response};

use crate::AppState;

pub async fn root() -> Redirect {
    Redirect::permanent("/app/")
}

pub async fn index(State(st): State<AppState>) -> Response {
    serve(&st, "").await
}

pub async fn file(State(st): State<AppState>, UrlPath(path): UrlPath<String>) -> Response {
    serve(&st, &path).await
}

/// A path inside `dir`, or None when it tries to leave it.
fn resolve(dir: &Path, rel: &str) -> Option<PathBuf> {
    let mut out = dir.to_path_buf();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(out)
}

/// Vite names built assets `name-<hash>.ext`; those never change.
fn hashed(rel: &str) -> bool {
    rel.starts_with("assets/")
        || Path::new(rel)
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.rsplit_once(['-', '.']))
            .is_some_and(|(_, h)| {
                h.len() >= 8 && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            })
}

fn content_type(path: &Path) -> String {
    match path.extension().and_then(|e| e.to_str()) {
        Some("webmanifest") => "application/manifest+json".into(),
        Some("js" | "mjs") => "text/javascript; charset=utf-8".into(),
        Some("html") => "text/html; charset=utf-8".into(),
        _ => mime_guess::from_path(path)
            .first_or_octet_stream()
            .essence_str()
            .to_string(),
    }
}

/// The landing page at `/`, when `CUNA_HUB_SITE_DIR` points at it; otherwise `/` opens the web client.
pub async fn site_index(State(st): State<AppState>) -> Response {
    match st.config.site_dir.as_deref() {
        Some(dir) => serve_dir(dir, "", false).await,
        None => Redirect::temporary("/app/").into_response(),
    }
}

/// Files of the landing page (styles, scripts); anything else is a 404.
pub async fn site_file(State(st): State<AppState>, uri: Uri) -> Response {
    match st.config.site_dir.as_deref() {
        Some(dir) => serve_dir(dir, uri.path(), false).await,
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn serve(st: &AppState, rel: &str) -> Response {
    let Some(dir) = st.config.web_dir.as_deref() else {
        return (
            StatusCode::NOT_FOUND,
            "the web client is not installed on this hub",
        )
            .into_response();
    };
    serve_dir(dir, rel, true).await
}

/// One file from `dir`. A single-page app (`spa`) answers unknown routes with its `index.html`.
async fn serve_dir(dir: &Path, rel: &str, spa: bool) -> Response {
    let rel = rel.trim_start_matches('/');
    let Some(path) = resolve(dir, rel) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let found = if rel.is_empty() {
        None
    } else {
        match tokio::fs::metadata(&path).await {
            Ok(m) if m.is_file() => Some(path),
            _ => None,
        }
    };
    let (path, long_cache) = match found {
        Some(p) => {
            let cache = hashed(rel);
            (p, cache)
        }
        // A missing file with an extension is a real 404, not a route of the app.
        None if Path::new(rel).extension().is_some() && !rel.ends_with(".html") => {
            return StatusCode::NOT_FOUND.into_response()
        }
        None if rel.is_empty() || spa => (dir.join("index.html"), false),
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    let body = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("web client: {}: {e}", path.display());
            return StatusCode::NOT_FOUND.into_response();
        }
    };
    let cache = if long_cache {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let ct = content_type(&path);
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_str(&ct)
                    .unwrap_or(HeaderValue::from_static("application/octet-stream")),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static(cache)),
        ],
        body,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_caching() {
        let d = Path::new("/srv/web");
        assert_eq!(resolve(d, "a/b.js"), Some(PathBuf::from("/srv/web/a/b.js")));
        assert_eq!(resolve(d, "../etc/passwd"), None);
        assert!(hashed("assets/index-BxY3kq9a.js"));
        assert!(hashed("sw-1a2b3c4d.js"));
        assert!(!hashed("index.html"));
        assert!(!hashed("manifest.webmanifest"));
        assert_eq!(
            content_type(Path::new("m.webmanifest")),
            "application/manifest+json"
        );
    }
}
