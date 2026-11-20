//! Preview proxy: a reverse proxy in front of a thread's dev server that adds
//! the element picker to every HTML page and tunnels WebSockets for HMR.

use crate::Runner;
use anyhow::{Context, Result};
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bouvio_protocol::dev::DevProxy;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use uuid::Uuid;

pub const PICKER_PATH: &str = "/__bouvio/picker.js";
pub const PICKER_JS: &str = include_str!("picker.js");
const SCRIPT: &str = "<script src=\"/__bouvio/picker.js\"></script>";

struct Running {
    port: u16,
    upstream: Arc<AtomicU16>,
    task: JoinHandle<()>,
}

static PROXIES: LazyLock<Mutex<HashMap<Uuid, Running>>> = LazyLock::new(Default::default);

/// Make sure the thread's dev server runs, and put the proxy in front of it.
pub async fn dev_proxy(r: &Arc<Runner>, thread_id: Uuid) -> Result<DevProxy> {
    let d = r.start_dev_server(thread_id)?;
    {
        let mut map = PROXIES.lock().unwrap();
        if let Some(p) = map.get(&thread_id) {
            if !p.task.is_finished() {
                // A restarted dev server gets a new port; the preview keeps its URL.
                p.upstream.store(d.port, Ordering::Relaxed);
                return Ok(DevProxy { thread_id, url: format!("http://127.0.0.1:{}", p.port), upstream: d.url });
            }
            map.remove(&thread_id);
        }
    }
    let upstream = Arc::new(AtomicU16::new(d.port));
    let (port, task) = start(upstream.clone()).await?;
    PROXIES.lock().unwrap().insert(thread_id, Running { port, upstream, task });
    let out = DevProxy { thread_id, url: format!("http://127.0.0.1:{port}"), upstream: d.url };
    if let Some(t) = r.thread(thread_id) {
        r.notice(t.workspace_id, "dev-proxy", &out);
    }
    Ok(out)
}

pub fn stop(thread_id: Uuid) {
    if let Some(p) = PROXIES.lock().unwrap().remove(&thread_id) {
        p.task.abort();
    }
}

#[derive(Clone)]
struct Ctx {
    upstream: Arc<AtomicU16>,
    client: reqwest::Client,
}

/// Connections for axum, minus the WebSocket upgrades we tunnel ourselves.
struct Sorted {
    rx: mpsc::Receiver<(TcpStream, SocketAddr)>,
    addr: SocketAddr,
}

impl axum::serve::Listener for Sorted {
    type Io = TcpStream;
    type Addr = SocketAddr;
    async fn accept(&mut self) -> (TcpStream, SocketAddr) {
        match self.rx.recv().await {
            Some(c) => c,
            // The accept loop is gone; never hand out another connection.
            None => std::future::pending().await,
        }
    }
    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        Ok(self.addr)
    }
}

/// Start a proxy on a free local port. The task ends when aborted.
pub async fn start(upstream: Arc<AtomicU16>) -> Result<(u16, JoinHandle<()>)> {
    let listener = TcpListener::bind("127.0.0.1:0").await.context("open the preview port")?;
    let addr = listener.local_addr()?;
    let (tx, rx) = mpsc::channel(64);
    let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build()?;
    let ctx = Ctx { upstream: upstream.clone(), client };
    let app = axum::Router::new().fallback(handle).with_state(ctx);
    let task = tokio::spawn(async move {
        let accept = async move {
            loop {
                let (sock, peer) = match listener.accept().await {
                    Ok(x) => x,
                    Err(_) => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        continue;
                    }
                };
                let tx = tx.clone();
                let up = upstream.clone();
                tokio::spawn(async move {
                    if is_upgrade(&sock).await {
                        tunnel(sock, up.load(Ordering::Relaxed)).await;
                    } else {
                        let _ = tx.send((sock, peer)).await;
                    }
                });
            }
        };
        let serve = axum::serve(Sorted { rx, addr }, app);
        tokio::select! {
            _ = accept => {}
            _ = serve => {}
        }
    });
    Ok((addr.port(), task))
}

