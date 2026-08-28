//! Persistent SQLite store for the nostr-dag network DAG.
//!
//! # Schema
//!
//! Eight tables capture every entity the bridge and DAG track so that raw
//! events are never lost and relationships are fully traversable:
//!
//! - **`events`** — every raw Nostr event seen, verbatim
//! - **`tags`** — one row per tag field, normalised out of the JSON array
//! - **`relays`** — every unique relay URL seen, with cached NIP-11 info
//! - **`users`** — every pubkey seen
//! - **`user_relays`** — which relays a user lists (kind 10002 / kind 3)
//! - **`event_relays`** — which relays an event was published to / seen on
//! - **`dag_edges`** — parent→child links that form the DAG
//! - **`dag_seen_by`** — which peers have acked a DAG event
//!
//! The store is opened with [`EventStore::open`] and is safe to share across
//! threads via `Arc<Mutex<EventStore>>`.

use rusqlite::{params, Connection, OptionalExtension, Result};

/// Wrapper around a SQLite connection that holds the nostr-dag schema.
pub struct EventStore {
    conn: Connection,
}

impl EventStore {
    /// Open (or create) the store at `path`. Pass `":memory:"` for an
    /// in-process ephemeral store (useful in tests).
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;
        // Enable WAL for concurrent reads while a write is in progress.
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    // -----------------------------------------------------------------------
    // Schema migrations
    // -----------------------------------------------------------------------

    fn migrate(&self) -> Result<()> {
        self.conn
            .execute_batch(
                "
            -- Every raw Nostr event seen, verbatim.
            CREATE TABLE IF NOT EXISTS events (
                id           TEXT PRIMARY KEY,   -- hex sha256
                pubkey       TEXT NOT NULL,       -- hex author pubkey
                kind         INTEGER NOT NULL,    -- Nostr kind number
                created_at   INTEGER NOT NULL,    -- unix seconds
                content      TEXT NOT NULL,
                sig          TEXT NOT NULL,       -- schnorr sig
                raw_json     TEXT NOT NULL,       -- full serialised JSON
                first_seen_at INTEGER NOT NULL,   -- local wall-clock ms
                source_relay TEXT                 -- wss:// URL or NULL
            );

            -- One row per tag field; normalises the JSON tags array.
            CREATE TABLE IF NOT EXISTS tags (
                event_id   TEXT    NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                tag_name   TEXT    NOT NULL,   -- e.g. 'e', 'p', 'r', 't'
                tag_value  TEXT    NOT NULL,   -- first element after the name
                tag_extra  TEXT,              -- remaining elements as JSON array
                position   INTEGER NOT NULL,   -- index in the tags array
                PRIMARY KEY (event_id, position)
            );

            -- Every unique relay URL seen.
            CREATE TABLE IF NOT EXISTS relays (
                url             TEXT PRIMARY KEY,  -- normalised wss:// URL
                first_seen_at   INTEGER NOT NULL,
                last_seen_at    INTEGER NOT NULL,
                nip11_json      TEXT,              -- cached NIP-11 info doc JSON
                nip11_fetched_at INTEGER,
                error           TEXT               -- last fetch error, if any
            );

            -- Every pubkey seen.
            CREATE TABLE IF NOT EXISTS users (
                pubkey            TEXT PRIMARY KEY,  -- hex
                first_seen_at     INTEGER NOT NULL,
                last_seen_at      INTEGER NOT NULL,
                metadata_event_id TEXT REFERENCES events(id) ON DELETE SET NULL
            );

            -- Which relays a user lists (kind 10002 / kind 3).
            CREATE TABLE IF NOT EXISTS user_relays (
                pubkey           TEXT    NOT NULL REFERENCES users(pubkey) ON DELETE CASCADE,
                relay_url        TEXT    NOT NULL REFERENCES relays(url)   ON DELETE CASCADE,
                source_event_id  TEXT    REFERENCES events(id) ON DELETE SET NULL,
                marker           TEXT,   -- 'read', 'write', or NULL
                updated_at       INTEGER NOT NULL,
                PRIMARY KEY (pubkey, relay_url)
            );

            -- Which relays an event was published to / seen on.
            CREATE TABLE IF NOT EXISTS event_relays (
                event_id   TEXT    NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                relay_url  TEXT    NOT NULL REFERENCES relays(url) ON DELETE CASCADE,
                seen_at    INTEGER NOT NULL,
                verified   INTEGER NOT NULL DEFAULT 0,  -- 0 = unverified, 1 = confirmed
                PRIMARY KEY (event_id, relay_url)
            );

            -- Parent→child links that form the DAG (from 'e' tags).
            CREATE TABLE IF NOT EXISTS dag_edges (
                parent_id  TEXT    NOT NULL,
                child_id   TEXT    NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                depth      INTEGER NOT NULL DEFAULT 0,  -- computed depth of child_id
                PRIMARY KEY (parent_id, child_id)
            );

            -- Which peers have acked a DAG event (mirrors Dag.seen_by).
            CREATE TABLE IF NOT EXISTS dag_seen_by (
                event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                pubkey       TEXT NOT NULL REFERENCES users(pubkey) ON DELETE CASCADE,
                ack_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
                PRIMARY KEY (event_id, pubkey)
            );

            -- Indices for common access patterns.
            CREATE INDEX IF NOT EXISTS idx_events_pubkey     ON events(pubkey);
            CREATE INDEX IF NOT EXISTS idx_events_kind       ON events(kind);
            CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
            CREATE INDEX IF NOT EXISTS idx_tags_name_value   ON tags(tag_name, tag_value);
            CREATE INDEX IF NOT EXISTS idx_user_relays_relay ON user_relays(relay_url);
            CREATE INDEX IF NOT EXISTS idx_event_relays_relay ON event_relays(relay_url);
            CREATE INDEX IF NOT EXISTS idx_dag_edges_child   ON dag_edges(child_id);
            CREATE INDEX IF NOT EXISTS idx_dag_seen_by_event ON dag_seen_by(event_id);
            ",
            )
            .and_then(|_| self.migrate_dag_edges_schema())
    }

