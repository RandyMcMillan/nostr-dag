//! Native CLI entrypoints used by the `federation`, `relay`, and related binaries.
//!
//! The goal of this module is to keep the executable bins thin while the actual
//! runtime behavior lives in the library. That makes it easier to reuse and test
//! the startup logic, relay fanout strategy, and environment parsing.

use std::env;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use nostr::{EventId, Filter, Keys, Kind, PublicKey, SecretKey};
use nostr_relay_pool::prelude::*;
use rand::Rng;
use tokio::sync::Mutex;
use tracing::{debug, error, info, trace, warn};

use crate::{create_ack_event, Dag, InsertResult, DAG_EVENT_KIND};

const CHANNEL_MESSAGE_KIND: Kind = Kind::Custom(42);

/// Run the local Nostr relay used by the demo and federation processes.
#[cfg(feature = "relay")]
pub async fn run_local_relay() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(not(feature = "relay"))]
    {
        return Err("relay feature is required to run the local relay binary".into());
    }

    #[cfg(feature = "relay")]
    {
        use nostr_relay_builder::prelude::*;

        tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::from_default_env().add_directive("relay=info".parse()?),
            )
            .init();

        let port: u16 = env::var("PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(8080);
        debug!(port, "resolved relay port");

        let relay = LocalRelay::new(RelayBuilder::default().port(port));
        info!("starting relay");
        relay.run().await?;

        let url = relay.url().await;
        info!(%url, "Relay running");

        println!("RELAY_URL={}", url);

        trace!("waiting for ctrl_c");
        tokio::signal::ctrl_c().await?;
        info!("relay shutdown requested");
        Ok(())
    }
}

/// Run one federation daemon that watches relay events and publishes acks.
pub async fn run_federation() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("federation=info".parse()?)
                .add_directive("nostr_relay_pool=warn".parse()?)
                // Suppress non-actionable "Invalid format" errors from the local demo relay.
                // The nostr-relay-builder crate sends JSON responses that nostr_relay_pool
                // logs as errors even though the subscription succeeds.
                .add_directive("nostr_relay_pool::relay::inner=off".parse()?),
        )
        .init();

    let secret_key =
        env::var("FEDERATION_KEY").map_err(|_| "FEDERATION_KEY env var required (nsec or hex)")?;
    let keys = parse_keys(&secret_key)?;
    let relay_urls = relay_urls_from_env();

    let federation_pubkeys: Vec<PublicKey> = env::var("FEDERATION_PUBKEYS")
        .map_err(|_| "FEDERATION_PUBKEYS env var required (comma-separated hex pubkeys)")?
        .split(',')
        .map(|s| PublicKey::from_hex(s.trim()))
        .collect::<Result<Vec<_>, _>>()?;

    info!(
        pubkey = %keys.public_key(),
        relays = ?relay_urls,
        federation_size = federation_pubkeys.len(),
        "Starting federation daemon"
    );

    if !federation_pubkeys.contains(&keys.public_key()) {
        warn!("Our pubkey is not in the federation list!");
    }

    let dag = Arc::new(Mutex::new(Dag::new(federation_pubkeys.clone())));
    let pool = RelayPool::default();

    for relay_url in &relay_urls {
        pool.add_relay(relay_url, RelayOptions::default()).await?;
    }
    pool.connect().await;

    tokio::time::sleep(Duration::from_millis(500)).await;

    let filter = Filter::new()
        .kinds([CHANNEL_MESSAGE_KIND, DAG_EVENT_KIND])
        .limit(1000);

    let sub_id = pool.subscribe(filter, SubscribeOptions::default()).await?;
    info!(?sub_id, "Subscribed to channel messages and DAG events");

    let dag_clone = dag.clone();
    let keys_clone = keys.clone();
    let pool_clone = pool.clone();
    let relay_urls = Arc::new(relay_urls);
    let relay_round = Arc::new(AtomicUsize::new(0));

    pool.handle_notifications(move |notification| {
        let dag = dag_clone.clone();
        let keys = keys_clone.clone();
        let pool = pool_clone.clone();
        let relay_urls = relay_urls.clone();
        let relay_round = relay_round.clone();

        async move {
            if let RelayPoolNotification::Event { event, .. } = notification {
                handle_event(&dag, &keys, &pool, &relay_urls, &relay_round, (*event).clone()).await;
            }
            Ok(false)
        }
    })
    .await?;

    Ok(())
}

