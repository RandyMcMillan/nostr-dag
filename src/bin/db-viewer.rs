//! nostr-dag DB viewer — a local TUI for browsing the SQLite event store
//! and syncing events from remote nostr-dag-server peers.
//!
//! Run:
//!     cargo run --bin db-viewer --features db-viewer
//!
//! Environment:
//!     DB_PATH     — SQLite file (default: nostr-dag.db)
//!     PEER_URL    — Optional default peer to sync from

use std::{
    io::{self, stdout},
    time::{Duration, Instant},
};

use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyModifiers},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::{Backend, CrosstermBackend},
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    symbols,
    text::Line,
    widgets::{
        Block, Borders, Cell, Gauge, Paragraph, Row, Table, TableState, Tabs, Wrap,
    },
    Frame, Terminal,
};

const DB_PATH_DEFAULT: &str = "nostr-dag.db";
const TICK_MS: u64 = 250;

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
enum Tab {
    Dashboard,
    Events,
    Relays,
    Users,
    Sync,
}

impl Tab {
    fn title(self) -> &'static str {
        match self {
            Tab::Dashboard => "Dashboard",
            Tab::Events => "Events",
            Tab::Relays => "Relays",
            Tab::Users => "Users",
            Tab::Sync => "Sync",
        }
    }

    fn all() -> &'static [Tab] {
        &[Tab::Dashboard, Tab::Events, Tab::Relays, Tab::Users, Tab::Sync]
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum SyncFocus {
    UrlDropdown,
    PeerSidebar,
    PeerDetail,
    StatusProgress,
    Log,
}

impl SyncFocus {
    fn all() -> &'static [SyncFocus] {
        &[
            SyncFocus::UrlDropdown,
            SyncFocus::PeerSidebar,
            SyncFocus::PeerDetail,
            SyncFocus::StatusProgress,
            SyncFocus::Log,
        ]
    }
}

struct PeerInfo {
    id: String,
    pubkey: String,
    addrs: Vec<String>,
    last_seen: i64,
}

/// JSON shape returned by the nostr-dag-server `/peers` endpoint.
#[derive(Clone, Debug, serde::Deserialize)]
struct ServerPeerEntry {
    peer_id: String,
    #[allow(dead_code)]
    kind: String,
    path: String,
    detail: Option<String>,
    source: Option<String>,
    updated_at: u64,
}

/// Blocking fetch of the peer list from the configured server.
fn fetch_peers_blocking(url: &str) -> Result<Vec<ServerPeerEntry>, Box<dyn std::error::Error + Send + Sync>> {
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async {
        let resp = reqwest::get(format!("{}/peers", url)).await?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()).into());
        }
        let entries: Vec<ServerPeerEntry> = resp.json().await?;
        Ok(entries)
    })
}

struct App {
    tab: Tab,
    db_path: String,
    store: nostr_dag::store::EventStore,

    // Dashboard
    event_count: i64,
    relay_count: i64,
    user_count: i64,
    last_refresh: Option<Instant>,

    // Events tab
    events: Vec<(String, i64, String, i64, Option<String>)>,
    events_state: TableState,

    // Relays tab
    relays: Vec<(String, i64, i64, Option<String>)>,
    relays_state: TableState,

    // Users tab
    users: Vec<(String, i64, i64)>,
    users_state: TableState,

    // Sync tab
    sync_urls: Vec<String>,
    sync_url_index: usize,
    sync_dropdown_open: bool,
    sync_focus: SyncFocus,
    sync_status: String,
    sync_progress: f64,
    sync_running: bool,
    sync_log: Vec<String>,
    peers: Vec<PeerInfo>,
    peers_state: TableState,

    // Display
    time_format_human: bool,
}

