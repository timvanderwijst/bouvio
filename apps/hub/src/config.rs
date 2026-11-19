use std::env;

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
}

impl Config {
    pub fn from_env() -> Self {
        let var = |k: &str| env::var(k).ok().filter(|v| !v.trim().is_empty());
        let app = |id: &str, secret: &str| match (var(id), var(secret)) {
            (Some(client_id), Some(client_secret)) => Some(OAuthApp {
                client_id,
                client_secret,
            }),
            _ => None,
        };
        Config {
            addr: var("BOUVIO_HUB_ADDR").unwrap_or_else(|| "0.0.0.0:8787".into()),
            db_url: var("BOUVIO_HUB_DB").unwrap_or_else(|| "sqlite://data/hub.db".into()),
            public_url: var("BOUVIO_HUB_PUBLIC_URL")
                .unwrap_or_else(|| "http://localhost:8787".into())
                .trim_end_matches('/')
                .to_string(),
            smtp_url: var("SMTP_URL"),
            smtp_from: var("SMTP_FROM").unwrap_or_else(|| "Bouvio <bouvio@localhost>".into()),
            github: app("GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"),
            google: app("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"),
            dev_codes: matches!(var("BOUVIO_HUB_DEV_CODES").as_deref(), Some("1" | "true")),
        }
    }

    /// Defaults suitable for tests: in-memory nothing, dev codes on.
    pub fn for_tests(db_url: String) -> Self {
        Config {
            addr: "127.0.0.1:0".into(),
            db_url,
            public_url: "http://localhost:8787".into(),
            smtp_url: None,
            smtp_from: "Bouvio <bouvio@localhost>".into(),
            github: None,
            google: None,
            dev_codes: true,
        }
    }
}
