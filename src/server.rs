//! Serve the built demo site locally from `site/`.
//!
//! This is a small static file server for local preview. It expects `site/`
//! to contain the WASM build output and `index.html`, and it prints
//! `SERVER_URL=...` on startup.

use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, Semaphore};
use tokio::task::JoinSet;
use tracing::{debug, error, info, trace};

use crate::store::EventStore;
use crate::FAVICON_ICO;

const LOGGER_ROUTE_PREFIX: &str = "/logger";
const LOGGER_MAX_ENTRIES: usize = 10_000;
const PEERS_ROUTE_PREFIX: &str = "/peers";
const NIP11_ROUTE_PREFIX: &str = "/nip11";
const NIP11_MAX_CONCURRENT: usize = 8;
/// Route prefix for the event store REST API.
const EVENTS_ROUTE_PREFIX: &str = "/events";
/// Route prefix for the HTTP chat relay API.
const CHAT_ROUTE_PREFIX: &str = "/chat";
const CHAT_MAX_MESSAGES: usize = 500;
/// Public GitHub Pages deployment of the bridge (WASM peer).
const GH_PAGES_BRIDGE_URL: &str = "https://randymcmillan.github.io/nostr-dag/bridge/";

#[derive(Clone, Debug, Serialize, Deserialize)]
struct LoggerEntry {
    time: String,
    label: String,
    text: String,
    level: String,
    state: String,
    source: String,
}

#[derive(Default)]
struct LoggerStore {
    entries: Mutex<Vec<LoggerEntry>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PeerEntry {
    peer_id: String,
    kind: String,
    path: String,
    detail: Option<String>,
    source: Option<String>,
    updated_at: u64,
}

#[derive(Default)]
struct PeerStore {
    entries: Mutex<std::collections::BTreeMap<String, PeerEntry>>,
}

/// Peers that haven't reported in this long are evicted from the store.
const PEER_TTL_MS: u64 = 300_000; // 5 minutes

static NIP11_SEMAPHORE: OnceLock<Semaphore> = OnceLock::new();

fn nip11_semaphore() -> &'static Semaphore {
    NIP11_SEMAPHORE.get_or_init(|| Semaphore::new(NIP11_MAX_CONCURRENT))
}

/// Thread-safe wrapper around the SQLite [`EventStore`].
struct EventStoreState {
    inner: Mutex<EventStore>,
}

impl EventStoreState {
    fn new(path: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let store = EventStore::open(path)?;
        Ok(Self {
            inner: Mutex::new(store),
        })
    }
}

impl LoggerStore {
    fn push(&self, entry: LoggerEntry) {
        let mut entries = self.entries.lock().expect("logger store poisoned");
        entries.push(entry);
        if entries.len() > LOGGER_MAX_ENTRIES {
            let overflow = entries.len() - LOGGER_MAX_ENTRIES;
            entries.drain(0..overflow);
        }
    }

    fn filter_level(&self, level: &str) -> Vec<LoggerEntry> {
        let entries = self.entries.lock().expect("logger store poisoned");
        entries
            .iter()
            .filter(|entry| entry.level == level)
            .cloned()
            .collect()
    }

    fn all(&self) -> Vec<LoggerEntry> {
        self.entries.lock().expect("logger store poisoned").clone()
    }
}

impl PeerStore {
    fn upsert(&self, entry: PeerEntry) {
        let mut entries = self.entries.lock().expect("peer store poisoned");
        entries.insert(format!("{}:{}", entry.path, entry.peer_id), entry);
    }

