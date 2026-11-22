//! GitHub and Google sign-in for a desktop app without deep links: the browser
//! ends on a page with a one-time code that the person pastes into Cuna.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Redirect, Response};
use serde::Deserialize;

use crate::config::OAuthApp;
use crate::error::ApiError;
use crate::{auth, db, pages, AppState};

const STATE_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Provider {
    GitHub,
    Google,
}

impl Provider {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "github" => Some(Provider::GitHub),
            "google" => Some(Provider::Google),
            _ => None,
        }
    }
    fn slug(self) -> &'static str {
        match self {
            Provider::GitHub => "github",
            Provider::Google => "google",
        }
    }
    fn app(self, st: &AppState) -> Option<&OAuthApp> {
        match self {
            Provider::GitHub => st.config.github.as_ref(),
            Provider::Google => st.config.google.as_ref(),
        }
    }
}

/// What an OAuth provider told us about the person.
struct Profile {
    email: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

pub struct OAuth {
    http: reqwest::Client,
    /// Anti-CSRF `state` values handed out by `/start`, with when they expire.
    states: Mutex<HashMap<String, (Provider, Instant)>>,
}

impl OAuth {
    pub fn new() -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent("cuna-hub")
            .timeout(Duration::from_secs(15))
            .build()?;
        Ok(OAuth {
            http,
            states: Mutex::default(),
        })
    }

    fn new_state(&self, provider: Provider) -> String {
        let state = db::random_token();
        let mut states = self.states.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        states.retain(|_, (_, exp)| *exp > now);
        states.insert(state.clone(), (provider, now + STATE_TTL));
        state
    }

    fn take_state(&self, state: &str, provider: Provider) -> bool {
        let mut states = self.states.lock().unwrap_or_else(|e| e.into_inner());
        matches!(states.remove(state), Some((p, exp)) if p == provider && exp > Instant::now())
    }
}

fn redirect_uri(st: &AppState, provider: Provider) -> String {
    format!("{}/auth/{}/callback", st.config.public_url, provider.slug())
}

fn provider_and_app(st: &AppState, name: &str) -> Result<(Provider, OAuthApp), ApiError> {
    let provider =
        Provider::parse(name).ok_or_else(|| ApiError::not_found("unknown sign-in provider"))?;
    let app = provider.app(st).cloned().ok_or_else(|| {
        ApiError::not_configured(match provider {
            Provider::GitHub => "GitHub sign-in (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET)",
            Provider::Google => "Google sign-in (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)",
        })
    })?;
    Ok((provider, app))
}

pub async fn start(
    State(st): State<AppState>,
    Path(name): Path<String>,
) -> Result<Redirect, ApiError> {
    let (provider, app) = provider_and_app(&st, &name)?;
    let state = st.oauth.new_state(provider);
    let redirect = redirect_uri(&st, provider);
    let (base, scope) = match provider {
        Provider::GitHub => (
            "https://github.com/login/oauth/authorize",
            "read:user user:email",
        ),
        Provider::Google => (
            "https://accounts.google.com/o/oauth2/v2/auth",
            "openid email profile",
        ),
    };
    let url = reqwest::Url::parse_with_params(
        base,
        &[
            ("client_id", app.client_id.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("response_type", "code"),
            ("scope", scope),
            ("state", state.as_str()),
        ],
    )
    .map_err(|e| ApiError::from(anyhow!(e)))?;
    Ok(Redirect::to(url.as_str()))
}

#[derive(Deserialize)]
pub struct Callback {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

pub async fn callback(
    State(st): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<Callback>,
) -> Response {
    let (provider, app) = match provider_and_app(&st, &name) {
        Ok(v) => v,
        Err(e) => return pages::error(e.status, &e.message),
    };
    if let Some(err) = q.error {
        return pages::error(
            StatusCode::BAD_REQUEST,
            &format!("Sign-in was cancelled ({err})."),
        );
    }
    let (Some(code), Some(state)) = (q.code, q.state) else {
        return pages::error(StatusCode::BAD_REQUEST, "The provider sent no code.");
    };
    if !st.oauth.take_state(&state, provider) {
        return pages::error(
            StatusCode::BAD_REQUEST,
            "This sign-in link expired. Start again from Cuna.",
        );
    }
    let profile = match fetch_profile(&st, provider, &app, &code).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("{} sign-in failed: {e:#}", provider.slug());
            return pages::error(StatusCode::BAD_GATEWAY, &format!("Sign-in failed: {e}"));
        }
    };
    let result = async {
        let user = db::upsert_user(
            &st.db,
            &profile.email,
            profile.name.as_deref(),
            profile.avatar_url.as_deref(),
        )
        .await?;
        let code = auth::create_exchange_code(&st.db, user.id).await?;
        Ok::<_, sqlx::Error>((user, code))
    }
    .await;
    match result {
        Ok((user, code)) => pages::exchange_code(&code, &user.name).into_response(),
        Err(e) => {
            tracing::error!("oauth callback: {e}");
            pages::error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "The hub could not save your account.",
            )
        }
    }
}

async fn fetch_profile(
    st: &AppState,
    provider: Provider,
    app: &OAuthApp,
    code: &str,
) -> anyhow::Result<Profile> {
    let http = &st.oauth.http;
    let redirect = redirect_uri(st, provider);
    #[derive(Deserialize)]
    struct Token {
        access_token: Option<String>,
        error_description: Option<String>,
        error: Option<String>,
    }
    let token_url = match provider {
        Provider::GitHub => "https://github.com/login/oauth/access_token",
        Provider::Google => "https://oauth2.googleapis.com/token",
    };
    let token: Token = http
        .post(token_url)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", app.client_id.as_str()),
            ("client_secret", app.client_secret.as_str()),
            ("code", code),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await?
        .json()
        .await
        .context("token response")?;
    let Some(access) = token.access_token else {
        bail!(
            "{}",
            token
                .error_description
                .or(token.error)
                .unwrap_or_else(|| "no access token".into())
        );
    };

    match provider {
        Provider::GitHub => {
            #[derive(Deserialize)]
            struct User {
                login: String,
                name: Option<String>,
                avatar_url: Option<String>,
            }
            #[derive(Deserialize)]
            struct Email {
                email: String,
                primary: bool,
                verified: bool,
            }
            let user: User = http
                .get("https://api.github.com/user")
                .bearer_auth(&access)
                .send()
                .await?
                .json()
                .await?;
            let emails: Vec<Email> = http
                .get("https://api.github.com/user/emails")
                .bearer_auth(&access)
                .send()
                .await?
                .json()
                .await?;
            let email = emails
                .iter()
                .filter(|e| e.verified)
                .max_by_key(|e| e.primary)
                .map(|e| e.email.to_lowercase())
                .ok_or_else(|| anyhow!("your GitHub account has no verified email address"))?;
            Ok(Profile {
                email,
                name: user.name.or(Some(user.login)),
                avatar_url: user.avatar_url,
            })
        }
        Provider::Google => {
            #[derive(Deserialize)]
            struct Info {
                email: Option<String>,
                email_verified: Option<bool>,
                name: Option<String>,
                picture: Option<String>,
            }
            let info: Info = http
                .get("https://openidconnect.googleapis.com/v1/userinfo")
                .bearer_auth(&access)
                .send()
                .await?
                .json()
                .await?;
            match (info.email, info.email_verified) {
                (Some(email), Some(true)) => Ok(Profile {
                    email: email.to_lowercase(),
                    name: info.name,
                    avatar_url: info.picture,
                }),
                _ => bail!("your Google account has no verified email address"),
            }
        }
    }
}