impl App {
    fn new(db_path: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let store = nostr_dag::store::EventStore::open(db_path)?;
        let mut app = Self {
            tab: Tab::Dashboard,
            db_path: db_path.to_string(),
            store,
            event_count: 0,
            relay_count: 0,
            user_count: 0,
            last_refresh: None,
            events: Vec::new(),
            events_state: TableState::default(),
            relays: Vec::new(),
            relays_state: TableState::default(),
            users: Vec::new(),
            users_state: TableState::default(),
            sync_urls: vec![std::env::var("PEER_URL").unwrap_or_else(|_| "http://127.0.0.1:3000".to_string())],
            sync_url_index: 0,
            sync_dropdown_open: false,
            sync_focus: SyncFocus::UrlDropdown,
            sync_status: "Idle".to_string(),
            sync_progress: 0.0,
            sync_running: false,
            sync_log: Vec::new(),
            peers: Vec::new(),
            peers_state: TableState::default(),
            time_format_human: false,
        };
        app.refresh_dashboard();
        app.refresh_events();
        app.refresh_relays();
        app.refresh_users();
        // Defer peer fetch until first manual refresh or Sync tab visit
        // so startup isn't blocked by a slow / unreachable server.
        Ok(app)
    }

    fn refresh_dashboard(&mut self) {
        self.event_count = self.store.event_count().unwrap_or(0);
        self.relay_count = self.store.relay_count().unwrap_or(0);
        self.user_count = self.store.user_count().unwrap_or(0);
        self.last_refresh = Some(Instant::now());
    }

    fn refresh_events(&mut self) {
        self.events = self.store.recent_events(500).unwrap_or_default();
        if !self.events.is_empty() {
            self.events_state.select(Some(0));
        }
    }

    fn refresh_relays(&mut self) {
        self.relays = self.store.all_relays().unwrap_or_default();
        if !self.relays.is_empty() {
            self.relays_state.select(Some(0));
        }
    }

    fn refresh_users(&mut self) {
        self.users = self.store.all_users().unwrap_or_default();
        if !self.users.is_empty() {
            self.users_state.select(Some(0));
        }
    }

    fn refresh_all(&mut self) {
        self.refresh_dashboard();
        self.refresh_events();
        self.refresh_relays();
        self.refresh_users();
        self.refresh_peers();
    }

    fn refresh_peers(&mut self) {
        match fetch_peers_blocking(self.sync_url()) {
            Ok(entries) => {
                self.peers = entries.into_iter().map(|e| PeerInfo {
                    id: e.peer_id,
                    pubkey: e.source.unwrap_or_default(),
                    addrs: if e.path.is_empty() {
                        e.detail.map(|d| vec![d]).unwrap_or_default()
                    } else {
                        let mut addrs = vec![e.path];
                        if let Some(d) = e.detail {
                            addrs.push(d);
                        }
                        addrs
                    },
                    last_seen: (e.updated_at / 1000) as i64,
                }).collect();
                self.push_sync_log(format!("Discovered {} peer(s)", self.peers.len()));
            }
            Err(err) => {
                self.push_sync_log(format!("Peer fetch failed: {}", err));
                if self.peers.is_empty() {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs() as i64;
                    self.peers = vec![
                        PeerInfo {
                            id: "12D3KooWSL8rLNFrwVGVBJbHWxXQfFTfVtYnozURrqBFYBMfrniH".to_string(),
                            pubkey: "2d724a13a80b6002607737ad1a99f3c0b148843707d59ac3bff08c7fce72ecce".to_string(),
                            addrs: vec!["/ip4/127.0.0.1/tcp/3000/ws".to_string()],
                            last_seen: now,
                        },
                    ];
                }
            }
        }
        if !self.peers.is_empty() {
            self.peers_state.select(Some(0));
        }
    }

    fn next_tab(&mut self) {
        let tabs = Tab::all();
        let idx = tabs.iter().position(|&t| t == self.tab).unwrap_or(0);
        self.tab = tabs[(idx + 1) % tabs.len()];
    }

