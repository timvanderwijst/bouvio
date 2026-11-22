//! Email codes, sessions, the OAuth exchange code, and the bearer-token extractor.

use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::Json;
use cuna_protocol::HubUser;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::{self, now_ms, sha256_hex, Db};
use crate::error::{ApiError, ApiResult};
use crate::AppState;

const CODE_TTL_MS: i64 = 10 * 60 * 1000;
const HOUR_MS: i64 = 60 * 60 * 1000;
const MAX_CODES_PER_HOUR: i64 = 5;
const MAX_ATTEMPTS: i64 = 5;

/// The signed-in user behind an `Authorization: Bearer <token>` header.
pub struct AuthUser {
    pub user: HubUser,
    pub token: String,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(|t| t.trim().to_string())
            .ok_or_else(|| ApiError::unauthorized("missing bearer token"))?;
        let user = authenticate(&state.db, &token).await?;
        Ok(AuthUser { user, token })
    }
}

pub async fn authenticate(db: &Db, token: &str) -> ApiResult<HubUser> {
    db::user_by_token(db, token)
        .await?
        .ok_or_else(|| ApiError::unauthorized("invalid or expired token"))
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: HubUser,
}

async fn sign_in(db: &Db, user: HubUser) -> ApiResult<Json<AuthResponse>> {
    let token = db::create_session(db, user.id).await?;
    Ok(Json(AuthResponse { token, user }))
}

fn normalize_email(raw: &str) -> ApiResult<String> {
    let email = raw.trim().to_lowercase();
    let valid = email.len() <= 254
        && !email.contains(char::is_whitespace)
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty() && domain.contains('.') && !domain.contains('@')
        });
    if valid {
        Ok(email)
    } else {
        Err(ApiError::bad_request(
            "that does not look like an email address",
        ))
    }
}

fn code_hash(email: &str, code: &str) -> String {
    sha256_hex(&format!("{email}:{code}"))
}

#[derive(Deserialize)]
pub struct EmailStart {
    email: String,
}

#[derive(Serialize)]
pub struct EmailStarted {
    ok: bool,
    /// Only with `CUNA_HUB_DEV_CODES=1`.
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
}

pub async fn email_start(
    State(st): State<AppState>,
    Json(body): Json<EmailStart>,
) -> ApiResult<Json<EmailStarted>> {
    let email = normalize_email(&body.email)?;
    let now = now_ms();
    let (recent,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM email_codes WHERE email = ? AND created_at > ?")
            .bind(&email)
            .bind(now - HOUR_MS)
            .fetch_one(&st.db)
            .await?;
    if recent >= MAX_CODES_PER_HOUR {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too many codes for this address; try again in an hour",
        ));
    }

    let code = db::random_digits(6);
    sqlx::query(
        "INSERT INTO email_codes (email, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&email)
    .bind(code_hash(&email, &code))
    .bind(now)
    .bind(now + CODE_TTL_MS)
    .execute(&st.db)
    .await?;

    match &st.mailer {
        Some(mailer) => mailer.send_code(&email, &code).await.map_err(|e| {
            tracing::error!("mail to {email}: {e:#}");
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                "could not send the mail; check the hub's SMTP settings",
            )
        })?,
        None => tracing::info!(%email, %code, "login code (SMTP not configured)"),
    }
    Ok(Json(EmailStarted {
        ok: true,
        code: st.config.dev_codes.then_some(code),
    }))
}

#[derive(Deserialize)]
pub struct EmailVerify {
    email: String,
    code: String,
    name: Option<String>,
}

pub async fn email_verify(
    State(st): State<AppState>,
    Json(body): Json<EmailVerify>,
) -> ApiResult<Json<AuthResponse>> {
    let email = normalize_email(&body.email)?;
    let invalid = || ApiError::unauthorized("wrong or expired code");
    let row: Option<(i64, String, i64)> = sqlx::query_as(
        "SELECT id, code_hash, attempts FROM email_codes
         WHERE email = ? AND used = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&email)
    .bind(now_ms())
    .fetch_optional(&st.db)
    .await?;
    let (id, hash, attempts) = row.ok_or_else(invalid)?;
    if attempts >= MAX_ATTEMPTS {
        return Err(invalid());
    }
    if hash != code_hash(&email, body.code.trim()) {
        sqlx::query("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?")
            .bind(id)
            .execute(&st.db)
            .await?;
        return Err(invalid());
    }
    sqlx::query("UPDATE email_codes SET used = 1 WHERE id = ?")
        .bind(id)
        .execute(&st.db)
        .await?;
    let user = db::upsert_user(&st.db, &email, body.name.as_deref(), None).await?;
    sign_in(&st.db, user).await
}

/// One-time code shown in the browser after OAuth, pasted into the app.
pub async fn create_exchange_code(db: &Db, user_id: Uuid) -> sqlx::Result<String> {
    let code = db::random_code(8);
    sqlx::query("INSERT INTO exchange_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .bind(sha256_hex(&code))
        .bind(user_id.to_string())
        .bind(now_ms() + CODE_TTL_MS)
        .execute(db)
        .await?;
    Ok(code)
}

#[derive(Deserialize)]
pub struct Exchange {
    code: String,
}

pub async fn exchange(
    State(st): State<AppState>,
    Json(body): Json<Exchange>,
) -> ApiResult<Json<AuthResponse>> {
    let code: String = body
        .code
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_uppercase();
    let row: Option<(String,)> = sqlx::query_as(
        "DELETE FROM exchange_codes WHERE code_hash = ? AND expires_at > ? RETURNING user_id",
    )
    .bind(sha256_hex(&code))
    .bind(now_ms())
    .fetch_optional(&st.db)
    .await?;
    let invalid = || ApiError::unauthorized("wrong or expired code");
    let (user_id,) = row.ok_or_else(invalid)?;
    let user_id = Uuid::parse_str(&user_id).map_err(|_| invalid())?;
    let user = db::user_by_id(&st.db, user_id).await?.ok_or_else(invalid)?;
    sign_in(&st.db, user).await
}

pub async fn me(auth: AuthUser) -> Json<HubUser> {
    Json(auth.user)
}

pub async fn logout(State(st): State<AppState>, auth: AuthUser) -> ApiResult<StatusCode> {
    db::delete_session(&st.db, &auth.token).await?;
    Ok(StatusCode::NO_CONTENT)
}