async fn handle_event(
    dag: &Arc<Mutex<Dag>>,
    keys: &Keys,
    pool: &RelayPool,
    relay_urls: &Arc<Vec<String>>,
    relay_round: &Arc<AtomicUsize>,
    event: nostr::Event,
) {
    let event_id = event.id;
    let event_kind = event.kind;
    let event_author = event.pubkey;
    let is_chat_message = event_kind == CHANNEL_MESSAGE_KIND;

    let mut dag_guard = dag.lock().await;

    match dag_guard.insert(event) {
        InsertResult::Inserted(id) => {
            info!(
                id = %id,
                kind = ?event_kind,
                author = %event_author,
                canonical = dag_guard.is_canonical(id),
                pending = dag_guard.pending_count(),
                "Inserted event"
            );

            if is_chat_message {
                maybe_ack(&mut dag_guard, keys, relay_urls, relay_round);
            }
        }
        InsertResult::Buffered { missing, .. } => {
            debug!(
                id = %event_id,
                ?missing,
                pending = dag_guard.pending_count(),
                "Buffered event (missing parents)"
            );

            let missing: Vec<EventId> = dag_guard.missing_parents().collect();
            drop(dag_guard);

            fetch_missing(pool, &missing).await;
        }
        InsertResult::Duplicate => {}
    }
}

fn maybe_ack(
    dag: &mut Dag,
    keys: &Keys,
    relay_urls: &Arc<Vec<String>>,
    relay_round: &Arc<AtomicUsize>,
) {
    let dominated = dag.participants().contains(&keys.public_key());
    if !dominated {
        trace!(pubkey = %keys.public_key(), "skipping ack: not a federation participant");
        return;
    }

    let tips: Vec<EventId> = dag.tips().collect();
    trace!(tip_count = tips.len(), "evaluating ack round");

    let unacked_tips: Vec<EventId> = tips
        .iter()
        .filter(|id| {
            dag.seen_by(**id)
                .map(|s| !s.contains(&keys.public_key()))
                .unwrap_or(true)
        })
        .copied()
        .collect();

    if unacked_tips.is_empty() {
        trace!("skipping ack: all tips already seen");
        return;
    }

    let ack = match create_ack_event(keys, &tips) {
        Ok(ack) => ack,
        Err(e) => {
            error!(?e, "Failed to create ack event");
            return;
        }
    };

    let delay_ms = rand::thread_rng().gen_range(0..10_000);
    let relay_urls = relay_urls.clone();
    let relay_round = relay_round.clone();

    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        info!(ack_id = %ack.id, delay_ms, "Publishing acknowledgment");
        match publish_ack_round_robin(&ack, relay_urls, relay_round).await {
            Ok(0) => warn!(ack_id = %ack.id, "No relays accepted the ack"),
            Ok(sent) => info!(ack_id = %ack.id, sent, "Published ack"),
            Err(e) => error!(?e, "Failed to publish ack"),
        }
    });
}