    fn all(&self) -> Vec<PeerEntry> {
        let mut entries = self.entries.lock().expect("peer store poisoned");
        let now = now_ms();
        let before = entries.len();
        // Never prune well-known peers (e.g. gh-pages deployment) so the
        // /peers endpoint always has a bootstrap reference.
        entries.retain(|_, entry| {
            entry.source.as_deref() == Some("well-known")
                || entry.source.as_deref() == Some("localhost")
                || now.saturating_sub(entry.updated_at) < PEER_TTL_MS
        });
        let pruned = before.saturating_sub(entries.len());
        if pruned > 0 {
            tracing::debug!("pruned {} stale peer(s)", pruned);
        }
        entries.values().cloned().collect()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ChatMessage {
    from: String,
    text: String,
    timestamp: u64,
    id: String,
}

#[derive(Default)]
struct ChatStore {
    entries: Mutex<Vec<ChatMessage>>,
}

impl ChatStore {
    fn push(&self, entry: ChatMessage) {
        let mut entries = self.entries.lock().expect("chat store poisoned");
        entries.push(entry);
        if entries.len() > CHAT_MAX_MESSAGES {
            let overflow = entries.len() - CHAT_MAX_MESSAGES;
            entries.drain(0..overflow);
        }
    }

    fn since(&self, timestamp: u64) -> Vec<ChatMessage> {
        let entries = self.entries.lock().expect("chat store poisoned");
        entries.iter().filter(|e| e.timestamp > timestamp).cloned().collect()
    }
}

pub async fn run_server(
    host: &str,
    port: u16,
    site_dir: &str,
    db_path: &str,
    _embed_p2p: bool,
    extra_path: Option<&str>,
    extra_recursive: bool,
    extra_depth: usize,
) -> Result<(), Box<dyn std::error::Error>> {
    let site_dir = if std::path::Path::new(site_dir).is_dir() {
        site_dir.to_string()
    } else {
        println!("WARN site_dir '{site_dir}' not found, falling back to 'demo/'");
        "demo".to_string()
    };
    let extra_path = extra_path.and_then(|p| {
        let meta = std::fs::metadata(p).ok()?;
        if meta.is_dir() {
            Some(p.to_string())
        } else {
            println!("WARN extra_path '{p}' is not a directory, ignoring");
            None
        }
    });
    let logger_store = Arc::new(LoggerStore::default());
    let peer_store = Arc::new(PeerStore::default());
    let chat_store = Arc::new(ChatStore::default());
    // Seed the peer store with the public GitHub Pages deployment so
    // db-viewer and /peers consumers always have a well-known remote peer.
    peer_store.upsert(PeerEntry {
        peer_id: "gh-pages".to_string(),
        kind: "wasm".to_string(),
        path: GH_PAGES_BRIDGE_URL.to_string(),
        detail: Some("GitHub Pages deployment (WASM peer)".to_string()),
        source: Some("well-known".to_string()),
        updated_at: now_ms(),
    });
    let event_store = Arc::new(EventStoreState::new(&db_path).unwrap_or_else(|err| {
        error!(?err, %db_path, "failed to open event store, using in-memory fallback");
        EventStoreState::new(":memory:").expect("in-memory event store")
    }));
    let http_client = Arc::new(
        reqwest::Client::builder()
            .user_agent("nostr-dag/0.9.1")
            .build()?,
    );
    let (shutdown_tx, shutdown_rx) = watch::channel(());

    // Optionally start a full-stack native libp2p peer in-process so there is
    // always another peer on the network with full protocol support.
    // Enable with --p2p or P2P_ENABLE=1.
    #[cfg(feature = "p2p")]
    let mut p2p_task: Option<tokio::task::JoinHandle<()>> = None;
    #[cfg(feature = "p2p")]
    if _embed_p2p {
        info!("starting embedded full-stack p2p-node peer");
        // Default repos to mirror via NIP-PIP so browsers can discover bundles
        // without relying on public CORS proxies.
        const DEFAULT_MIRROR_REPOS: &str = concat!(
            "https://github.com/RandyMcMillan/nostr-dag,",
            "https://github.com/isomorphic-git/isomorphic-git,",
            "https://github.com/nbd-wtf/nostr-tools,",
            "https://github.com/libp2p/js-libp2p,",
            "https://github.com/ChainSafe/js-libp2p-noise,",
            "https://github.com/ChainSafe/js-libp2p-yamux,",
            "https://github.com/ChainSafe/discv5,",
            "https://github.com/isomorphic-git/lightning-fs,",
            "https://github.com/w-s-bitcoin/entropylab,",
            "https://github.com/nostr-protocol/nips",
        );
        let mirror_repos = std::env::var("GIT_MIRROR_REPOS")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_MIRROR_REPOS.to_string());
        std::env::set_var("GIT_MIRROR_REPOS", mirror_repos);
        // Seed the peer store with the local embedded peer so /peers and
        // db-viewer always show it even before gossipsub discovers anyone.
        #[cfg(feature = "p2p")]
        {
            let local_peer_id = crate::p2p::deterministic_native_identity_keypair()
                .public()
                .to_peer_id()
                .to_string();
            peer_store.upsert(PeerEntry {
                peer_id: local_peer_id.clone(),
                kind: "native".to_string(),
                path: "/".to_string(),
                detail: Some(format!("embedded peer {local_peer_id}")),
                source: Some("localhost".to_string()),
                updated_at: now_ms(),
            });
        }
        let shared_listen_addrs = std::sync::Arc::new(tokio::sync::RwLock::new(Vec::<String>::new()));
        let listen_addrs_for_peer_store = Arc::clone(&shared_listen_addrs);
        let peer_store_for_p2p = Arc::clone(&peer_store);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                let addrs = listen_addrs_for_peer_store.read().await.clone();
                if addrs.is_empty() {
                    continue;
                }
                let peer_id = crate::p2p::deterministic_native_identity_keypair()
                    .public()
                    .to_peer_id()
                    .to_string();
                let detail = format!("embedded peer {} addrs={}", peer_id, addrs.join(","));
                peer_store_for_p2p.upsert(PeerEntry {
                    peer_id,
                    kind: "native".to_string(),
                    path: "/".to_string(),
                    detail: Some(detail),
                    source: Some("localhost".to_string()),
                    updated_at: now_ms(),
                });
            }
        });
        p2p_task = Some(tokio::spawn(async move {
            if let Err(e) = crate::run_native_p2p_node(Some(shared_listen_addrs)).await {
                tracing::error!(?e, "embedded p2p-node exited with error");
            }
        }));
    } else {
        #[cfg(feature = "p2p")]
        println!("[peer] P2P feature enabled but embed_p2p=false; peer not started");
    }

    let addr = format!("{host}:{port}");
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            tracing::warn!(%addr, "port in use, falling back to system-assigned port");
            TcpListener::bind(format!("{host}:0")).await?
        }
        Err(e) => return Err(e.into()),
    };
    let bound_addr = listener.local_addr()?;
    let mut connections = JoinSet::new();

    info!(%bound_addr, site_dir = %site_dir, %db_path, "nostr-dag server listening");
    println!("SERVER_URL=http://{bound_addr}");

    loop {
        tokio::select! {
            result = listener.accept() => {
                let (stream, peer) = result?;
                let site_dir = site_dir.clone();
                let logger_store = Arc::clone(&logger_store);
                let peer_store = Arc::clone(&peer_store);
                let chat_store = Arc::clone(&chat_store);
                let event_store = Arc::clone(&event_store);
                let http_client = Arc::clone(&http_client);
                let connection_shutdown = shutdown_rx.clone();
                let extra_path = extra_path.clone();
                connections.spawn(async move {
                    if let Err(err) = handle_connection(stream, &site_dir, extra_path.as_deref(), extra_recursive, extra_depth, logger_store, peer_store, chat_store, event_store, http_client, connection_shutdown).await {
                        if is_disconnect_error(&err) || err.kind() == io::ErrorKind::Interrupted {
                            trace!(%peer, ?err, "client disconnected");
                        } else {
                            error!(%peer, ?err, "request failed");
                        }
                    }
                });
            }
            _ = tokio::signal::ctrl_c() => {
                info!("shutdown requested");
                let _ = shutdown_tx.send(());
                break;
            }
        }
    }

    info!("draining active requests");
    while let Some(result) = connections.join_next().await {
        if let Err(err) = result {
            error!(?err, "request task failed during shutdown");
        }
    }

    #[cfg(feature = "p2p")]
    if let Some(task) = p2p_task {
        info!("aborting embedded p2p-node peer");
        task.abort();
        let _ = task.await;
    }

    info!("shutdown complete");

    Ok(())
}

