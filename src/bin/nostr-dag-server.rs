//! Serve the built demo site locally from `site/`.
//!
//! This is a small static file server for local preview. It expects `site/`
//! to contain the WASM build output and `index.html`, and it prints
//! `SERVER_URL=...` on startup.

use std::env;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, watch};
use tokio::task::JoinSet;
use tracing::{debug, error, info, trace};

use nostr_dag::FAVICON_ICO;
use nostr_dag::store::EventStore;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 3000;
const DEFAULT_SITE_DIR: &str = "site";
const LOGGER_ROUTE_PREFIX: &str = "/logger";
const LOGGER_MAX_ENTRIES: usize = 10_000;
const PEERS_ROUTE_PREFIX: &str = "/peers";
const NIP11_ROUTE_PREFIX: &str = "/nip11";
const NIP11_MAX_CONCURRENT: usize = 8;
/// Route prefix for the event store REST API.
const EVENTS_ROUTE_PREFIX: &str = "/events";
/// Default SQLite database file placed next to the server working directory.
const DEFAULT_DB_PATH: &str = "nostr-dag.db";

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
        Ok(Self { inner: Mutex::new(store) })
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
        self.entries
            .lock()
            .expect("logger store poisoned")
            .clone()
    }
}

impl PeerStore {
    fn upsert(&self, entry: PeerEntry) {
        let mut entries = self.entries.lock().expect("peer store poisoned");
        entries.insert(format!("{}:{}", entry.path, entry.peer_id), entry);
    }