async fn publish_ack_round_robin(
    ack: &nostr::Event,
    relay_urls: Arc<Vec<String>>,
    relay_round: Arc<AtomicUsize>,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    if relay_urls.is_empty() {
        return Ok(0);
    }

    let start = relay_round.fetch_add(1, Ordering::Relaxed) % relay_urls.len();
    let ordered_relays = round_robin_order(&relay_urls, start);
    let mut succeeded = 0usize;

    for (index, relay_url) in ordered_relays.iter().enumerate() {
        let pool = RelayPool::default();
        if let Err(e) = pool.add_relay(relay_url, RelayOptions::default()).await {
            warn!(relay = %relay_url, ack_id = %ack.id, ?e, "Skipping relay: failed to add");
            continue;
        }
        pool.connect().await;
        info!(relay = %relay_url, ack_id = %ack.id, index, "Publishing acknowledgment via relay");
        if let Err(e) = pool.send_event(ack).await {
            warn!(relay = %relay_url, ?e, "Failed to publish ack via relay");
        } else {
            succeeded += 1;
        }
        if index + 1 < ordered_relays.len() {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    Ok(succeeded)
}

fn round_robin_order(relay_urls: &[String], start: usize) -> Vec<String> {
    if relay_urls.is_empty() {
        return Vec::new();
    }
    let start = start % relay_urls.len();
    relay_urls
        .iter()
        .cycle()
        .skip(start)
        .take(relay_urls.len())
        .cloned()
        .collect()
}

async fn fetch_missing(pool: &RelayPool, missing: &[EventId]) {
    for id in missing {
        debug!(%id, "Fetching missing event");
        let filter = Filter::new().id(*id);
        if let Err(e) = pool
            .fetch_events(filter, Duration::from_secs(5), ReqExitPolicy::default())
            .await
        {
            debug!(?e, %id, "Failed to fetch missing event");
        }
    }
}

fn parse_keys(s: &str) -> Result<Keys, Box<dyn std::error::Error>> {
    if s.starts_with("nsec") {
        Ok(Keys::parse(s)?)
    } else {
        let sk = SecretKey::from_hex(s)?;
        Ok(Keys::new(sk))
    }
}

fn relay_urls_from_env() -> Vec<String> {
    let candidates = env::var("RELAY_URLS")
        .ok()
        .map(|value| value.split(',').map(str::trim).map(str::to_string).collect::<Vec<_>>())
        .unwrap_or_else(|| {
            env::var("RELAY_URL")
                .ok()
                .map(|value| vec![value])
                .unwrap_or_else(|| vec!["ws://localhost:8080".to_string()])
        });

    let mut deduped = Vec::new();
    for candidate in candidates {
        let trimmed = candidate.trim();
        if trimmed.is_empty() {
            continue;
        }
        let normalized = trimmed.trim_end_matches('/').to_string();
        if !deduped.iter().any(|existing| existing == &normalized) {
            deduped.push(normalized);
        }
    }
    deduped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_urls_from_env_dedupes_and_trims() {
        let original_urls = env::var("RELAY_URLS").ok();
        let original_url = env::var("RELAY_URL").ok();

        env::set_var("RELAY_URLS", " wss://one.example/ , wss://two.example, wss://one.example ");
        env::remove_var("RELAY_URL");

        let urls = relay_urls_from_env();
        assert_eq!(urls, vec!["wss://one.example", "wss://two.example"]);

        match original_urls {
            Some(value) => env::set_var("RELAY_URLS", value),
            None => env::remove_var("RELAY_URLS"),
        }
        match original_url {
            Some(value) => env::set_var("RELAY_URL", value),
            None => env::remove_var("RELAY_URL"),
        }
    }

    #[test]
    fn round_robin_order_rotates_without_dropping_relays() {
        let relays = vec![
            "wss://one.example".to_string(),
            "wss://two.example".to_string(),
            "wss://three.example".to_string(),
        ];

        assert_eq!(
            round_robin_order(&relays, 0),
            vec![
                "wss://one.example".to_string(),
                "wss://two.example".to_string(),
                "wss://three.example".to_string(),
            ]
        );
        assert_eq!(
            round_robin_order(&relays, 1),
            vec![
                "wss://two.example".to_string(),
                "wss://three.example".to_string(),
                "wss://one.example".to_string(),
            ]
        );
    }
}

/// Run the keygen CLI logic (generate 5 federation keys and print config).
#[cfg(feature = "native")]
pub fn run_keygen() {
    use nostr::Keys;
    use tracing::{debug, info, trace};

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

/// Run the git-info CLI logic.
#[cfg(feature = "native")]
pub fn run_git_info(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    use crate::git::native::{blame, log, open_repo};

    if args.len() < 3 {
        eprintln!("Usage:");
        eprintln!("  git-info log   <repo-path> [limit]");
        eprintln!("  git-info blame <repo-path> <file-path> [commit-ish]");
        std::process::exit(1);
    }

    let subcommand = args[1].as_str();
    let repo_path = &args[2];

    let repo = open_repo(repo_path)?;

    match subcommand {
        "log" => {
            let limit: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(20);
            let commits = log(&repo, limit)?;
            println!("{}", serde_json::to_string_pretty(&commits)?);
        }
        "blame" => {
            let file_path = args.get(3).ok_or("blame requires a file-path argument")?;
            let commit_ish = args.get(4).map(String::as_str).unwrap_or("HEAD");
            let hunks = blame(&repo, file_path, commit_ish)?;
            println!("{}", serde_json::to_string_pretty(&hunks)?);
        }
        other => {
            eprintln!("Unknown subcommand: {other}");
            std::process::exit(1);
        }
    }

    Ok(())
}

/// Run the P2P chat peer.
///
/// Starts a full-stack native libp2p node and provides a stdin/stdout chat
/// interface.  Messages are broadcast as `nostr-dag-chat` protocol frames over
/// the shared `nostr-dag-bridge` gossipsub topic so they interoperate with
/// browser (WASM/JS) peers on GitHub Pages.
#[cfg(feature = "p2p")]
pub async fn run_chat() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("chat=info".parse().unwrap())
                .add_directive("p2p_node=info".parse().unwrap()),
        )
        .try_init();

    println!("╔═══════════════════════════════════════════╗");
    println!("║     nostr-dag P2P Chat                    ║");
    println!("╚═══════════════════════════════════════════╝");
    println!("Type /chat <message> to broadcast to all peers");
    println!("Type /help for all commands, /quit to exit");
    println!();

    crate::p2p_node::run_native_p2p_node(None).await
}