async fn handle_connection(
    mut stream: TcpStream,
    site_dir: &str,
    extra_path: Option<&str>,
    extra_recursive: bool,
    extra_depth: usize,
    logger_store: Arc<LoggerStore>,
    peer_store: Arc<PeerStore>,
    chat_store: Arc<ChatStore>,
    event_store: Arc<EventStoreState>,
    http_client: Arc<reqwest::Client>,
    mut shutdown_rx: watch::Receiver<()>,
) -> io::Result<()> {
    let request_bytes = read_http_request(&mut stream, &mut shutdown_rx).await?;
    if request_bytes.is_empty() {
        return Ok(());
    }

    let request = String::from_utf8_lossy(&request_bytes);
    let mut lines = request.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let request_target = parts.next().unwrap_or("/");
    let path = strip_query(request_target);
    debug!(%method, %path, "request received");
    let body = request_body(&request);
    let body_bytes = request_body_bytes(&request_bytes);

    let head_only = method == "HEAD";
    let directory_redirect = if (method == "GET" || method == "HEAD")
        && path != "/"
        && !path.ends_with('/')
        && !path.starts_with(LOGGER_ROUTE_PREFIX)
        && !path.starts_with(PEERS_ROUTE_PREFIX)
        && !path.starts_with(NIP11_ROUTE_PREFIX)
        && !path.starts_with(EVENTS_ROUTE_PREFIX)
    {
        canonical_directory_redirect(site_dir, extra_path, path, request_target).await
    } else {
        None
    };
    // Redirect bare root to /git/, which is the default landing page.
    let response = if (method == "GET" || method == "HEAD") && path == "/" {
        trace!("redirecting / to /git/");
        response_redirect("/git/")
    } else if let Some(location) = directory_redirect {
        trace!(from = %path, to = %location, "redirecting directory path to trailing slash");
        response_redirect(&location)
    } else if method == "POST" && (path == LOGGER_ROUTE_PREFIX || path.starts_with("/logger/")) {
        match handle_logger_post(body, &logger_store) {
            Ok(()) => response_bytes(
                204,
                "No Content",
                Vec::new(),
                "text/plain; charset=utf-8",
                true,
            ),
            Err(err) => {
                error!(?err, "logger ingest failed");
                response_text(
                    400,
                    "Bad Request",
                    "Bad Request",
                    "text/plain; charset=utf-8",
                )
            }
        }
    } else if method == "POST" && (path == PEERS_ROUTE_PREFIX || path.starts_with("/peers/")) {
        match handle_peer_post(body, &peer_store) {
            Ok(()) => response_bytes(
                204,
                "No Content",
                Vec::new(),
                "text/plain; charset=utf-8",
                true,
            ),
            Err(err) => {
                error!(?err, "peer ingest failed");
                response_text(
                    400,
                    "Bad Request",
                    "Bad Request",
                    "text/plain; charset=utf-8",
                )
            }
        }
    } else if method == "GET" && path == NIP11_ROUTE_PREFIX {
        tokio::select! {
            result = handle_nip11_get(&request, &http_client) => match result {
                Ok((body, content_type)) => response_bytes(200, "OK", body, content_type, head_only),
                Err(RouteError::BadRequest) => {
                    response_text(400, "Bad Request", "Bad Request", "text/plain; charset=utf-8")
                }
                Err(RouteError::NotFound) => {
                    response_text(404, "Not Found", "Not Found", "text/plain; charset=utf-8")
                }
                Err(RouteError::Io(err)) => {
                    trace!(?err, path = %path, "failed to proxy nip11 payload");
                    response_text(502, "Bad Gateway", "Bad Gateway", "text/plain; charset=utf-8")
                }
            },
            _ = shutdown_rx.changed() => {
                return Err(io::Error::new(io::ErrorKind::Interrupted, "shutdown requested"));
            }
        }
    } else if method == "POST" && (path == EVENTS_ROUTE_PREFIX || path.starts_with("/events/")) {
        match handle_events_post(body, &event_store).await {
            Ok(()) => response_bytes(
                204,
                "No Content",
                Vec::new(),
                "text/plain; charset=utf-8",
                true,
            ),
            Err(err) => {
                error!(?err, "event ingest failed");
                response_text(
                    400,
                    "Bad Request",
                    "Bad Request",
                    "text/plain; charset=utf-8",
                )
            }
        }
    } else if method == "POST" && (path == CHAT_ROUTE_PREFIX || path.starts_with("/chat/message")) {
        match handle_chat_post(body, &chat_store).await {
            Ok(()) => response_bytes(
                204,
                "No Content",
                Vec::new(),
                "text/plain; charset=utf-8",
                true,
            ),
            Err(err) => {
                trace!(?err, path = %path, "chat ingest failed");
                response_text(
                    400,
                    "Bad Request",
                    "Bad Request",
                    "text/plain; charset=utf-8",
                )
            }
        }
    } else if method == "GET" && path.starts_with("/chat/poll") {
        match handle_chat_poll(path, &chat_store).await {
            Ok((body, content_type)) => response_bytes(200, "OK", body, content_type, head_only),
            Err(RouteError::BadRequest) => response_text(
                400,
                "Bad Request",
                "Bad Request",
                "text/plain; charset=utf-8",
            ),
            Err(RouteError::Io(err)) => {
                trace!(?err, path = %path, "chat poll failed");
                response_text(
                    500,
                    "Internal Server Error",
                    "Internal Server Error",
                    "text/plain; charset=utf-8",
                )
            }
            _ => response_text(
                500,
                "Internal Server Error",
                "Internal Server Error",
                "text/plain; charset=utf-8",
            ),
        }
    } else if method != "GET" && method != "HEAD" && !path.starts_with("/proxy/") {
        info!(%method, %path, "rejecting unsupported method");
        response_text(
            405,
            "Method Not Allowed",
            "Method Not Allowed",
            "text/plain; charset=utf-8",
        )
    } else if path == LOGGER_ROUTE_PREFIX || path.starts_with("/logger/") {
        match handle_logger_get(path, &logger_store) {
            Ok((body, content_type)) => response_bytes(200, "OK", body, content_type, head_only),
            Err(RouteError::BadRequest) => response_text(
                400,
                "Bad Request",
                "Bad Request",
                "text/plain; charset=utf-8",
            ),
            Err(RouteError::NotFound) => {
                response_text(404, "Not Found", "Not Found", "text/plain; charset=utf-8")
            }
            Err(RouteError::Io(err)) => {
                error!(?err, path = %path, "failed to serve logger payload");
                response_text(
                    500,
                    "Internal Server Error",
                    "Internal Server Error",
                    "text/plain; charset=utf-8",
                )
            }
        }
    } else if path == PEERS_ROUTE_PREFIX || path.starts_with("/peers/") {
        match handle_peer_get(path, &peer_store) {
            Ok((body, content_type)) => response_bytes(200, "OK", body, content_type, head_only),
            Err(RouteError::BadRequest) => response_text(
                400,
                "Bad Request",
                "Bad Request",
                "text/plain; charset=utf-8",
            ),
            Err(RouteError::NotFound) => {
                response_text(404, "Not Found", "Not Found", "text/plain; charset=utf-8")
            }
            Err(RouteError::Io(err)) => {
                error!(?err, path = %path, "failed to serve peer payload");
                response_text(
                    500,
                    "Internal Server Error",
                    "Internal Server Error",
                    "text/plain; charset=utf-8",
                )
            }
        }
    } else if method == "GET" && path == "/.well-known/nostr.json" {
        match handle_nip05_get(&peer_store) {
            Ok((body, content_type)) => response_bytes(200, "OK", body, content_type, head_only),
            Err(RouteError::BadRequest) => response_text(
                400,
                "Bad Request",
                "Bad Request",
                "text/plain; charset=utf-8",
            ),
            Err(RouteError::NotFound) => {
                response_text(404, "Not Found", "Not Found", "text/plain; charset=utf-8")
            }
            Err(RouteError::Io(err)) => {
                error!(?err, path = %path, "failed to generate nip05 payload");
                response_text(
                    500,
                    "Internal Server Error",
                    "Internal Server Error",
                    "text/plain; charset=utf-8",
                )
            }
        }
    } else if path == EVENTS_ROUTE_PREFIX || path.starts_with("/events/") {
        match handle_events_get(path, &request, &event_store).await {
            Ok((body, content_type)) => response_bytes(200, "OK", body, content_type, head_only),
            Err(RouteError::BadRequest) => response_text(
                400,
                "Bad Request",
                "Bad Request",
                "text/plain; charset=utf-8",
            ),
            Err(RouteError::NotFound) => {
                response_text(404, "Not Found", "Not Found", "text/plain; charset=utf-8")
            }
            Err(RouteError::Io(err)) => {
                error!(?err, path = %path, "failed to serve events payload");
                response_text(
                    500,
                    "Internal Server Error",
                    "Internal Server Error",
                    "text/plain; charset=utf-8",
                )
            }
        }
    } else if path.starts_with("/proxy/") {
        let proxy_headers = vec![
            header_from_request(&request_bytes, "content-type"),
            header_from_request(&request_bytes, "accept"),
            header_from_request(&request_bytes, "git-protocol"),
        ];
        tokio::select! {
            result = handle_proxy(request_target, method, &body_bytes, &http_client, head_only, proxy_headers) => result,
            _ = shutdown_rx.changed() => {
                return Err(io::Error::new(io::ErrorKind::Interrupted, "shutdown requested"));
            }
        }
    } else {
        match try_route_paths(site_dir, extra_path, extra_recursive, extra_depth, path).await {
            Ok((body, content_type)) => {
                trace!(%path, content_type, head_only, body_len = body.len(), "serving response");
                response_bytes(200, "OK", body, content_type, head_only)
            }
            Err(RouteError::NotFound) => {
                info!(%path, "request not found");
                response_text(404, "Not Found", "Not Found", "text/plain; charset=utf-8")
            }
            Err(RouteError::BadRequest) => {
                info!(%path, "bad request path");
                response_text(
                    400,
                    "Bad Request",
                    "Bad Request",
                    "text/plain; charset=utf-8",
                )
            }
            Err(RouteError::Io(err)) => {
                error!(?err, path = %path, "failed to read file");
                response_text(
                    500,
                    "Internal Server Error",
                    "Internal Server Error",
                    "text/plain; charset=utf-8",
                )
            }
        }
    };

    stream.write_all(&response).await?;
    stream.shutdown().await?;
    Ok(())
}