/// Look at the request head without consuming it: is this a WebSocket upgrade?
async fn is_upgrade(sock: &TcpStream) -> bool {
    let mut buf = [0u8; 8192];
    let mut last = 0;
    for _ in 0..400 {
        let n = match tokio::time::timeout(Duration::from_secs(5), sock.peek(&mut buf)).await {
            Ok(Ok(n)) => n,
            _ => return false,
        };
        if n == 0 {
            return false;
        }
        if let Some(end) = find(&buf[..n], b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
            return head.lines().any(|l| l.starts_with("upgrade:") && l.contains("websocket"));
        }
        if n == buf.len() {
            return false;
        }
        if n == last {
            // Peek returns what is there already; wait for more of the head.
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        last = n;
    }
    false
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Pipe a WebSocket connection to the dev server byte for byte (HMR).
async fn tunnel(mut client: TcpStream, port: u16) {
    if let Ok(mut up) = TcpStream::connect(("127.0.0.1", port)).await {
        let _ = tokio::io::copy_bidirectional(&mut client, &mut up).await;
    }
}

const HOP: &[&str] = &["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];

async fn handle(State(ctx): State<Ctx>, req: Request) -> Response {
    let pq = req.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".into());
    if req.uri().path() == PICKER_PATH {
        return ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], PICKER_JS).into_response();
    }
    let port = ctx.upstream.load(Ordering::Relaxed);
    let wants_html = req.headers().get(header::ACCEPT).and_then(|v| v.to_str().ok()).is_some_and(|a| a.contains("text/html"));
    let host = req.headers().get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();

    let mut b = ctx.client.request(req.method().clone(), format!("http://127.0.0.1:{port}{pq}"));
    for (k, v) in req.headers() {
        if HOP.contains(&k.as_str()) || k == header::ACCEPT_ENCODING {
            continue;
        }
        b = b.header(k.clone(), v.clone());
    }
    // Plain bodies, so HTML can be changed on the way through.
    b = b.header(header::ACCEPT_ENCODING, "identity");
    let body = req.into_body().into_data_stream();
    b = b.body(reqwest::Body::wrap_stream(body));

    let resp = match b.send().await {
        Ok(r) => r,
        Err(_) if wants_html => return starting(port),
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("dev server on port {port}: {e}")).into_response(),
    };

    let status = resp.status();
    let mut headers = HeaderMap::new();
    for (k, v) in resp.headers() {
        let name = k.as_str();
        if HOP.contains(&name) || name == "x-frame-options" {
            continue;
        }
        // The preview lives in a frame; a policy that forbids that would blank it.
        if name == "content-security-policy" && v.to_str().is_ok_and(|s| s.contains("frame-ancestors")) {
            continue;
        }
        if k == header::LOCATION {
            if let Ok(loc) = v.to_str() {
                let mut l = loc.to_string();
                for up in [format!("http://127.0.0.1:{port}"), format!("http://localhost:{port}")] {
                    if let Some(rest) = l.strip_prefix(&up) {
                        l = format!("http://{host}{rest}");
                    }
                }
                if let Ok(v) = HeaderValue::from_str(&l) {
                    headers.append(k.clone(), v);
                }
                continue;
            }
        }
        headers.append(k.clone(), v.clone());
    }

    let is_html = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|c| c.to_ascii_lowercase().starts_with("text/html"));
    let encoded = headers.get(header::CONTENT_ENCODING).and_then(|v| v.to_str().ok()).is_some_and(|e| !e.eq_ignore_ascii_case("identity"));
    let out_body = if is_html && !encoded {
        match resp.bytes().await {
            Ok(bytes) => {
                headers.remove(header::CONTENT_LENGTH);
                Body::from(inject(&String::from_utf8_lossy(&bytes)))
            }
            Err(e) => return (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
        }
    } else {
        Body::from_stream(resp.bytes_stream())
    };
    let mut res = Response::new(out_body);
    *res.status_mut() = status;
    *res.headers_mut() = headers;
    res
}

/// Put the picker script into an HTML page: before `</head>`, else before
/// `<body`, else at the start.
pub fn inject(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if lower.contains(PICKER_PATH) {
        return html.to_string();
    }
    let at = lower.find("</head>").or_else(|| lower.find("<body")).unwrap_or(0);
    let mut out = String::with_capacity(html.len() + SCRIPT.len());
    out.push_str(&html[..at]);
    out.push_str(SCRIPT);
    out.push_str(&html[at..]);
    out
}

