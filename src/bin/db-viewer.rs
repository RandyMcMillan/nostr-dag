//! nostr-dag DB viewer — thin wrapper around `nostr_dag::db_viewer::run_db_viewer`.

const DB_PATH_DEFAULT: &str = "nostr-dag.db";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let db_path = std::env::var("DB_PATH").unwrap_or_else(|_| DB_PATH_DEFAULT.to_string());
    nostr_dag::run_db_viewer(&db_path)
}