    fn prev_tab(&mut self) {
        let tabs = Tab::all();
        let idx = tabs.iter().position(|&t| t == self.tab).unwrap_or(0);
        self.tab = tabs[(idx + tabs.len() - 1) % tabs.len()];
    }

    fn next_row(&mut self) {
        let (len, state) = match self.tab {
            Tab::Events => (self.events.len(), &mut self.events_state),
            Tab::Relays => (self.relays.len(), &mut self.relays_state),
            Tab::Users => (self.users.len(), &mut self.users_state),
            Tab::Sync => (self.peers.len(), &mut self.peers_state),
            _ => return,
        };
        let i = state.selected().unwrap_or(0);
        if i + 1 < len {
            state.select(Some(i + 1));
        }
    }

    fn prev_row(&mut self) {
        let state = match self.tab {
            Tab::Events => &mut self.events_state,
            Tab::Relays => &mut self.relays_state,
            Tab::Users => &mut self.users_state,
            Tab::Sync => &mut self.peers_state,
            _ => return,
        };
        let i = state.selected().unwrap_or(0);
        if i > 0 {
            state.select(Some(i - 1));
        }
    }

    fn push_sync_log(&mut self, msg: String) {
        self.sync_log.push(msg);
        if self.sync_log.len() > 100 {
            self.sync_log.remove(0);
        }
    }

    fn start_sync(&mut self) {
        if self.sync_running {
            return;
        }
        self.sync_running = true;
        self.sync_status = format!("Syncing from {}…", self.sync_url());
        self.sync_progress = 0.0;
        self.sync_log.clear();
        self.push_sync_log(format!("Starting sync from {}", self.sync_url()));
    }

    fn start_sync_peer(&mut self, idx: usize) {
        if self.sync_running {
            return;
        }
        if let Some(peer) = self.peers.get(idx) {
            self.sync_running = true;
            self.sync_status = format!("Syncing from {}…", elide_middle(&peer.id, 24));
            self.sync_progress = 0.0;
            self.sync_log.clear();
            self.push_sync_log(format!("Starting sync from peer {}", peer.id));
        }
    }

    fn start_sync_all(&mut self) {
        if self.sync_running {
            return;
        }
        self.sync_running = true;
        self.sync_status = "Syncing from all peers…".to_string();
        self.sync_progress = 0.0;
        self.sync_log.clear();
        self.push_sync_log("Starting sync from all peers".to_string());
        let ids: Vec<String> = self.peers.iter().map(|p| elide_middle(&p.id, 24)).collect();
        for id in ids {
            self.push_sync_log(format!("Queueing peer {}", id));
        }
    }

    fn tick_sync(&mut self) {
        if !self.sync_running {
            return;
        }
        // Run one sync step per tick; real implementation would spawn a task.
        // For now we just simulate progress.
        self.sync_progress += 0.05;
        if self.sync_progress >= 1.0 {
            self.sync_progress = 1.0;
            self.sync_running = false;
            self.sync_status = "Sync complete".to_string();
            self.push_sync_log("Sync finished (simulated)".to_string());
            self.refresh_all();
        } else {
            self.push_sync_log(format!("Progress {:.0}%", self.sync_progress * 100.0));
        }
    }

    fn sync_url(&self) -> &str {
        self.sync_urls.get(self.sync_url_index).map(|s| s.as_str()).unwrap_or("http://127.0.0.1:3000")
    }

    fn next_sync_focus(&mut self) {
        let all = SyncFocus::all();
        let idx = all.iter().position(|&f| f == self.sync_focus).unwrap_or(0);
        self.sync_focus = all[(idx + 1) % all.len()];
    }

    fn prev_sync_focus(&mut self) {
        let all = SyncFocus::all();
        let idx = all.iter().position(|&f| f == self.sync_focus).unwrap_or(0);
        self.sync_focus = all[(idx + all.len() - 1) % all.len()];
    }