async fn handle_proxy(
    request_target: &str,
    method: &str,
    body: &[u8],
    http_client: &reqwest::Client,
    head_only: bool,
    proxy_headers: Vec<Option<String>>,
) -> Vec<u8> {
    if method == "OPTIONS" {
        let response = format!(
            "HTTP/1.1 204 No Content\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
             Access-Control-Allow-Headers: *\r\n\
             Access-Control-Max-Age: 86400\r\n\
             Content-Length: 0\r\n\
             X-Frame-Options: DENY\r\n\
             X-Content-Type-Options: nosniff\r\n\
             Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' blob: 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://esm.sh; worker-src 'self' blob: 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://esm.sh; style-src 'self' 'unsafe-inline'; connect-src *; img-src 'self' data: https:; font-src 'self'; frame-ancestors 'none';\r\n\
             Connection: close\r\n\r\n"
        );
        return response.into_bytes();
    }

    let target = request_target.strip_prefix("/proxy/").unwrap_or(request_target);
    let target = if target.starts_with("http://") || target.starts_with("https://") {
        target.to_string()
    } else {
        format!("https://{target}")
    };

    let mut request_builder = if method == "POST" {
        http_client.post(&target).body(body.to_vec())
    } else {
        http_client.get(&target)
    };
    if let Some(Some(ct)) = proxy_headers.get(0) {
        request_builder = request_builder.header(reqwest::header::CONTENT_TYPE, ct);
    }
    if let Some(Some(acc)) = proxy_headers.get(1) {
        request_builder = request_builder.header(reqwest::header::ACCEPT, acc);
    }
    if let Some(Some(gp)) = proxy_headers.get(2) {
        request_builder = request_builder.header("Git-Protocol", gp);
    }

    match request_builder.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let reason = resp.status().canonical_reason().unwrap_or("OK");
            let content_type = resp
                .headers()
                .get("content-type")
                .and_then(|ct| ct.to_str().ok())
                .map(|s| s.to_string());
            let resp_bytes = resp.bytes().await.unwrap_or_default().to_vec();

            let mut headers = format!(
                "HTTP/1.1 {status} {reason}\r\n\
                 Access-Control-Allow-Origin: *\r\n\
                 Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
                 Access-Control-Allow-Headers: *\r\n\
                 Content-Length: {}\r\n\
                 X-Frame-Options: DENY\r\n\
                 X-Content-Type-Options: nosniff\r\n\
                 Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' blob: 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://esm.sh; worker-src 'self' blob: 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://esm.sh; style-src 'self' 'unsafe-inline'; connect-src *; img-src 'self' data: https:; font-src 'self'; frame-ancestors 'none';\r\n\
                 Connection: close\r\n",
                if head_only { 0 } else { resp_bytes.len() }
            );

            if let Some(ct) = content_type {
                headers.push_str(&format!("Content-Type: {ct}\r\n"));
            }

            headers.push_str("\r\n");
            let mut response = headers.into_bytes();
            if !head_only {
                response.extend_from_slice(&resp_bytes);
            }
            response
        }
        Err(err) => {
            trace!(?err, target, "proxy request failed");
            let body_text = format!("Proxy error: {err}");
            let response = format!(
                "HTTP/1.1 502 Bad Gateway\r\n\
                 Access-Control-Allow-Origin: *\r\n\
                 Content-Type: text/plain; charset=utf-8\r\n\
                 Content-Length: {}\r\n\
                 X-Frame-Options: DENY\r\n\
                 X-Content-Type-Options: nosniff\r\n\
                 Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' blob: 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://esm.sh; worker-src 'self' blob: 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://esm.sh; style-src 'self' 'unsafe-inline'; connect-src *; img-src 'self' data: https:; font-src 'self'; frame-ancestors 'none';\r\n\
                 Connection: close\r\n\r\n\
                 {body_text}",
                body_text.len()
            );
            response.into_bytes()
        }
    }
}

