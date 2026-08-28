#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    nostr_dag::run_local_relay().await
}