    fn add_sync_url(&mut self) {
        // Add a placeholder URL with an incremented port
        let base = self.sync_url().trim_end_matches('/').to_string();
        let new_url = if let Some(pos) = base.rfind(':') {
            if let Ok(port) = base[pos + 1..].parse::<u16>() {
                format!("{}:{}", &base[..pos], port + 1)
            } else {
                format!("{}:3001", base)
            }
        } else {
            format!("{}:3001", base)
        };
        if !self.sync_urls.contains(&new_url) {
            self.sync_urls.push(new_url);
            self.sync_url_index = self.sync_urls.len() - 1;
        }
    }

    fn remove_sync_url(&mut self) {
        if self.sync_urls.len() > 1 {
            self.sync_urls.remove(self.sync_url_index);
            if self.sync_url_index >= self.sync_urls.len() {
                self.sync_url_index = self.sync_urls.len() - 1;
            }
        }
    }

    fn next_sync_url(&mut self) {
        if !self.sync_urls.is_empty() {
            self.sync_url_index = (self.sync_url_index + 1) % self.sync_urls.len();
        }
    }

    fn prev_sync_url(&mut self) {
        if !self.sync_urls.is_empty() {
            self.sync_url_index = (self.sync_url_index + self.sync_urls.len() - 1) % self.sync_urls.len();
        }
    }
}

// ---------------------------------------------------------------------------
// UI rendering
// ---------------------------------------------------------------------------

fn draw(f: &mut Frame, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(3), Constraint::Min(0)])
        .split(f.area());

    draw_tabs(f, app, chunks[0]);

    match app.tab {
        Tab::Dashboard => draw_dashboard(f, app, chunks[1]),
        Tab::Events => draw_events(f, app, chunks[1]),
        Tab::Relays => draw_relays(f, app, chunks[1]),
        Tab::Users => draw_users(f, app, chunks[1]),
        Tab::Sync => draw_sync(f, app, chunks[1]),
    }
}

fn draw_tabs(f: &mut Frame, app: &App, area: ratatui::layout::Rect) {
    let titles: Vec<Line> = Tab::all()
        .iter()
        .map(|&t| Line::from(t.title()))
        .collect();
    let tabs = Tabs::new(titles)
        .block(Block::default().borders(Borders::ALL).title("nostr-dag DB Viewer"))
        .select(Tab::all().iter().position(|&t| t == app.tab).unwrap_or(0))
        .style(Style::default().fg(Color::White))
        .highlight_style(Style::default().fg(Color::Black).bg(Color::Cyan).add_modifier(Modifier::BOLD))
        .divider(symbols::line::VERTICAL);
    f.render_widget(tabs, area);
}

fn draw_dashboard(f: &mut Frame, app: &App, area: ratatui::layout::Rect) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(10), Constraint::Min(0)])
        .split(area);

    let stats_text = format!(
        "Database: {}\n\n\
        Events: {}\n\
        Relays: {}\n\
        Users:  {}\n\n\
        Last refresh: {}",
        app.db_path,
        app.event_count,
        app.relay_count,
        app.user_count,
        app.last_refresh
            .map(|i| format!("{:?} ago", i.elapsed()))
            .unwrap_or_else(|| "—".to_string()),
    );
    let stats = Paragraph::new(stats_text)
        .block(Block::default().borders(Borders::ALL).title("Stats"))
        .wrap(Wrap { trim: true });
    f.render_widget(stats, chunks[0]);

    let help = Paragraph::new(
        "Keys:\n\
         Tab / →    next tab\n\
         Shift+Tab / ←  previous tab\n\
         j / ↓      next row\n\
         k / ↑      previous row\n\
         r          refresh all views\n\
         Shift+T    toggle time format\n\
         s          sync selected peer (on Sync tab)\n\
         Shift+S    sync all peers (on Sync tab)\n\
         q / Esc    quit",
    )
    .block(Block::default().borders(Borders::ALL).title("Help"))
    .wrap(Wrap { trim: true });
    f.render_widget(help, chunks[1]);
}

