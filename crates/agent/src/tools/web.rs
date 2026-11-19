//! `web_fetch`: GET a URL and return its text.

use super::{Tool, ToolCtx};
use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;

const MAX_CHARS: usize = 50_000;

pub struct WebFetch;

#[async_trait]
impl Tool for WebFetch {
    fn name(&self) -> &str {
        "web_fetch"
    }
    fn display_name(&self) -> &str {
        "WebFetch"
    }
    fn description(&self) -> &str {
        "Fetch a URL (http or https) with GET and return its content as text. HTML is reduced to readable text. Long pages are cut."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "url": { "type": "string" } },
            "required": ["url"]
        })
    }
    fn risky(&self, _input: &Value) -> bool {
        true
    }
    async fn call(&self, input: Value, ctx: &ToolCtx) -> Result<String> {
        let url = input["url"].as_str().ok_or_else(|| anyhow!("Missing `url`"))?.trim();
        let parsed = reqwest::Url::parse(url).map_err(|e| anyhow!("Bad URL {url}: {e}"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            bail!("Only http and https URLs can be fetched");
        }
        let req = crate::provider::http().get(parsed).timeout(Duration::from_secs(30)).send();
        let resp = tokio::select! {
            _ = ctx.cancel.cancelled() => bail!("Cancelled"),
            r = req => r.map_err(|e| anyhow!("Fetching {url} failed: {e}"))?,
        };
        let status = resp.status();
        let ctype = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let body = tokio::select! {
            _ = ctx.cancel.cancelled() => bail!("Cancelled"),
            b = resp.bytes() => b.map_err(|e| anyhow!("Reading {url} failed: {e}"))?,
        };
        if !ctype.is_empty() && !(ctype.starts_with("text/") || ctype.contains("json") || ctype.contains("xml") || ctype.contains("javascript")) {
            return Ok(format!("{url} returned {status}, {ctype}, {} bytes (not text)", body.len()));
        }
        let text = String::from_utf8_lossy(&body);
        let looks_html = ctype.contains("html") || (ctype.is_empty() && text.trim_start().starts_with('<'));
        let text = if looks_html { html_to_text(&text) } else { text.to_string() };
        let text = super::truncate_middle(&text, MAX_CHARS);
        if status.is_success() {
            Ok(text)
        } else {
            bail!("{url} returned {status}\n{text}")
        }
    }
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid regex"))
}

/// Strip HTML to readable text: drop scripts and styles, keep line structure.
pub fn html_to_text(html: &str) -> String {
    static DROP: OnceLock<Regex> = OnceLock::new();
    static BREAK: OnceLock<Regex> = OnceLock::new();
    static TAG: OnceLock<Regex> = OnceLock::new();
    static SPACES: OnceLock<Regex> = OnceLock::new();
    static BLANKS: OnceLock<Regex> = OnceLock::new();
    let s = re(&DROP, r"(?is)<(script|style|noscript|svg|head|template)\b.*?</(script|style|noscript|svg|head|template)\s*>|<!--.*?-->").replace_all(html, " ");
    let s = re(&BREAK, r"(?i)<(br|/p|/div|/li|/h[1-6]|/tr|/section|/article|/header|/footer|/pre|/blockquote|hr)\b[^>]*>|<li\b[^>]*>").replace_all(&s, "\n");
    let s = re(&TAG, r"(?s)<[^>]*>").replace_all(&s, "");
    let s = decode_entities(&s);
    let s = re(&SPACES, r"[ \t\r\f\v\u{a0}]+").replace_all(&s, " ");
    let lines: Vec<&str> = s.lines().map(str::trim).collect();
    let s = lines.join("\n");
    re(&BLANKS, r"\n{3,}").replace_all(&s, "\n\n").trim().to_string()
}

fn decode_entities(s: &str) -> String {
    static ENT: OnceLock<Regex> = OnceLock::new();
    re(&ENT, r"&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);")
        .replace_all(s, |c: &regex::Captures| {
            let e = &c[1];
            let ch = if let Some(hex) = e.strip_prefix("#x").or_else(|| e.strip_prefix("#X")) {
                u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
            } else if let Some(dec) = e.strip_prefix('#') {
                dec.parse().ok().and_then(char::from_u32)
            } else {
                match e {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some(' '),
                    "mdash" => Some('—'),
                    "ndash" => Some('–'),
                    "hellip" => Some('…'),
                    "copy" => Some('©'),
                    _ => None,
                }
            };
            ch.map(String::from).unwrap_or_else(|| c[0].to_string())
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_html() {
        let html = "<html><head><title>T</title><style>p{}</style></head><body><script>var x=1;</script>\
                    <h1>Hello &amp; welcome</h1><p>First   para.</p><ul><li>one</li><li>two</li></ul>\
                    <!-- note --><p>A&#39;s &lt;tag&gt; &unknown;</p></body></html>";
        let t = html_to_text(html);
        assert_eq!(t, "Hello & welcome\nFirst para.\n\none\n\ntwo\nA's <tag> &unknown;");
        assert!(!t.contains("var x"));
    }

    #[test]
    fn web_fetch_is_risky() {
        assert!(WebFetch.risky(&json!({"url":"https://example.com"})));
    }
}
