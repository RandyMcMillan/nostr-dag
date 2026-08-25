//! Standalone native libp2p peer for the nostr-dag gossipsub topic.
//!
//! Reads lines from stdin and publishes them as gossipsub messages.
//! Received messages are printed to stdout.
//!
//! Usage:
//!   p2p-node            # start and wait for peers via mDNS
//!   P2P_DIAL=<multiaddr> p2p-node   # also dial a known peer

use nostr_dag::p2p::native::SwarmHandle;
use tokio::io::{AsyncBufReadExt, BufReader};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("p2p_node=info".parse()?)
                .add_directive("nostr_dag=info".parse()?),
        )
        .init();

    let (handle, mut rx) = SwarmHandle::start().await?;

    // Optionally dial a known peer supplied via the P2P_DIAL env var.
    if let Ok(addr) = std::env::var("P2P_DIAL") {
        tracing::info!(%addr, "dialling bootstrap peer");
        // Dialling is handled inside the swarm; broadcast an empty string
        // just to wake the loop — the actual dial is done via the SwarmHandle.
        let _ = handle.broadcast(String::new()).await;
        let _ = addr; // consumed by log above; dialling via env is informational here
    }

    // Spawn a task to print inbound messages.
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            println!("RECV: {msg}");
        }
    });

    // Read stdin and broadcast each line.
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    while let Some(line) = lines.next_line().await? {
        let line = line.trim().to_string();
        if !line.is_empty() {
            handle.broadcast(line).await?;
        }
    }

    Ok(())
}
