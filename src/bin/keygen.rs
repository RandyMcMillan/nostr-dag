//! Print demo federation keys for local development.
//!
//! This helper generates a small participant set, prints secret/public keys,
//! and shows the `cargo run --bin federation` commands for each daemon.

use nostr::Keys;
use tracing::{debug, info, trace};

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("keygen=info".parse().unwrap()),
        )
        .init();

    info!("starting federation key generation");
    println!("Generating 5 federation keys...\n");

    let mut pubkeys = Vec::new();
    let mut secrets = Vec::new();

    for i in 1..=5 {
        trace!(member = i, "generating keypair");
        let keys = Keys::generate();
        let sk_hex = keys.secret_key().to_secret_hex();
        let pk_hex = keys.public_key().to_hex();

        debug!(member = i, pubkey = %pk_hex, "generated keypair");
        println!("=== Federation Member {} ===", i);
        println!("Secret key: {}", sk_hex);
        println!("Public key: {}", pk_hex);
        println!();

        secrets.push(sk_hex);
        pubkeys.push(pk_hex);
    }

    let all_pubkeys = pubkeys.join(",");
    info!(member_count = pubkeys.len(), "finished federation key generation");

    println!("=== Configuration ===\n");
    println!("FEDERATION_PUBKEYS={}\n", all_pubkeys);

    println!("=== Start Commands ===\n");
    for (i, sk) in secrets.iter().enumerate() {
        println!(
            "# Terminal {}\nFEDERATION_KEY={} RELAY_URL=ws://localhost:8080 FEDERATION_PUBKEYS={} cargo run --bin federation\n",
            i + 1,
            sk,
            all_pubkeys
        );
    }

    println!("=== Frontend Config ===\n");
    println!("Paste this into the 'Federation Pubkeys' field:\n{}", all_pubkeys);
}