async fn read_http_request(
    stream: &mut TcpStream,
    shutdown_rx: &mut watch::Receiver<()>,
) -> io::Result<Vec<u8>> {
    let mut buffer = Vec::with_capacity(8192);
    let mut chunk = [0u8; 4096];

    loop {
        let bytes_read = tokio::select! {
            bytes_read = stream.read(&mut chunk) => bytes_read?,
            _ = shutdown_rx.changed() => {
                return Err(io::Error::new(io::ErrorKind::Interrupted, "shutdown requested"));
            }
        };
        if bytes_read == 0 {
            break;
        }

        buffer.extend_from_slice(&chunk[..bytes_read]);

        if let Some((header_end, content_length)) = request_lengths(&buffer) {
            let body_len = buffer.len().saturating_sub(header_end);
            if body_len >= content_length {
                break;
            }
        }
    }

    Ok(buffer)
}

fn request_lengths(buffer: &[u8]) -> Option<(usize, usize)> {
    let header_end = buffer.windows(4).position(|window| window == b"\r\n\r\n")? + 4;
    let headers = std::str::from_utf8(&buffer[..header_end]).ok()?;
    let content_length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    Some((header_end, content_length))
}

fn request_body(request: &str) -> &str {
    request
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap_or("")
}

fn request_body_bytes(request: &[u8]) -> &[u8] {
    request
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|pos| &request[pos + 4..])
        .unwrap_or(&[])
}

fn header_from_request(request_bytes: &[u8], name: &str) -> Option<String> {
    let header_end = request_bytes.windows(4).position(|w| w == b"\r\n\r\n")? + 4;
    let headers = std::str::from_utf8(&request_bytes[..header_end]).ok()?;
    let name_lower = name.to_lowercase();
    for line in headers.lines() {
        if line.is_empty() {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            if key.trim().eq_ignore_ascii_case(&name_lower) {
                return Some(value.trim().to_string());
            }
        }
    }
    None
}

fn handle_logger_post(body: &str, logger_store: &Arc<LoggerStore>) -> Result<(), RouteError> {
    let entry: LoggerEntry = serde_json::from_str(body).map_err(|_| RouteError::BadRequest)?;
    logger_store.push(entry);
    Ok(())
}

fn handle_peer_post(body: &str, peer_store: &Arc<PeerStore>) -> Result<(), RouteError> {
    let mut entry: PeerEntry = serde_json::from_str(body).map_err(|_| RouteError::BadRequest)?;
    if entry.peer_id.trim().is_empty() {
        return Err(RouteError::BadRequest);
    }
    if entry.kind.trim().is_empty() {
        entry.kind = "started".to_string();
    }
    if entry.path.trim().is_empty() {
        entry.path = "/".to_string();
    }
    if entry.updated_at == 0 {
        entry.updated_at = now_ms();
    }
    peer_store.upsert(entry);
    Ok(())
}

fn handle_logger_get(
    path: &str,
    logger_store: &Arc<LoggerStore>,
) -> Result<(Vec<u8>, &'static str), RouteError> {
    let level = path.trim_start_matches("/logger/").trim();
    let payload = if level.is_empty() || level == "all" {
        logger_store.all()
    } else {
        logger_store.filter_level(level)
    };
    serde_json::to_vec(&payload)
        .map(|body| (body, "application/json; charset=utf-8"))
        .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))
}