/// What the frame shows while the dev server is still starting.
fn starting(port: u16) -> Response {
    let page = format!(
        "<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=1><title>Starting…</title>\
         <style>html{{color-scheme:light dark}}body{{margin:0;height:100vh;display:grid;place-items:center;font:13px -apple-system,system-ui,sans-serif;color:#8A8A86}}</style>\
         <p>Waiting for the dev server on port {port}…</p>"
    );
    (StatusCode::SERVICE_UNAVAILABLE, [(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], page).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;
    use futures::{SinkExt, StreamExt};

    #[test]
    fn injects_before_head_end() {
        assert_eq!(inject("<html><head><title>x</title></HEAD><body>hi</body></html>"), format!("<html><head><title>x</title>{SCRIPT}</HEAD><body>hi</body></html>"));
        assert_eq!(inject("<body>hi</body>"), format!("{SCRIPT}<body>hi</body>"));
        assert_eq!(inject("hi"), format!("{SCRIPT}hi"));
        // Once is enough.
        let once = inject("<head></head>");
        assert_eq!(inject(&once), once);
    }

    async fn upstream() -> u16 {
        let page = "<!doctype html><html><head><title>App</title></head><body><div id=root></div></body></html>";
        let app = axum::Router::new()
            .route("/", get(move || async move { ([(header::CONTENT_TYPE, "text/html")], page) }))
            .route(
                "/chunked",
                get(|| async {
                    let parts: Vec<Result<&'static str, std::io::Error>> = vec![Ok("<html><he"), Ok("ad><title>c</title></h"), Ok("ead><body>streamed</body></html>")];
                    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], Body::from_stream(futures::stream::iter(parts)))
                }),
            )
            .route("/app.js", get(|| async { ([(header::CONTENT_TYPE, "text/javascript")], "console.log('</head>')") }))
            .route("/gz", get(|| async { ([(header::CONTENT_TYPE, "text/html"), (header::CONTENT_ENCODING, "gzip")], vec![0x1fu8, 0x8b, 0, 1]) }))
            .route("/enc", get(|headers: HeaderMap| async move { headers.get("accept-encoding").and_then(|v| v.to_str().ok()).unwrap_or("").to_string() }))
            .route("/framed", get(|| async { ([(header::CONTENT_TYPE, "text/html"), (header::HeaderName::from_static("x-frame-options"), "DENY")], "<head></head>") }));
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        port
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().unwrap()
    }

    #[tokio::test]
    async fn proxies_and_injects() {
        let up = upstream().await;
        let (port, task) = start(Arc::new(AtomicU16::new(up))).await.unwrap();
        let base = format!("http://127.0.0.1:{port}");
        let c = client();

        // Identity body with a content length.
        let r = c.get(format!("{base}/")).header("accept-encoding", "gzip, br").send().await.unwrap();
        assert_eq!(r.status(), 200);
        let len = r.content_length();
        let body = r.text().await.unwrap();
        assert!(body.contains(&format!("<title>App</title>{SCRIPT}</head>")), "{body}");
        assert_eq!(len, Some(body.len() as u64));

        // Chunked body, the head split across chunks.
        let body = c.get(format!("{base}/chunked")).send().await.unwrap().text().await.unwrap();
        assert_eq!(body, format!("<html><head><title>c</title>{SCRIPT}</head><body>streamed</body></html>"));

        // Not HTML: untouched.
        assert_eq!(c.get(format!("{base}/app.js")).send().await.unwrap().text().await.unwrap(), "console.log('</head>')");
        // Compressed HTML the server sent anyway: passed through, not mangled.
        assert_eq!(c.get(format!("{base}/gz")).send().await.unwrap().bytes().await.unwrap().as_ref(), [0x1f, 0x8b, 0, 1]);
        // Upstream is asked for identity encoding.
        assert_eq!(c.get(format!("{base}/enc")).header("accept-encoding", "gzip").send().await.unwrap().text().await.unwrap(), "identity");
        // Frames are allowed.
        assert!(c.get(format!("{base}/framed")).send().await.unwrap().headers().get("x-frame-options").is_none());

        // The picker itself.
        let js = c.get(format!("{base}{PICKER_PATH}")).send().await.unwrap();
        assert!(js.headers()[header::CONTENT_TYPE].to_str().unwrap().contains("javascript"));
        assert!(js.text().await.unwrap().contains("bouvio:picked"));
        task.abort();
    }

    #[tokio::test]
    async fn waits_for_a_starting_server() {
        // Nothing listens on the upstream port yet.
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let (port, task) = start(Arc::new(AtomicU16::new(free))).await.unwrap();
        let r = client().get(format!("http://127.0.0.1:{port}/")).header("accept", "text/html").send().await.unwrap();
        assert_eq!(r.status(), 503);
        assert!(r.text().await.unwrap().contains("http-equiv=refresh"));
        task.abort();
    }

    #[tokio::test]
    async fn tunnels_websockets() {
        // An echo WebSocket server standing in for Vite's HMR socket.
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((s, _)) = l.accept().await {
                tokio::spawn(async move {
                    let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
                    while let Some(Ok(m)) = ws.next().await {
                        if m.is_text() {
                            ws.send(m).await.unwrap();
                        }
                    }
                });
            }
        });
        let (port, task) = start(Arc::new(AtomicU16::new(up))).await.unwrap();
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/?token=x")).await.unwrap();
        ws.send(tokio_tungstenite::tungstenite::Message::text("hmr")).await.unwrap();
        let back = ws.next().await.unwrap().unwrap();
        assert_eq!(back.into_text().unwrap().as_str(), "hmr");
        task.abort();
    }
}
