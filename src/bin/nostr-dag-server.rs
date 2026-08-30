//! Serve the built demo site locally from `site/`.
//!
//! Thin wrapper around `nostr_dag::server::run_server`.  The actual
//! implementation lives in `src/server.rs` so it can be reused by the
//! unified `nostr-dag` CLI.

use std::env;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: &str = "3000";
const DEFAULT_SITE_DIR: &str = "site";
const DEFAULT_DB_PATH: &str = "nostr-dag.db";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("server=info".parse()?),
        )
        .init();

    let host = env::var("HOST").unwrap_or_else(|_| DEFAULT_HOST.to_string());
    let port = env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| DEFAULT_PORT.parse().unwrap());
    let site_dir = env::var("SITE_DIR").unwrap_or_else(|_| DEFAULT_SITE_DIR.to_string());
    let db_path = env::var("DB_PATH").unwrap_or_else(|_| DEFAULT_DB_PATH.to_string());
    let embed_p2p = env::var("P2P_ENABLE").map(|v| v == "1").unwrap_or(false);

    nostr_dag::server::run_server(&host, port, &site_dir, &db_path, embed_p2p).await
}