fn handle_peer_get(
    path: &str,
    peer_store: &Arc<PeerStore>,
) -> Result<(Vec<u8>, &'static str), RouteError> {
    let suffix = path.trim_start_matches("/peers").trim_start_matches('/');
    let peers = peer_store.all();
    let payload = if suffix.is_empty() || suffix == "all" {
        peers
    } else {
        peers
            .into_iter()
            .filter(|entry| entry.peer_id == suffix || entry.path == suffix)
            .collect()
    };

    serde_json::to_vec(&payload)
        .map(|body| (body, "application/json; charset=utf-8"))
        .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))
}

async fn handle_chat_post(body: &str, chat_store: &Arc<ChatStore>) -> Result<(), RouteError> {
    let msg: ChatMessage = serde_json::from_str(body).map_err(|_| RouteError::BadRequest)?;
    if msg.from.is_empty() || msg.text.is_empty() {
        return Err(RouteError::BadRequest);
    }
    chat_store.push(msg);
    Ok(())
}

async fn handle_chat_poll(
    path: &str,
    chat_store: &Arc<ChatStore>,
) -> Result<(Vec<u8>, &'static str), RouteError> {
    let since = path
        .trim_start_matches("/chat/poll")
        .trim_start_matches('/')
        .parse::<u64>()
        .unwrap_or(0);
    let messages = chat_store.since(since);
    let body = serde_json::to_vec(&messages)
        .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))?;
    Ok((body, "application/json; charset=utf-8"))
}

/// Generate a dynamic NIP-05 `.well-known/nostr.json` response from the
/// peer store.  The deterministic native pubkey is always included as the
/// canonical identity, and any discovered peers that expose a `nostr_pubkey`
/// in their detail field are added as additional names.
fn handle_nip05_get(
    peer_store: &Arc<PeerStore>,
) -> Result<(Vec<u8>, &'static str), RouteError> {
    const BASE_PUBKEY: &str = "2d724a13a80b6002607737ad1a99f3c0b148843707d59ac3bff08c7fce72ecce";

    let peers = peer_store.all();
    let mut names = serde_json::Map::new();
    let mut relays = serde_json::Map::new();

    // Always include the base / canonical identity.
    names.insert("_".to_string(), serde_json::Value::String(BASE_PUBKEY.to_string()));
    names.insert("nostr-dag".to_string(), serde_json::Value::String(BASE_PUBKEY.to_string()));
    relays.insert(
        BASE_PUBKEY.to_string(),
        serde_json::Value::Array(vec![
            serde_json::Value::String("wss://nos.lol".to_string()),
            serde_json::Value::String("wss://relay.nostr.com".to_string()),
            serde_json::Value::String("wss://relay.nostr.band".to_string()),
            serde_json::Value::String("wss://relay.primal.net".to_string()),
            serde_json::Value::String("wss://nostr.wine".to_string()),
            serde_json::Value::String("wss://top.testrelay.top".to_string()),
            serde_json::Value::String("wss://relay.pocketnostr.com".to_string()),
            serde_json::Value::String("wss://basspistol.org".to_string()),
            serde_json::Value::String("wss://relay.ngit.dev".to_string()),
        ]),
    );

    // Scrape nostr_pubkey from peer detail lines.
    for peer in peers {
        if let Some(ref detail) = peer.detail {
            if let Some(pk) = extract_nostr_pubkey(detail) {
                if pk != BASE_PUBKEY && !names.values().any(|v| v.as_str() == Some(&pk)) {
                    let safe_name = peer.peer_id.replace(" ", "_").replace("/", "_");
                    if !safe_name.is_empty() && !names.contains_key(&safe_name) {
                        names.insert(safe_name, serde_json::Value::String(pk.clone()));
                    }
                }
            }
        }
    }

    let payload = serde_json::json!({
        "names": names,
        "relays": relays,
    });

    serde_json::to_vec(&payload)
        .map(|body| (body, "application/json; charset=utf-8"))
        .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))
}

/// Scan a p2p-node stdout line for `nostr_pubkey=<hex>`.
fn extract_nostr_pubkey(text: &str) -> Option<String> {
    let prefix = "nostr_pubkey=";
    let start = text.find(prefix)? + prefix.len();
    let rest = &text[start..];
    let end = rest.find(|c: char| c.is_whitespace() || c == ',' || c == '"' || c == '}')
        .unwrap_or(rest.len());
    let value = &rest[..end];
    if value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(value.to_string())
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Event store handlers
// ---------------------------------------------------------------------------

/// POST /events — ingest a raw Nostr event JSON object.
///
/// The body must be a JSON object with at minimum `id`, `pubkey`, `kind`,
/// `created_at`, `content`, `sig`, and `tags`.  An optional
/// `source_relay` top-level string field may be included by the client.
async fn handle_events_post(body: &str, state: &Arc<EventStoreState>) -> Result<(), RouteError> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|_| RouteError::BadRequest)?;

    let id = v["id"].as_str().ok_or(RouteError::BadRequest)?.to_string();
    let pubkey = v["pubkey"]
        .as_str()
        .ok_or(RouteError::BadRequest)?
        .to_string();
    let kind = v["kind"].as_i64().ok_or(RouteError::BadRequest)?;
    let created = v["created_at"].as_i64().ok_or(RouteError::BadRequest)?;
    let content = v["content"].as_str().unwrap_or("").to_string();
    let sig = v["sig"].as_str().unwrap_or("").to_string();
    let source = v["source_relay"].as_str().map(str::to_string);

    // Normalise the tags array into Vec<Vec<String>>.
    let tags: Vec<Vec<String>> = v["tags"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(|tag| {
            tag.as_array()
                .unwrap_or(&vec![])
                .iter()
                .map(|f| f.as_str().unwrap_or("").to_string())
                .collect()
        })
        .collect();

    let now = now_ms() as i64;
    let raw = body.to_string();
    let state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        let store = state.inner.lock().expect("event store poisoned");
        store
            .upsert_event(
                &id,
                &pubkey,
                kind,
                created,
                &content,
                &sig,
                &raw,
                &tags,
                source.as_deref(),
                now,
            )
            .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))
    })
    .await
    .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))?
}

