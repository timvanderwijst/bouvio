use std::env;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct OAuthApp {
    pub client_id: String,
    pub client_secret: String,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub addr: String,
    pub db_url: String,
    /// Base URL people reach the hub on, without a trailing slash.
    pub public_url: String,
    pub smtp_url: Option<String>,
    pub smtp_from: String,
    pub github: Option<OAuthApp>,
    pub google: Option<OAuthApp>,
    /// Dev only: `/auth/email/start` returns the login code in its response.
    pub dev_codes: bool,
    /// STUN servers handed to huddles (`STUN_URLS`, comma-separated).
    pub stun_urls: Vec<String>,
    /// coturn with `use-auth-secret`: `TURN_URLS` (comma-separated) and `TURN_SECRET`.
    pub turn_urls: Vec<String>,
    pub turn_secret: Option<String>,
    /// A built web client to serve under `/app/` (`CUNA_HUB_WEB_DIR`).
    pub web_dir: Option<PathBuf>,
    /// The landing page to serve at `/` (`CUNA_HUB_SITE_DIR`).
    pub site_dir: Option<PathBuf>,
}

const DEFAULT_STUN: &str = "stun:stun.l.google.com:19302";

fn list(v: Option<String>) -> Vec<String> {
    v.unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

impl Config {
    pub fn from_env() -> Self {
        // CUNA_* settings; the old BOUVIO_* names still work.
        let var = |k: &str| {
            let get = |k: &str| env::var(k).ok().filter(|v| !v.trim().is_empty());
            get(k).or_else(|| k.strip_prefix("CUNA_").and_then(|rest| get(&format!("BOUVIO_{rest}"))))
        };
        let app = |id: &str, secret: &str| match (var(id), var(secret)) {
            (Some(client_id), Some(client_secret)) => Some(OAuthApp {
                client_id,
                client_secret,
            }),
            _ => None,
        };
        Config {
            addr: var("CUNA_HUB_ADDR").unwrap_or_else(|| "0.0.0.0:8787".into()),
            db_url: var("CUNA_HUB_DB").unwrap_or_else(|| "sqlite://data/hub.db".into()),
            public_url: var("CUNA_HUB_PUBLIC_URL")
                .unwrap_or_else(|| "http://localhost:8787".into())
                .trim_end_matches('/')
                .to_string(),
            smtp_url: var("SMTP_URL"),
            smtp_from: var("SMTP_FROM").unwrap_or_else(|| "Cuna <cuna@localhost>".into()),
            github: app("GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"),
            google: app("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"),
            dev_codes: matches!(var("CUNA_HUB_DEV_CODES").as_deref(), Some("1" | "true")),
            // Set but empty means no STUN at all; unset means the public default.
            stun_urls: match env::var("STUN_URLS") {
                Ok(v) => list(Some(v)),
                Err(_) => vec![DEFAULT_STUN.into()],
            },
            turn_urls: list(var("TURN_URLS")),
            turn_secret: var("TURN_SECRET"),
            web_dir: var("CUNA_HUB_WEB_DIR").map(PathBuf::from),
            site_dir: var("CUNA_HUB_SITE_DIR").map(PathBuf::from),
        }
    }

    /// Defaults suitable for tests: in-memory nothing, dev codes on.
    pub fn for_tests(db_url: String) -> Self {
        Config {
            addr: "127.0.0.1:0".into(),
            db_url,
            public_url: "http://localhost:8787".into(),
            smtp_url: None,
            smtp_from: "Cuna <cuna@localhost>".into(),
            github: None,
            google: None,
            dev_codes: true,
            stun_urls: vec![DEFAULT_STUN.into()],
            turn_urls: vec![],
            turn_secret: None,
            web_dir: None,
            site_dir: None,
        }
    }
}