fn draw_events(f: &mut Frame, app: &mut App, area: ratatui::layout::Rect) {
    let header = Row::new(vec!["Kind", "Created", "Pubkey", "ID"])
        .style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))
        .height(1);
    let rows: Vec<Row> = app
        .events
        .iter()
        .map(|(id, kind, pubkey, created_at, _source_relay)| {
            Row::new(vec![
                Cell::from(kind.to_string()),
                Cell::from(app.format_timestamp(*created_at)),
                Cell::from(truncate(pubkey, 16)),
                Cell::from(id.as_str()),
            ])
            .height(1)
        })
        .collect();

    let table = Table::new(rows, [
        Constraint::Length(8),
        Constraint::Length(20),
        Constraint::Length(18),
        Constraint::Min(64),
    ])
    .header(header)
    .block(Block::default().borders(Borders::ALL).title(format!("Events ({})", app.events.len())))
    .row_highlight_style(Style::default().bg(Color::DarkGray))
    .highlight_symbol("> ");

    f.render_stateful_widget(table, area, &mut app.events_state);
}

fn draw_relays(f: &mut Frame, app: &mut App, area: ratatui::layout::Rect) {
    let header = Row::new(vec!["URL", "First seen", "Last seen", "Error"])
        .style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))
        .height(1);
    let rows: Vec<Row> = app
        .relays
        .iter()
        .map(|(url, first, last, error)| {
            Row::new(vec![
                Cell::from(url.clone()),
                Cell::from(app.format_timestamp_ms(*first)),
                Cell::from(app.format_timestamp_ms(*last)),
                Cell::from(error.clone().unwrap_or_default()).style(Style::default().fg(Color::Red)),
            ])
            .height(1)
        })
        .collect();

    let table = Table::new(rows, [
        Constraint::Percentage(40),
        Constraint::Length(20),
        Constraint::Length(20),
        Constraint::Percentage(20),
    ])
    .header(header)
    .block(Block::default().borders(Borders::ALL).title(format!("Relays ({})", app.relays.len())))
    .row_highlight_style(Style::default().bg(Color::DarkGray))
    .highlight_symbol("> ");

    f.render_stateful_widget(table, area, &mut app.relays_state);
}

fn draw_users(f: &mut Frame, app: &mut App, area: ratatui::layout::Rect) {
    let header = Row::new(vec!["Pubkey", "First seen", "Last seen"])
        .style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))
        .height(1);
    let rows: Vec<Row> = app
        .users
        .iter()
        .map(|(pubkey, first, last)| {
            Row::new(vec![
                Cell::from(truncate(pubkey, 32)),
                Cell::from(app.format_timestamp_ms(*first)),
                Cell::from(app.format_timestamp_ms(*last)),
            ])
            .height(1)
        })
        .collect();

    let table = Table::new(rows, [
        Constraint::Percentage(50),
        Constraint::Length(20),
        Constraint::Length(20),
    ])
    .header(header)
    .block(Block::default().borders(Borders::ALL).title(format!("Users ({})", app.users.len())))
    .row_highlight_style(Style::default().bg(Color::DarkGray))
    .highlight_symbol("> ");

    f.render_stateful_widget(table, area, &mut app.users_state);
}

fn focus_block(title: &str, active: bool) -> Block<'static> {
    if active {
        Block::default()
            .borders(Borders::ALL)
            .title(format!("* {} *", title))
            .border_style(Style::default().fg(Color::Cyan))
    } else {
        Block::default()
            .borders(Borders::ALL)
            .title(title.to_string())
            .border_style(Style::default().fg(Color::DarkGray))
    }
}

