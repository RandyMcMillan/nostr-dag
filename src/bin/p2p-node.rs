#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    nostr_dag::run_native_p2p_node().await
}
