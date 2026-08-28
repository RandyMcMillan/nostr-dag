//! Run one federation daemon that watches relay events and publishes acks.
//!
//! Each daemon subscribes to channel messages, tracks DAG state, and emits
//! acknowledgment events that help messages become canonical.

use std::env;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use nostr::{EventId, Filter, Keys, Kind, PublicKey, SecretKey};
use nostr_relay_pool::prelude::*;
use rand::Rng;
use tokio::sync::Mutex;
use tracing::{debug, error, info, trace, warn};

use nostr_dag::{create_ack_event, Dag, InsertResult, DAG_EVENT_KIND};

const CHANNEL_MESSAGE_KIND: Kind = Kind::Custom(42);

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("federation=info".parse()?)
                .add_directive("nostr_relay_pool=warn".parse()?),
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
        if let Err(e) = publish_ack_round_robin(&ack, relay_urls, relay_round).await {
            error!(?e, "Failed to publish ack");
        }
    });
}

async fn publish_ack_round_robin(
    ack: &nostr::Event,
    relay_urls: Arc<Vec<String>>,
    relay_round: Arc<AtomicUsize>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if relay_urls.is_empty() {
        return Ok(());
    }

    let start = relay_round.fetch_add(1, Ordering::Relaxed) % relay_urls.len();
    let ordered_relays = relay_urls
        .iter()
        .cycle()
        .skip(start)
        .take(relay_urls.len())
        .cloned()
        .collect::<Vec<_>>();

    for (index, relay_url) in ordered_relays.iter().enumerate() {
        let pool = RelayPool::default();
        pool.add_relay(relay_url, RelayOptions::default()).await?;
        pool.connect().await;
        info!(relay = %relay_url, ack_id = %ack.id, index, "Publishing acknowledgment via relay");
        if let Err(e) = pool.send_event(ack).await {
            warn!(relay = %relay_url, ?e, "Failed to publish ack via relay");
        }
        if index + 1 < ordered_relays.len() {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    Ok(())
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