fn draw_sync(f: &mut Frame, app: &mut App, area: ratatui::layout::Rect) {
    let dropdown_height = if app.sync_dropdown_open {
        (app.sync_urls.len() as u16 + 2).min(10)
    } else {
        0
    };

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3 + dropdown_height), // sub-header + dropdown
            Constraint::Min(8),                      // main (sidebar + detail)
            Constraint::Length(3),                   // status + progress
            Constraint::Length(8),                   // log
        ])
        .split(area);

    // Sub-header with dropdown
    draw_sync_header(f, app, chunks[0]);

    // Main: sidebar + detail
    let main = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(30), Constraint::Percentage(70)])
        .split(chunks[1]);

    draw_peer_sidebar(f, app, main[0]);
    draw_peer_detail(f, app, main[1]);

    // Status + Progress
    let status_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(chunks[2]);

    let status_active = app.sync_focus == SyncFocus::StatusProgress;
    let status_para = Paragraph::new(app.sync_status.as_str())
        .block(focus_block("Status", status_active));
    f.render_widget(status_para, status_chunks[0]);

    let gauge = Gauge::default()
        .block(focus_block("Progress", false))
        .gauge_style(Style::default().fg(Color::Cyan))
        .ratio(app.sync_progress.clamp(0.0, 1.0));
    f.render_widget(gauge, status_chunks[1]);

    // Log
    let log_active = app.sync_focus == SyncFocus::Log;
    let log_text = app.sync_log.join("\n");
    let log_para = Paragraph::new(log_text)
        .block(focus_block("Log", log_active))
        .wrap(Wrap { trim: true })
        .scroll((app.sync_log.len().saturating_sub(10) as u16, 0));
    f.render_widget(log_para, chunks[3]);
}

fn draw_sync_header(f: &mut Frame, app: &mut App, area: ratatui::layout::Rect) {
    let is_active = app.sync_focus == SyncFocus::UrlDropdown;
    let title = if app.sync_dropdown_open {
        format!("Sync URL ({} urls) — a=add d=del ▼", app.sync_urls.len())
    } else {
        "Sync".to_string()
    };
    let block = focus_block(&title, is_active);
    let inner = block.inner(area);
    f.render_widget(block, area);

    if app.sync_dropdown_open {
        let items: Vec<Line> = app
            .sync_urls
            .iter()
            .enumerate()
            .map(|(i, url)| {
                let prefix = if i == app.sync_url_index { "> " } else { "  " };
                Line::from(format!("{}{}", prefix, url))
            })
            .collect();
        let scroll = app.sync_url_index.saturating_sub(3) as u16;
        let para = Paragraph::new(items)
            .wrap(Wrap { trim: true })
            .scroll((scroll, 0));
        f.render_widget(para, inner);
    } else {
        let text = format!(
            "URL: {}  |  Shift+S = sync all  |  Enter=open dropdown",
            app.sync_url()
        );
        let para = Paragraph::new(text);
        f.render_widget(para, inner);
    }
}

fn draw_peer_sidebar(f: &mut Frame, app: &mut App, area: ratatui::layout::Rect) {
    let active = app.sync_focus == SyncFocus::PeerSidebar;
    let header = Row::new(vec!["Peer ID"])
        .style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))
        .height(1);
    let rows: Vec<Row> = app
        .peers
        .iter()
        .map(|peer| {
            Row::new(vec![Cell::from(elide_middle(&peer.id, 24))])
                .height(1)
        })
        .collect();

    let table = Table::new(rows, [Constraint::Min(20)])
        .header(header)
        .block(focus_block(&format!("Peers ({})", app.peers.len()), active))
        .row_highlight_style(Style::default().bg(Color::DarkGray))
        .highlight_symbol("> ");
    f.render_stateful_widget(table, area, &mut app.peers_state);
}

