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
    sync_url: String,
    sync_status: String,
    sync_progress: f64,
    sync_running: bool,
    sync_log: Vec<String>,

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
            sync_url: std::env::var("PEER_URL").unwrap_or_else(|_| "http://127.0.0.1:3000".to_string()),
            sync_status: "Idle".to_string(),
            sync_progress: 0.0,
            sync_running: false,
            sync_log: Vec::new(),
            time_format_human: false,
        };
        app.refresh_all();
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
        self.sync_status = format!("Syncing from {}…", self.sync_url);
        self.sync_progress = 0.0;
        self.sync_log.clear();
        self.push_sync_log(format!("Starting sync from {}", self.sync_url));
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
         s          start sync (on Sync tab)\n\
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

fn draw_sync(f: &mut Frame, app: &mut App, area: ratatui::layout::Rect) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(3),
            Constraint::Length(3),
            Constraint::Min(0),
        ])
        .split(area);

    let url_para = Paragraph::new(app.sync_url.as_str())
        .block(Block::default().borders(Borders::ALL).title("Peer URL"));
    f.render_widget(url_para, chunks[0]);

    let status_para = Paragraph::new(app.sync_status.as_str())
        .block(Block::default().borders(Borders::ALL).title("Status"));
    f.render_widget(status_para, chunks[1]);

    let gauge = Gauge::default()
        .block(Block::default().borders(Borders::ALL).title("Progress"))
        .gauge_style(Style::default().fg(Color::Cyan))
        .ratio(app.sync_progress.clamp(0.0, 1.0));
    f.render_widget(gauge, chunks[2]);

    let log_text = app.sync_log.join("\n");
    let log_para = Paragraph::new(log_text)
        .block(Block::default().borders(Borders::ALL).title("Log"))
        .wrap(Wrap { trim: true })
        .scroll((app.sync_log.len().saturating_sub(10) as u16, 0));
    f.render_widget(log_para, chunks[3]);
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
                    KeyCode::Char('s') if app.tab == Tab::Sync && !app.sync_running => {
                        app.start_sync();
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