/// GET /events                  — stats (counts)
/// GET /events/kind/{n}         — latest events of kind n (up to 100)
/// GET /events/pubkey/{hex}     — latest events from pubkey (up to 100)
/// GET /events/relay/{url}      — latest events seen on relay (up to 100)
/// GET /events/id/{hex}         — raw JSON for a single event id
async fn handle_events_get(
    path: &str,
    request: &str,
    state: &Arc<EventStoreState>,
) -> Result<(Vec<u8>, &'static str), RouteError> {
    let suffix = path
        .trim_start_matches("/events")
        .trim_start_matches('/')
        .to_string();
    let limit = query_param(request, "limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(100)
        .min(1000);
    let state = Arc::clone(state);

    let body = tokio::task::spawn_blocking(move || {
        let store = state.inner.lock().expect("event store poisoned");
        if suffix.is_empty() || suffix == "stats" {
            // Return summary counts.
            let counts = serde_json::json!({
                "events": store.event_count().unwrap_or(0),
                "relays": store.relay_count().unwrap_or(0),
                "users":  store.user_count().unwrap_or(0),
            });
            serde_json::to_vec(&counts)
                .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))
        } else if let Some(rest) = suffix.strip_prefix("kind/") {
            let kind: i64 = rest.parse().map_err(|_| RouteError::BadRequest)?;
            let events = store
                .events_by_kind(kind, limit)
                .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))?;
            let parsed: Vec<serde_json::Value> = events
                .iter()
                .filter_map(|s| serde_json::from_str(s).ok())
                .collect();
            serde_json::to_vec(&parsed)
                .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))
        } else if let Some(rest) = suffix.strip_prefix("pubkey/") {
            let events = store
                .events_by_pubkey(rest, limit)
                .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))?;
            let parsed: Vec<serde_json::Value> = events
                .iter()
                .filter_map(|s| serde_json::from_str(s).ok())
                .collect();
            serde_json::to_vec(&parsed)
                .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))
        } else if let Some(rest) = suffix.strip_prefix("relay/") {
            let relay_url = urlencoding::decode(rest).map_err(|_| RouteError::BadRequest)?;
            let events = store
                .events_for_relay(&relay_url, limit)
                .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))?;
            let parsed: Vec<serde_json::Value> = events
                .iter()
                .filter_map(|s| serde_json::from_str(s).ok())
                .collect();
            serde_json::to_vec(&parsed)
                .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))
        } else if let Some(rest) = suffix.strip_prefix("id/") {
            match store
                .get_event_json(rest)
                .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))?
            {
                Some(json) => Ok(json.into_bytes()),
                None => Err(RouteError::NotFound),
            }
        } else {
            Err(RouteError::NotFound)
        }
    })
    .await
    .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))??;

    Ok((body, "application/json; charset=utf-8"))
}

async fn handle_nip11_get(
    request: &str,
    http_client: &Arc<reqwest::Client>,
) -> Result<(Vec<u8>, &'static str), RouteError> {
    let _permit = nip11_semaphore()
        .acquire()
        .await
        .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))?;
    let relay = query_param(request, "relay").ok_or(RouteError::BadRequest)?;
    let relay = urlencoding::decode(&relay)
        .map_err(|_| RouteError::BadRequest)?
        .into_owned();
    let relay = normalize_nip11_url(&relay).ok_or(RouteError::BadRequest)?;

    let response = http_client
        .get(&relay)
        .header(reqwest::header::ACCEPT, "application/nostr+json")
        .send()
        .await
        .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))?;

    if !response.status().is_success() {
        return Err(RouteError::NotFound);
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/nostr+json; charset=utf-8")
        .to_string();
    let body = response
        .bytes()
        .await
        .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))?
        .to_vec();
    Ok((body, Box::leak(content_type.into_boxed_str())))
}

fn query_param(request: &str, name: &str) -> Option<String> {
    let query = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|path| path.split_once('?').map(|(_, query)| query))?;

    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        if key == name {
            Some(value.to_string())
        } else {
            None
        }
    })
}