fn draw_peer_detail(f: &mut Frame, app: &mut App, area: ratatui::layout::Rect) {
    let active = app.sync_focus == SyncFocus::PeerDetail;
    let block = focus_block("Peer Detail", active);
    let inner = block.inner(area);
    f.render_widget(block, area);

    if let Some(idx) = app.peers_state.selected() {
        if let Some(peer) = app.peers.get(idx) {
            let text = format!(
                "ID:        {}\n\
                 Pubkey:    {}\n\
                 Addrs:     {}\n\
                 Last seen: {}\n\n\
                 Press 's' to sync from this peer",
                peer.id,
                peer.pubkey,
                peer.addrs.join(", "),
                app.format_timestamp(peer.last_seen),
            );
            let para = Paragraph::new(text).wrap(Wrap { trim: true });
            f.render_widget(para, inner);
            return;
        }
    }

    let para = Paragraph::new("Select a peer from the sidebar to view details and sync controls.")
        .wrap(Wrap { trim: true });
    f.render_widget(para, inner);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max.saturating_sub(1)])
    }
}

/// Elide a string in the middle, keeping the start and end visible.
/// Useful for hex identifiers (event IDs, pubkeys) where both ends matter.
fn elide_middle(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else if max <= 3 {
        s[..max].to_string()
    } else {
        let keep = max - 3; // account for "..."
        let start_len = keep / 2;
        let end_len = keep - start_len;
        format!("{}...{}", &s[..start_len], &s[s.len() - end_len..])
    }
}

impl App {
    fn format_timestamp(&self, ts: i64) -> String {
        if self.time_format_human {
            chrono::DateTime::from_timestamp(ts, 0)
                .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_else(|| ts.to_string())
        } else {
            ts.to_string()
        }
    }

    fn format_timestamp_ms(&self, ts: i64) -> String {
        if self.time_format_human {
            chrono::DateTime::from_timestamp_millis(ts)
                .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_else(|| ts.to_string())
        } else {
            ts.to_string()
        }
    }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

fn run_app<B: Backend>(terminal: &mut Terminal<B>, mut app: App) -> io::Result<()> {
    let mut last_tick = Instant::now();
    let tick_rate = Duration::from_millis(TICK_MS);

    loop {
        terminal.draw(|f| draw(f, &mut app))?;

        let timeout = tick_rate.saturating_sub(last_tick.elapsed());
        if crossterm::event::poll(timeout)? {
            if let Event::Key(key) = event::read()? {
                match key.code {
                    KeyCode::Char('q') | KeyCode::Esc => return Ok(()),
                    KeyCode::Tab | KeyCode::Right => app.next_tab(),
                    KeyCode::BackTab | KeyCode::Left => app.prev_tab(),
                    KeyCode::Char('r') => app.refresh_all(),
                    KeyCode::Char('j') | KeyCode::Down => app.next_row(),
                    KeyCode::Char('k') | KeyCode::Up => app.prev_row(),
                    KeyCode::Char('T') if key.modifiers.contains(KeyModifiers::SHIFT) => {
                        app.time_format_human = !app.time_format_human;
                    }
                    KeyCode::Char('S') if key.modifiers.contains(KeyModifiers::SHIFT) && app.tab == Tab::Sync => {
                        app.start_sync_all();
                    }
                    KeyCode::Char('s') if app.tab == Tab::Sync && !app.sync_running => {
                        if let Some(idx) = app.peers_state.selected() {
                            app.start_sync_peer(idx);
                        } else {
                            app.start_sync();
                        }
                    }
                    _ => {}
                }
            }
        }

        if last_tick.elapsed() >= tick_rate {
            if app.sync_running {
                app.tick_sync();
            }
            last_tick = Instant::now();
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let db_path = std::env::var("DB_PATH").unwrap_or_else(|_| DB_PATH_DEFAULT.to_string());

    enable_raw_mode()?;
    let mut stdout = stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let app = App::new(&db_path)?;
    let res = run_app(&mut terminal, app);

    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;

    if let Err(err) = res {
        eprintln!("{}", err);
    }

    Ok(())
}