    fn migrate_dag_edges_schema(&self) -> Result<()> {
        let legacy = self
            .conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dag_edges'",
                [],
                |row| row.get::<_, Option<String>>(0),
            )?
            .unwrap_or_default();
        if !legacy.contains("parent_id  TEXT    NOT NULL REFERENCES events(id)") {
            return Ok(());
        }

        self.conn.execute_batch(
            "
            PRAGMA foreign_keys=OFF;
            ALTER TABLE dag_edges RENAME TO dag_edges_legacy;
            CREATE TABLE dag_edges (
                parent_id  TEXT    NOT NULL,
                child_id   TEXT    NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                depth      INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (parent_id, child_id)
            );
            INSERT INTO dag_edges (parent_id, child_id, depth)
            SELECT parent_id, child_id, depth FROM dag_edges_legacy;
            DROP TABLE dag_edges_legacy;
            PRAGMA foreign_keys=ON;
            ",
        )
    }

    // -----------------------------------------------------------------------
    // Relay helpers
    // -----------------------------------------------------------------------

    /// Insert a relay URL if it has not been seen before; otherwise update
    /// `last_seen_at`.
    pub fn upsert_relay(&self, url: &str, now_ms: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO relays (url, first_seen_at, last_seen_at)
             VALUES (?1, ?2, ?2)
             ON CONFLICT(url) DO UPDATE SET last_seen_at = excluded.last_seen_at",
            params![url, now_ms],
        )?;
        Ok(())
    }

    /// Store the fetched NIP-11 info document for a relay.
    pub fn set_relay_nip11(&self, url: &str, nip11_json: &str, now_ms: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE relays SET nip11_json = ?1, nip11_fetched_at = ?2, error = NULL
             WHERE url = ?3",
            params![nip11_json, now_ms, url],
        )?;
        Ok(())
    }

    /// Record a fetch error for a relay.
    pub fn set_relay_error(&self, url: &str, error: &str, now_ms: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE relays SET error = ?1, nip11_fetched_at = ?2 WHERE url = ?3",
            params![error, now_ms, url],
        )?;
        Ok(())
    }

    /// Return all known relay URLs.
    pub fn all_relay_urls(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT url FROM relays ORDER BY url")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.collect()
    }

    // -----------------------------------------------------------------------
    // User helpers
    // -----------------------------------------------------------------------

    /// Insert a user pubkey if not seen; otherwise update `last_seen_at`.
    pub fn upsert_user(&self, pubkey: &str, now_ms: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO users (pubkey, first_seen_at, last_seen_at)
             VALUES (?1, ?2, ?2)
             ON CONFLICT(pubkey) DO UPDATE SET last_seen_at = excluded.last_seen_at",
            params![pubkey, now_ms],
        )?;
        Ok(())
    }

    /// Point a user's `metadata_event_id` to the given kind-0 event id.
    pub fn set_user_metadata_event(&self, pubkey: &str, event_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE users SET metadata_event_id = ?1 WHERE pubkey = ?2",
            params![event_id, pubkey],
        )?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Event helpers
    // -----------------------------------------------------------------------

    /// Insert a raw event (no-op if the id already exists).
    ///
    /// Also inserts:
    /// - A row in `users` for the author
    /// - A row in `relays` for `source_relay` if provided
    /// - Rows in `tags` for every tag field
    /// - Rows in `dag_edges` for every `e`-tag parent reference
    pub fn upsert_event(
        &self,
        id: &str,
        pubkey: &str,
        kind: i64,
        created_at: i64,
        content: &str,
        sig: &str,
        raw_json: &str,
        tags: &[Vec<String>],
        source_relay: Option<&str>,
        now_ms: i64,
    ) -> Result<()> {
        // Ensure relay and user rows exist first (FK targets).
        if let Some(relay) = source_relay {
            self.upsert_relay(relay, now_ms)?;
        }
        self.upsert_user(pubkey, now_ms)?;

        // Insert the event (ignore duplicate).
        self.conn.execute(
            "INSERT OR IGNORE INTO events
             (id, pubkey, kind, created_at, content, sig, raw_json, first_seen_at, source_relay)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                pubkey,
                kind,
                created_at,
                content,
                sig,
                raw_json,
                now_ms,
                source_relay
            ],
        )?;

        // Insert normalised tag rows.
        for (pos, tag) in tags.iter().enumerate() {
            if tag.is_empty() {
                continue;
            }
            let name = &tag[0];
            let value = tag.get(1).map(|s| s.as_str()).unwrap_or("");
            let extra = if tag.len() > 2 {
                Some(serde_json::to_string(&tag[2..]).unwrap_or_default())
            } else {
                None
            };
            self.conn.execute(
                "INSERT OR IGNORE INTO tags (event_id, tag_name, tag_value, tag_extra, position)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, name, value, extra, pos as i64],
            )?;

            // Record DAG edges for every 'e' parent reference.
            if name == "e" && !value.is_empty() {
                self.conn.execute(
                    "INSERT OR IGNORE INTO dag_edges (parent_id, child_id) VALUES (?1, ?2)",
                    params![value, id],
                )?;
            }

            // Record relay URLs from 'r' tags.
            if name == "r" && !value.is_empty() {
                self.upsert_relay(value, now_ms)?;
                self.upsert_user_relay(pubkey, value, id, None, now_ms)?;
            }
        }

        // For kind 0, update the user's metadata pointer.
        if kind == 0 {
            self.set_user_metadata_event(pubkey, id)?;
        }

        Ok(())
    }

    /// Record a source relay for an event (idempotent).
    pub fn upsert_event_relay(
        &self,
        event_id: &str,
        relay_url: &str,
        seen_at: i64,
        verified: bool,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO event_relays (event_id, relay_url, seen_at, verified)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(event_id, relay_url) DO UPDATE SET
               seen_at = MIN(seen_at, excluded.seen_at),
               verified = MAX(verified, excluded.verified)",
            params![event_id, relay_url, seen_at, verified as i64],
        )?;
        Ok(())
    }

    /// Mark an event as verified (or unverified) on a relay.
    pub fn set_event_relay_verified(
        &self,
        event_id: &str,
        relay_url: &str,
        verified: bool,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE event_relays SET verified = ?1
             WHERE event_id = ?2 AND relay_url = ?3",
            params![verified as i64, event_id, relay_url],
        )?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // User-relay helpers
    // -----------------------------------------------------------------------

    /// Record that `pubkey` lists `relay_url` (from kind 10002 / kind 3).
    pub fn upsert_user_relay(
        &self,
        pubkey: &str,
        relay_url: &str,
        source_event_id: &str,
        marker: Option<&str>,
        updated_at: i64,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO user_relays (pubkey, relay_url, source_event_id, marker, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(pubkey, relay_url) DO UPDATE SET
               source_event_id = excluded.source_event_id,
               marker = COALESCE(excluded.marker, marker),
               updated_at = excluded.updated_at",
            params![pubkey, relay_url, source_event_id, marker, updated_at],
        )?;
        Ok(())
    }

    /// Return all relay URLs a pubkey has ever listed.
    pub fn relays_for_user(&self, pubkey: &str) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT relay_url FROM user_relays WHERE pubkey = ?1 ORDER BY relay_url")?;
        let rows = stmt.query_map(params![pubkey], |row| row.get(0))?;
        rows.collect()
    }

    // -----------------------------------------------------------------------
    // DAG helpers
    // -----------------------------------------------------------------------

    /// Record a peer ack for an event, optionally linking the ack event itself.
    pub fn upsert_dag_seen_by(
        &self,
        event_id: &str,
        peer_pubkey: &str,
        ack_event_id: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO dag_seen_by (event_id, pubkey, ack_event_id)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(event_id, pubkey) DO UPDATE SET
               ack_event_id = COALESCE(excluded.ack_event_id, ack_event_id)",
            params![event_id, peer_pubkey, ack_event_id],
        )?;
        Ok(())
    }

    /// Update the cached depth for a DAG edge.
    pub fn set_dag_edge_depth(&self, parent_id: &str, child_id: &str, depth: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE dag_edges SET depth = ?1 WHERE parent_id = ?2 AND child_id = ?3",
            params![depth, parent_id, child_id],
        )?;
        Ok(())
    }

    /// Return all event IDs that have acked `event_id`.
    pub fn seen_by_for_event(&self, event_id: &str) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT pubkey FROM dag_seen_by WHERE event_id = ?1")?;
        let rows = stmt.query_map(params![event_id], |row| row.get(0))?;
        rows.collect()
    }

    /// Return all parent IDs for `child_id` (one level up).
    pub fn parents_of(&self, child_id: &str) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT parent_id FROM dag_edges WHERE child_id = ?1")?;
        let rows = stmt.query_map(params![child_id], |row| row.get(0))?;
        rows.collect()
    }

    /// Return all child IDs for `parent_id` (one level down).
    pub fn children_of(&self, parent_id: &str) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT child_id FROM dag_edges WHERE parent_id = ?1")?;
        let rows = stmt.query_map(params![parent_id], |row| row.get(0))?;
        rows.collect()
    }

    // -----------------------------------------------------------------------
    // Query helpers
    // -----------------------------------------------------------------------

    /// Return raw JSON for an event by id, or `None` if not stored.
    pub fn get_event_json(&self, id: &str) -> Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT raw_json FROM events WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()
    }

    /// Return raw JSON for all stored events matching a kind, ordered by
    /// `created_at DESC`. Returns at most `limit` rows.
    pub fn events_by_kind(&self, kind: i64, limit: usize) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT raw_json FROM events
             WHERE kind = ?1 ORDER BY created_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![kind, limit as i64], |row| row.get(0))?;
        rows.collect()
    }

    /// Return raw JSON for all stored events from a pubkey, ordered by
    /// `created_at DESC`. Returns at most `limit` rows.
    pub fn events_by_pubkey(&self, pubkey: &str, limit: usize) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT raw_json FROM events
             WHERE pubkey = ?1 ORDER BY created_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![pubkey, limit as i64], |row| row.get(0))?;
        rows.collect()
    }

    /// Return raw JSON for all stored events seen on a relay, ordered by
    /// `seen_at DESC`. Returns at most `limit` rows.
    pub fn events_for_relay(&self, relay_url: &str, limit: usize) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT e.raw_json FROM events e
             JOIN event_relays er ON er.event_id = e.id
             WHERE er.relay_url = ?1
             ORDER BY er.seen_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![relay_url, limit as i64], |row| row.get(0))?;
        rows.collect()
    }

    /// Total number of events stored.
    pub fn event_count(&self) -> Result<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
    }

    /// Total number of unique relay URLs stored.
    pub fn relay_count(&self) -> Result<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM relays", [], |row| row.get(0))
    }

    /// Total number of unique users (pubkeys) stored.
    pub fn user_count(&self) -> Result<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> EventStore {
        EventStore::open(":memory:").expect("in-memory store")
    }

    #[test]
    fn schema_creates_tables() {
        let store = mem();
        assert_eq!(store.event_count().unwrap(), 0);
        assert_eq!(store.relay_count().unwrap(), 0);
        assert_eq!(store.user_count().unwrap(), 0);
    }

    #[test]
    fn upsert_relay_idempotent() {
        let store = mem();
        store.upsert_relay("wss://nos.lol", 1_000).unwrap();
        store.upsert_relay("wss://nos.lol", 2_000).unwrap();
        assert_eq!(store.relay_count().unwrap(), 1);
        let urls = store.all_relay_urls().unwrap();
        assert_eq!(urls, vec!["wss://nos.lol"]);
    }

    #[test]
    fn upsert_event_inserts_tags_and_edges() {
        let store = mem();
        let parent_id = "aaaa";
        let child_id = "bbbb";

        // Insert the parent first so the FK is satisfied.
        store
            .upsert_event(
                parent_id,
                "pubkey1",
                21000,
                1_000,
                "",
                "sig1",
                "{}",
                &[],
                None,
                1_000,
            )
            .unwrap();

        let tags = vec![
            vec!["e".to_string(), parent_id.to_string()],
            vec!["r".to_string(), "wss://relay.example.com".to_string()],
        ];
        store
            .upsert_event(
                child_id, "pubkey1", 21000, 2_000, "", "sig2", "{}", &tags, None, 2_000,
            )
            .unwrap();

        assert_eq!(store.event_count().unwrap(), 2);
        assert_eq!(
            store.parents_of(child_id).unwrap(),
            vec![parent_id.to_string()]
        );
        assert_eq!(
            store.children_of(parent_id).unwrap(),
            vec![child_id.to_string()]
        );
        // 'r' tag should have created a relay row.
        assert!(store.relay_count().unwrap() >= 1);
    }

    #[test]
    fn upsert_event_allows_missing_parent() {
        let store = mem();
        let child_id = "bbbb";
        let missing_parent_id = "aaaa";

        let tags = vec![vec!["e".to_string(), missing_parent_id.to_string()]];
        store
            .upsert_event(
                child_id, "pubkey1", 21000, 2_000, "", "sig2", "{}", &tags, None, 2_000,
            )
            .unwrap();

        assert_eq!(
            store.parents_of(child_id).unwrap(),
            vec![missing_parent_id.to_string()]
        );
        assert_eq!(
            store.children_of(missing_parent_id).unwrap(),
            vec![child_id.to_string()]
        );
    }

    #[test]
    fn upsert_event_relay_and_verification() {
        let store = mem();
        store
            .upsert_event("evt1", "pk1", 1, 1_000, "", "sig", "{}", &[], None, 1_000)
            .unwrap();
        store.upsert_relay("wss://r.example.com", 1_000).unwrap();
        store
            .upsert_event_relay("evt1", "wss://r.example.com", 1_000, false)
            .unwrap();
        store
            .set_event_relay_verified("evt1", "wss://r.example.com", true)
            .unwrap();
        let events = store.events_for_relay("wss://r.example.com", 10).unwrap();
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn dag_seen_by() {
        let store = mem();
        store
            .upsert_event(
                "evt1",
                "pk1",
                21000,
                1_000,
                "",
                "sig",
                "{}",
                &[],
                None,
                1_000,
            )
            .unwrap();
        store
            .upsert_event(
                "ack1",
                "pk2",
                21000,
                1_100,
                "",
                "sig2",
                "{}",
                &[],
                None,
                1_100,
            )
            .unwrap();
        store
            .upsert_dag_seen_by("evt1", "pk2", Some("ack1"))
            .unwrap();
        let seen = store.seen_by_for_event("evt1").unwrap();
        assert_eq!(seen, vec!["pk2".to_string()]);
    }

    #[test]
    fn relays_for_user() {
        let store = mem();
        store.upsert_relay("wss://r.example.com", 1_000).unwrap();
        store.upsert_user("pk1", 1_000).unwrap();
        store
            .upsert_event(
                "src1",
                "pk1",
                10002,
                1_000,
                "",
                "sig",
                "{}",
                &[],
                None,
                1_000,
            )
            .unwrap();
        store
            .upsert_user_relay("pk1", "wss://r.example.com", "src1", Some("write"), 1_000)
            .unwrap();
        let relays = store.relays_for_user("pk1").unwrap();
        assert_eq!(relays, vec!["wss://r.example.com"]);
    }

    #[test]
    fn migrate_rebuilds_legacy_dag_edges_schema() {
        let path = {
            let mut path = std::env::temp_dir();
            path.push(format!("nostr-dag-legacy-{}.db", std::process::id()));
            let _ = std::fs::remove_file(&path);
            path
        };

        {
            let conn = Connection::open(&path).expect("legacy db");
            conn.execute_batch(
                "
                PRAGMA foreign_keys=ON;
                CREATE TABLE events (
                    id           TEXT PRIMARY KEY,
                    pubkey       TEXT NOT NULL,
                    kind         INTEGER NOT NULL,
                    created_at   INTEGER NOT NULL,
                    content      TEXT NOT NULL,
                    sig          TEXT NOT NULL,
                    raw_json     TEXT NOT NULL,
                    first_seen_at INTEGER NOT NULL,
                    source_relay TEXT
                );
                CREATE TABLE dag_edges (
                    parent_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                    child_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                    depth INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (parent_id, child_id)
                );
                INSERT INTO events (id, pubkey, kind, created_at, content, sig, raw_json, first_seen_at, source_relay)
                VALUES
                    ('parent1', 'pk0', 1, 1, '', 'sig', '{}', 1, NULL),
                    ('child1', 'pk1', 21000, 1, '', 'sig', '{}', 1, NULL);
                INSERT INTO dag_edges (parent_id, child_id, depth) VALUES ('parent1', 'child1', 0);
                ",
            )
            .expect("seed legacy schema");
        }

        let store = EventStore::open(path.to_str().expect("path")).expect("migrated store");
        store
            .upsert_event(
                "child1",
                "pk1",
                21000,
                1_000,
                "",
                "sig",
                "{}",
                &[],
                None,
                1_000,
            )
            .unwrap();
        assert_eq!(
            store.children_of("parent1").unwrap(),
            vec!["child1".to_string()]
        );

        let _ = std::fs::remove_file(&path);
    }
}