    fn all(&self) -> Vec<PeerEntry> {
        self.entries
            .lock()
            .expect("peer store poisoned")
            .values()
            .cloned()
            .collect()
    }
}

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
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let site_dir = env::var("SITE_DIR").unwrap_or_else(|_| DEFAULT_SITE_DIR.to_string());
    let db_path = env::var("DB_PATH").unwrap_or_else(|_| DEFAULT_DB_PATH.to_string());
    let logger_store = Arc::new(LoggerStore::default());
    let peer_store = Arc::new(PeerStore::default());
    let event_store = Arc::new(
        EventStoreState::new(&db_path).unwrap_or_else(|err| {
            error!(?err, %db_path, "failed to open event store, using in-memory fallback");
            EventStoreState::new(":memory:").expect("in-memory event store")
        }),
    );
    let http_client = Arc::new(reqwest::Client::builder().user_agent("nostr-dag/0.9.1").build()?);
    let (shutdown_tx, shutdown_rx) = watch::channel(());

    let addr = format!("{host}:{port}");
    let listener = TcpListener::bind(&addr).await?;
    let mut connections = JoinSet::new();

    info!(%addr, site_dir = %site_dir, %db_path, "nostr-dag server listening");
    println!("SERVER_URL=http://{addr}");

    loop {
        tokio::select! {
            result = listener.accept() => {
                let (stream, peer) = result?;
                let site_dir = site_dir.clone();
                let logger_store = Arc::clone(&logger_store);
                let peer_store = Arc::clone(&peer_store);
                let event_store = Arc::clone(&event_store);
                let http_client = Arc::clone(&http_client);
                let connection_shutdown = shutdown_rx.clone();
                connections.spawn(async move {
                    if let Err(err) = handle_connection(stream, &site_dir, logger_store, peer_store, event_store, http_client, connection_shutdown).await {
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
    info!("shutdown complete");

    Ok(())
}

async fn handle_connection(
    mut stream: TcpStream,
    site_dir: &str,
    logger_store: Arc<LoggerStore>,
    peer_store: Arc<PeerStore>,
    event_store: Arc<EventStoreState>,
    http_client: Arc<reqwest::Client>,
    mut shutdown_rx: watch::Receiver<()>,
) -> io::Result<()> {
    let request = read_http_request(&mut stream, &mut shutdown_rx).await?;
    if request.is_empty() {
        return Ok(());
    }

    let request = String::from_utf8_lossy(&request);
    let mut lines = request.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let path = strip_query(parts.next().unwrap_or("/"));
    debug!(%method, %path, "request received");
    let body = request_body(&request);

    let head_only = method == "HEAD";
    let response = if method == "POST" && (path == LOGGER_ROUTE_PREFIX || path.starts_with("/logger/")) {
        match handle_logger_post(body, &logger_store) {
            Ok(()) => response_bytes(204, "No Content", Vec::new(), "text/plain; charset=utf-8", true),
            Err(err) => {
                error!(?err, "logger ingest failed");
                response_text(400, "Bad Request", "Bad Request", "text/plain; charset=utf-8")
            }
        }
    } else if method == "POST" && (path == PEERS_ROUTE_PREFIX || path.starts_with("/peers/")) {
        match handle_peer_post(body, &peer_store) {
            Ok(()) => response_bytes(204, "No Content", Vec::new(), "text/plain; charset=utf-8", true),
            Err(err) => {
                error!(?err, "peer ingest failed");
                response_text(400, "Bad Request", "Bad Request", "text/plain; charset=utf-8")
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
        match handle_events_post(body, &event_store) {
            Ok(()) => response_bytes(204, "No Content", Vec::new(), "text/plain; charset=utf-8", true),
            Err(err) => {
                error!(?err, "event ingest failed");
                response_text(400, "Bad Request", "Bad Request", "text/plain; charset=utf-8")
            }
        }
    } else if method != "GET" && method != "HEAD" {
        info!(%method, %path, "rejecting unsupported method");
        response_text(405, "Method Not Allowed", "Method Not Allowed", "text/plain; charset=utf-8")
    } else if path == LOGGER_ROUTE_PREFIX || path.starts_with("/logger/") {
        match handle_logger_get(path, &logger_store) {
            Ok((body, content_type)) => response_bytes(200, "OK", body, content_type, head_only),
            Err(RouteError::BadRequest) => {
                response_text(400, "Bad Request", "Bad Request", "text/plain; charset=utf-8")
            }
            Err(RouteError::NotFound) => {
                response_text(404, "Not Found", "Not Found", "text/plain; charset=utf-8")
            }
            Err(RouteError::Io(err)) => {
                error!(?err, path = %path, "failed to serve logger payload");
                response_text(500, "Internal Server Error", "Internal Server Error", "text/plain; charset=utf-8")
            }
        }
    } else if path == PEERS_ROUTE_PREFIX || path.starts_with("/peers/") {
        match handle_peer_get(path, &peer_store) {
            Ok((body, content_type)) => response_bytes(200, "OK", body, content_type, head_only),
            Err(RouteError::BadRequest) => {
                response_text(400, "Bad Request", "Bad Request", "text/plain; charset=utf-8")
            }
            Err(RouteError::NotFound) => {
                response_text(404, "Not Found", "Not Found", "text/plain; charset=utf-8")
            }
            Err(RouteError::Io(err)) => {
                error!(?err, path = %path, "failed to serve peer payload");
                response_text(500, "Internal Server Error", "Internal Server Error", "text/plain; charset=utf-8")
            }
        }
    } else if path == EVENTS_ROUTE_PREFIX || path.starts_with("/events/") {
        match handle_events_get(path, &request, &event_store) {
            Ok((body, content_type)) => response_bytes(200, "OK", body, content_type, head_only),
            Err(RouteError::BadRequest) => {
                response_text(400, "Bad Request", "Bad Request", "text/plain; charset=utf-8")
            }
            Err(RouteError::NotFound) => {
                response_text(404, "Not Found", "Not Found", "text/plain; charset=utf-8")
            }
            Err(RouteError::Io(err)) => {
                error!(?err, path = %path, "failed to serve events payload");
                response_text(500, "Internal Server Error", "Internal Server Error", "text/plain; charset=utf-8")
            }
        }
    } else {
        match route_path(site_dir, path).await {
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
                response_text(400, "Bad Request", "Bad Request", "text/plain; charset=utf-8")
            }
            Err(RouteError::Io(err)) => {
                error!(?err, path = %path, "failed to read file");
                response_text(500, "Internal Server Error", "Internal Server Error", "text/plain; charset=utf-8")
            }
        }
    };

    stream.write_all(&response).await?;
    stream.shutdown().await?;
    Ok(())
}

async fn read_http_request(stream: &mut TcpStream, shutdown_rx: &mut watch::Receiver<()>) -> io::Result<Vec<u8>> {
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
    request.split_once("\r\n\r\n").map(|(_, body)| body).unwrap_or("")
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

fn handle_logger_get(path: &str, logger_store: &Arc<LoggerStore>) -> Result<(Vec<u8>, &'static str), RouteError> {
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

fn handle_peer_get(path: &str, peer_store: &Arc<PeerStore>) -> Result<(Vec<u8>, &'static str), RouteError> {
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

// ---------------------------------------------------------------------------
// Event store handlers
// ---------------------------------------------------------------------------

/// POST /events — ingest a raw Nostr event JSON object.
///
/// The body must be a JSON object with at minimum `id`, `pubkey`, `kind`,
/// `created_at`, `content`, `sig`, and `tags`.  An optional
/// `source_relay` top-level string field may be included by the client.
fn handle_events_post(body: &str, state: &Arc<EventStoreState>) -> Result<(), RouteError> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|_| RouteError::BadRequest)?;

    let id       = v["id"].as_str().ok_or(RouteError::BadRequest)?;
    let pubkey   = v["pubkey"].as_str().ok_or(RouteError::BadRequest)?;
    let kind     = v["kind"].as_i64().ok_or(RouteError::BadRequest)?;
    let created  = v["created_at"].as_i64().ok_or(RouteError::BadRequest)?;
    let content  = v["content"].as_str().unwrap_or("");
    let sig      = v["sig"].as_str().unwrap_or("");
    let source   = v["source_relay"].as_str();

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
    let store = state.inner.lock().expect("event store poisoned");
    store
        .upsert_event(id, pubkey, kind, created, content, sig, body, &tags, source, now)
        .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))
}

/// GET /events                  — stats (counts)
/// GET /events/kind/{n}         — latest events of kind n (up to 100)
/// GET /events/pubkey/{hex}     — latest events from pubkey (up to 100)
/// GET /events/relay/{url}      — latest events seen on relay (up to 100)
/// GET /events/id/{hex}         — raw JSON for a single event id
fn handle_events_get(
    path: &str,
    request: &str,
    state: &Arc<EventStoreState>,
) -> Result<(Vec<u8>, &'static str), RouteError> {
    let suffix = path.trim_start_matches("/events").trim_start_matches('/');
    let limit = query_param(request, "limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(100)
        .min(1000);

    let store = state.inner.lock().expect("event store poisoned");

    let body: Vec<u8> = if suffix.is_empty() || suffix == "stats" {
        // Return summary counts.
        let counts = serde_json::json!({
            "events": store.event_count().unwrap_or(0),
            "relays": store.relay_count().unwrap_or(0),
            "users":  store.user_count().unwrap_or(0),
        });
        serde_json::to_vec(&counts)
            .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))?
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
            .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))?
    } else if let Some(rest) = suffix.strip_prefix("pubkey/") {
        let events = store
            .events_by_pubkey(rest, limit)
            .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))?;
        let parsed: Vec<serde_json::Value> = events
            .iter()
            .filter_map(|s| serde_json::from_str(s).ok())
            .collect();
        serde_json::to_vec(&parsed)
            .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))?
    } else if let Some(rest) = suffix.strip_prefix("relay/") {
        let relay_url = urlencoding::decode(rest)
            .map_err(|_| RouteError::BadRequest)?;
        let events = store
            .events_for_relay(&relay_url, limit)
            .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))?;
        let parsed: Vec<serde_json::Value> = events
            .iter()
            .filter_map(|s| serde_json::from_str(s).ok())
            .collect();
        serde_json::to_vec(&parsed)
            .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))?
    } else if let Some(rest) = suffix.strip_prefix("id/") {
        match store
            .get_event_json(rest)
            .map_err(|err| RouteError::Io(io::Error::new(io::ErrorKind::Other, err)))?
        {
            Some(json) => json.into_bytes(),
            None => return Err(RouteError::NotFound),
        }
    } else {
        return Err(RouteError::NotFound);
    };

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

    let content_type = content_type_for_path(&file_path);
    let body = fs::read(&file_path).await.map_err(|err| {
        if err.kind() == io::ErrorKind::NotFound {
            RouteError::NotFound
        } else {
            RouteError::Io(err)
        }
    })?;

    Ok((body, content_type))
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
    path.split_once(['?', '#']).map(|(head, _)| head).unwrap_or(path)
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or_default() {
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
    response_bytes(status, reason, body.as_bytes().to_vec(), content_type, false)
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
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {body_len}\r\nConnection: close\r\n\r\n"
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
    use super::content_type_for_path;
    use std::path::Path;

    #[test]
    fn serves_mjs_as_javascript() {
        assert_eq!(
            content_type_for_path(Path::new("site/shared/git-progress.mjs")),
            "text/javascript; charset=utf-8"
        );
    }
}
