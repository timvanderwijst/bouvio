use cuna_hub::Config;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,tower_http=info")),
        )
        .init();
    let config = Config::from_env();
    let listener = tokio::net::TcpListener::bind(&config.addr).await?;
    cuna_hub::serve(config, listener).await
}
