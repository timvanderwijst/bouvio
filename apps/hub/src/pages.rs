//! The few HTML pages people see in a browser.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};

use crate::db::now_ms;
use crate::AppState;

pub(crate) fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

const STYLE: &str = r#"
:root { --bg:#f6f5f2; --card:#fff; --fg:#1b1b1a; --muted:#6b6a66; --line:#e4e2dc; --accent:#3d5afe; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#121212; --card:#1c1c1b; --fg:#ecebe8; --muted:#9a9893; --line:#2c2b29; --accent:#8c9eff; }
}
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px 16px;
  background:var(--bg); color:var(--fg);
  font:16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { width:100%; max-width:420px; background:var(--card); border:1px solid var(--line);
  border-radius:16px; padding:32px 28px; text-align:center; }
.brand { font-weight:600; letter-spacing:.02em; color:var(--muted); font-size:14px; margin-bottom:20px; }
h1 { font-size:20px; font-weight:600; margin:0 0 8px; }
p { color:var(--muted); margin:0 0 20px; }
.code { font:600 clamp(28px, 9vw, 40px)/1.1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing:.14em; padding:18px 12px; border:1px dashed var(--line); border-radius:12px;
  user-select:all; word-break:break-all; margin-bottom:16px; }
button { font:inherit; font-size:14px; padding:8px 16px; border-radius:8px; border:1px solid var(--line);
  background:transparent; color:var(--fg); cursor:pointer; }
button:hover { border-color:var(--accent); color:var(--accent); }
.small { font-size:13px; margin:16px 0 0; }
main.wide { max-width:560px; text-align:left; }
main.wide .brand { text-align:center; }
.desc { white-space:pre-wrap; }
.q { margin:0 0 20px; padding:0; border:0; }
.q > label, .q > legend { display:block; font-weight:600; font-size:15px; margin:0 0 6px; padding:0; }
.req { color:var(--accent); margin-left:2px; }
.help { color:var(--muted); font-size:13px; margin:-2px 0 8px; }
.err { color:#d93f3f; font-size:13px; margin:6px 0 0; }
.banner { border:1px solid #d93f3f; color:#d93f3f; border-radius:10px; padding:10px 12px; font-size:14px; margin:0 0 20px; }
input[type=text], input[type=number], input[type=url], input[type=date], input[type=email], select, textarea {
  font:inherit; font-size:15px; width:100%; padding:9px 11px; border-radius:8px; border:1px solid var(--line);
  background:var(--bg); color:var(--fg); }
textarea { min-height:96px; resize:vertical; }
input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible {
  outline:2px solid var(--accent); outline-offset:2px; }
.opt { display:flex; align-items:center; gap:10px; padding:6px 0; font-size:15px; cursor:pointer; }
.opt input { width:18px; height:18px; margin:0; accent-color:var(--accent); }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; padding:10px 18px; }
button.primary:hover { color:#fff; opacity:.92; }
.hp { position:absolute; left:-10000px; width:1px; height:1px; overflow:hidden; }
"#;

fn page(title: &str, body: &str) -> String {
    page_in("", title, body)
}

/// A page with a class on `<main>` (`wide` for forms).
pub(crate) fn page_in(class: &str, title: &str, body: &str) -> String {
    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>{title}</title><style>{STYLE}</style></head>
<body><main class="{class}"><div class="brand">Bouvio</div>{body}</main></body></html>"#,
        title = escape(title),
        class = escape(class)
    )
}

fn code_block(code: &str) -> String {
    format!(
        r#"<div class="code" id="code">{code}</div>
<button onclick="navigator.clipboard.writeText(document.getElementById('code').textContent).then(()=>this.textContent='Copied')">Copy code</button>"#,
        code = escape(code)
    )
}

/// After OAuth: the code the person pastes into the app.
pub fn exchange_code(code: &str, name: &str) -> Html<String> {
    Html(page(
        "Paste this code in Bouvio",
        &format!(
            r#"<h1>Paste this code in Bouvio</h1><p>Signed in as {name}. You can close this tab afterwards.</p>{}
<p class="small">The code works once, for 10 minutes.</p>"#,
            code_block(code),
            name = escape(name)
        ),
    ))
}

pub fn error(status: StatusCode, message: &str) -> Response {
    let body = format!("<h1>Something went wrong</h1><p>{}</p>", escape(message));
    (status, Html(page("Bouvio", &body))).into_response()
}

/// `GET /invite/:code`: what an invite link shows in a browser.
pub async fn invite(State(st): State<AppState>, Path(code): Path<String>) -> Response {
    let row: Result<Option<(String,)>, _> = sqlx::query_as(
        "SELECT w.name FROM invites i JOIN workspaces w ON w.id = i.workspace_id WHERE i.code = ? AND i.expires_at > ?",
    )
    .bind(&code)
    .bind(now_ms())
    .fetch_optional(&st.db)
    .await;
    match row {
        Ok(Some((name,))) => {
            let body = format!(
                r#"<h1>You are invited to {name}</h1><p>Open Bouvio and paste this code.</p>{}"#,
                code_block(&code),
                name = escape(&name)
            );
            Html(page(&format!("Join {name} on Bouvio"), &body)).into_response()
        }
        Ok(None) => error(
            StatusCode::NOT_FOUND,
            "This invite does not exist or has expired.",
        ),
        Err(e) => {
            tracing::error!("invite page: {e}");
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "The hub could not read its database.",
            )
        }
    }
}
