//! Bouvio hub: accounts, sharing, permissions, realtime relay, people chat and
//! presence. It never calls an AI model; runners do that.

mod auth;
mod config;
mod db;
mod error;
mod hub;
mod mail;
mod oauth;
mod pages;
mod workspaces;
mod ws;

use std::sync::Arc;

use axum::routing::{get, patch, post};
use axum::Router;
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

pub use config::{Config, OAuthApp};

#[derive(Clone)]
pub struct AppState {
    db: db::Db,
    hub: Arc<hub::Hub>,
    config: Arc<Config>,
    mailer: Option<Arc<mail::Mailer>>,
    oauth: Arc<oauth::OAuth>,
}

pub async fn router(config: Config) -> anyhow::Result<Router> {
    let db = db::connect(&config.db_url).await?;
    let mailer = match &config.smtp_url {
        Some(url) => Some(Arc::new(mail::Mailer::new(url, &config.smtp_from)?)),
        None => None,
    };
    if mailer.is_none() {
        tracing::info!("SMTP_URL not set: login codes are written to this log");
    }
    if config.dev_codes {
        tracing::warn!("BOUVIO_HUB_DEV_CODES is on: login codes are returned over HTTP. Never use this in production.");
    }
    let state = AppState {
        hub: Arc::new(hub::Hub::new(db.clone())),
        db,
        oauth: Arc::new(oauth::OAuth::new()?),
        mailer,
        config: Arc::new(config),
    };

    Ok(Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/auth/email/start", post(auth::email_start))
        .route("/auth/email/verify", post(auth::email_verify))
        .route("/auth/exchange", post(auth::exchange))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/{provider}/start", get(oauth::start))
        .route("/auth/{provider}/callback", get(oauth::callback))
        .route("/me", get(auth::me))
        .route(
            "/workspaces",
            get(workspaces::list).post(workspaces::create),
        )
        .route("/workspaces/{id}/members", get(workspaces::members))
        .route(
            "/workspaces/{id}/members/{user_id}",
            patch(workspaces::update_member).delete(workspaces::remove_member),
        )
        .route("/workspaces/{id}/invites", post(workspaces::create_invite))
        .route("/workspaces/{id}/chat", get(workspaces::chat_history))
        .route("/invite/{code}", get(pages::invite))
        .route("/invites/{code}/accept", post(workspaces::accept_invite))
        .route("/ws", get(ws::upgrade))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state))
}

/// Serves the hub on an already bound listener until the process ends.
pub async fn serve(config: Config, listener: TcpListener) -> anyhow::Result<()> {
    let app = router(config).await?;
    tracing::info!("bouvio hub listening on {}", listener.local_addr()?);
    axum::serve(listener, app).await?;
    Ok(())
}