fn normalize_nip11_url(url: &str) -> Option<String> {
    let mut parsed = reqwest::Url::parse(url).ok()?;
    match parsed.scheme() {
        "ws" => {
            let _ = parsed.set_scheme("http");
        }
        "wss" => {
            let _ = parsed.set_scheme("https");
        }
        "http" | "https" => {}
        _ => return None,
    }
    Some(parsed.to_string().trim_end_matches('/').to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn is_disconnect_error(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset | io::ErrorKind::UnexpectedEof
    )
}

async fn route_path(site_dir: &str, path: &str) -> Result<(Vec<u8>, &'static str), RouteError> {
    let path = strip_query(path);
    if path == "/favicon.ico" {
        trace!(%path, "serving embedded favicon");
        return Ok((FAVICON_ICO.to_vec(), "image/x-icon"));
    }
    let normalized = normalize_path(path)?;
    let file_path = if normalized.as_os_str().is_empty() {
        trace!(%path, site_dir = %site_dir, "routing to index.html");
        PathBuf::from(site_dir).join("index.html")
    } else {
        let candidate = PathBuf::from(site_dir).join(&normalized);
        if fs::metadata(&candidate)
            .await
            .map(|meta| meta.is_dir())
            .unwrap_or(false)
        {
            trace!(%path, file = %candidate.display(), "routing directory to index.html");
            candidate.join("index.html")
        } else {
            trace!(%path, file = %candidate.display(), "routing to file");
            candidate
        }
    };

    let (body, content_type) = match fs::read(&file_path).await {
        Ok(data) => (data, content_type_for_path(&file_path)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            // Try `.html` fallback so `/chat` resolves to `chat.html`.
            let html_fallback = file_path.with_extension("html");
            if html_fallback != file_path {
                let data = fs::read(&html_fallback).await.map_err(|err| {
                    if err.kind() == io::ErrorKind::NotFound {
                        RouteError::NotFound
                    } else {
                        RouteError::Io(err)
                    }
                })?;
                (data, content_type_for_path(&html_fallback))
            } else {
                return Err(RouteError::NotFound);
            }
        }
        Err(err) => return Err(RouteError::Io(err)),
    };

    Ok((body, content_type))
}

async fn try_route_paths(
    site_dir: &str,
    extra_path: Option<&str>,
    extra_recursive: bool,
    extra_depth: usize,
    path: &str,
) -> Result<(Vec<u8>, &'static str), RouteError> {
    match route_path(site_dir, path).await {
        Ok(result) => return Ok(result),
        Err(RouteError::NotFound) => {}
        Err(e) => return Err(e),
    }
    if let Some(extra) = extra_path {
        let normalized = normalize_path(path)?;
        let depth = normalized.components().count();
        if depth <= extra_depth || (extra_recursive && depth > 0) {
            return route_path(extra, path).await;
        }
    }
    Err(RouteError::NotFound)
}

async fn canonical_directory_redirect(
    site_dir: &str,
    extra_path: Option<&str>,
    path: &str,
    request_target: &str,
) -> Option<String> {
    let normalized = normalize_path(path).ok()?;
    if normalized.as_os_str().is_empty() {
        return None;
    }
    let candidate = PathBuf::from(site_dir).join(&normalized);
    let is_dir = fs::metadata(&candidate)
        .await
        .map(|meta| meta.is_dir())
        .unwrap_or(false);
    if is_dir {
        let suffix = query_suffix(request_target);
        return Some(format!("{path}/{suffix}"));
    }
    if let Some(extra) = extra_path {
        let candidate = PathBuf::from(extra).join(normalized);
        let is_dir = fs::metadata(&candidate)
            .await
            .map(|meta| meta.is_dir())
            .unwrap_or(false);
        if is_dir {
            let suffix = query_suffix(request_target);
            return Some(format!("{path}/{suffix}"));
        }
    }
    None
}

fn normalize_path(path: &str) -> Result<PathBuf, RouteError> {
    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() {
        return Ok(PathBuf::new());
    }

    let mut out = PathBuf::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return Err(RouteError::BadRequest),
        }
    }
    Ok(out)
}

fn strip_query(path: &str) -> &str {
    path.split_once(['?', '#'])
        .map(|(head, _)| head)
        .unwrap_or(path)
}

fn query_suffix(path: &str) -> &str {
    match path.find(['?', '#']) {
        Some(index) => &path[index..],
        None => "",
    }
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
    {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        // Shared browser modules use `.mjs` so local preview and Pages serve them as JavaScript.
        "mjs" => "text/javascript; charset=utf-8",
        "wasm" => "application/wasm",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn response_text(status: u16, reason: &str, body: &str, content_type: &'static str) -> Vec<u8> {
    response_bytes(
        status,
        reason,
        body.as_bytes().to_vec(),
        content_type,
        false,
    )
}

fn response_redirect(location: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 302 Found\r\n\
         Location: {location}\r\n\
         Content-Length: 0\r\n\
         X-Frame-Options: DENY\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' blob: 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://esm.sh; worker-src 'self' blob: 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://esm.sh; style-src 'self' 'unsafe-inline'; connect-src *; img-src 'self' data: https:; font-src 'self'; frame-ancestors 'none';\r\n\
         Connection: close\r\n\r\n"
    )
    .into_bytes()
}

fn response_bytes(
    status: u16,
    reason: &str,
    body: Vec<u8>,
    content_type: &'static str,
    head_only: bool,
) -> Vec<u8> {
    let body_len = if head_only { 0 } else { body.len() };
    let body = if head_only { Vec::new() } else { body };
    let mut response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {body_len}\r\n\
         X-Frame-Options: DENY\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' blob: 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://esm.sh; worker-src 'self' blob: 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://esm.sh; style-src 'self' 'unsafe-inline'; connect-src *; img-src 'self' data: https:; font-src 'self'; frame-ancestors 'none';\r\n\
         Connection: close\r\n\r\n"
    )
    .into_bytes();
    response.extend_from_slice(&body);
    response
}

#[derive(Debug)]
enum RouteError {
    NotFound,
    BadRequest,
    Io(io::Error),
}

#[cfg(test)]
mod tests {
    use super::{canonical_directory_redirect, content_type_for_path, query_suffix};
    use std::fs;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn serves_mjs_as_javascript() {
        assert_eq!(
            content_type_for_path(Path::new("site/shared/git-progress.mjs")),
            "text/javascript; charset=utf-8"
        );
    }

    #[test]
    fn query_suffix_extracts_query_and_fragment() {
        assert_eq!(query_suffix("/git?repo=nostr-dag"), "?repo=nostr-dag");
        assert_eq!(query_suffix("/git#hash"), "#hash");
    }

    #[test]
    fn query_suffix_is_empty_when_absent() {
        assert_eq!(query_suffix("/git/"), "");
    }

    #[tokio::test]
    async fn canonical_directory_redirect_redirects_directories() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let site_dir = std::env::temp_dir().join(format!("nostr-dag-server-test-{unique}"));
        let git_dir = site_dir.join("git");
        fs::create_dir_all(&git_dir).expect("create git dir");

        let redirect = canonical_directory_redirect(
            site_dir.to_str().expect("temp dir utf-8"),
            None,
            "/git",
            "/git?repo=nostr-dag",
        )
        .await;
        assert_eq!(redirect, Some("/git/?repo=nostr-dag".to_string()));

        fs::remove_dir_all(&site_dir).expect("cleanup temp dir");
    }
}
