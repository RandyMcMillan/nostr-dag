/**
 * dag-db.mjs — Browser-side IndexedDB store for the nostr-dag network DAG.
 *
 * Mirrors the Rust SQLite schema so every entity the bridge and DAG track is
 * persisted locally and survives page reloads.
 *
 * Eight object stores (tables):
 *   events       — every raw Nostr event seen, verbatim
 *   tags         — one row per tag field, normalised out of the JSON array
 *   relays       — every unique relay URL seen, with cached NIP-11 info and ping time
 *   users        — every pubkey seen
 *   user_relays  — which relays a user lists (kind 10002 / kind 3)
 *   event_relays — which relays an event was published to / seen on
 *   dag_edges    — parent→child links that form the DAG
 *   dag_seen_by  — which peers have acked a DAG event
 *
 * Usage:
 *   import { openDagDb } from './dag-db.mjs';
 *   const db = await openDagDb();
 *   await db.upsertEvent(event, sourceRelay);
 */

const DB_NAME = 'nostr-dag-db';
const DB_VERSION = 1;

// ---------------------------------------------------------------------------
// Schema upgrade
// ---------------------------------------------------------------------------

function upgrade(db) {
  // events — every raw Nostr event seen, verbatim
  if (!db.objectStoreNames.contains('events')) {
    const events = db.createObjectStore('events', { keyPath: 'id' });
    events.createIndex('by_pubkey',     'pubkey',     { unique: false });
    events.createIndex('by_kind',       'kind',       { unique: false });
    events.createIndex('by_created_at', 'created_at', { unique: false });
    events.createIndex('by_source_relay', 'source_relay', { unique: false });
  }

  // tags — one row per tag element
  // Compound key: [event_id, position]
  if (!db.objectStoreNames.contains('tags')) {
    const tags = db.createObjectStore('tags', { keyPath: ['event_id', 'position'] });
    tags.createIndex('by_event',      'event_id',              { unique: false });
    tags.createIndex('by_name_value', ['tag_name', 'tag_value'], { unique: false });
  }

  // relays — every unique relay URL seen
  if (!db.objectStoreNames.contains('relays')) {
    db.createObjectStore('relays', { keyPath: 'url' });
  }

  // users — every pubkey seen
  if (!db.objectStoreNames.contains('users')) {
    db.createObjectStore('users', { keyPath: 'pubkey' });
  }

  // user_relays — which relays a user lists
  // Compound key: [pubkey, relay_url]
  if (!db.objectStoreNames.contains('user_relays')) {
    const userRelays = db.createObjectStore('user_relays', { keyPath: ['pubkey', 'relay_url'] });
    userRelays.createIndex('by_pubkey', 'pubkey',    { unique: false });
    userRelays.createIndex('by_relay',  'relay_url', { unique: false });
  }

  // event_relays — which relays an event was published to / seen on
  // Compound key: [event_id, relay_url]
  if (!db.objectStoreNames.contains('event_relays')) {
    const eventRelays = db.createObjectStore('event_relays', { keyPath: ['event_id', 'relay_url'] });
    eventRelays.createIndex('by_event', 'event_id',  { unique: false });
    eventRelays.createIndex('by_relay', 'relay_url', { unique: false });
  }

  // dag_edges — parent→child links
  // Compound key: [parent_id, child_id]
  if (!db.objectStoreNames.contains('dag_edges')) {
    const edges = db.createObjectStore('dag_edges', { keyPath: ['parent_id', 'child_id'] });
    edges.createIndex('by_parent', 'parent_id', { unique: false });
    edges.createIndex('by_child',  'child_id',  { unique: false });
  }

  // dag_seen_by — which peers have acked a DAG event
  // Compound key: [event_id, pubkey]
  if (!db.objectStoreNames.contains('dag_seen_by')) {
    const seenBy = db.createObjectStore('dag_seen_by', { keyPath: ['event_id', 'pubkey'] });
    seenBy.createIndex('by_event',  'event_id', { unique: false });
    seenBy.createIndex('by_pubkey', 'pubkey',   { unique: false });
  }
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function promisifyRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function txStore(db, storeName, mode) {
  const tx = db.transaction(storeName, mode);
  return { tx, store: tx.objectStore(storeName) };
}

// ---------------------------------------------------------------------------
// DagDb — public API
// ---------------------------------------------------------------------------

export class DagDb {
  /** @param {IDBDatabase} db */
  constructor(db) {
    this._db = db;
  }

  // -------------------------------------------------------------------------
  // Relay helpers
  // -------------------------------------------------------------------------

  /**
   * Insert or update a relay record.
   * @param {string} url  — normalised wss:// URL
   * @param {number} [nowMs]
   */
  async upsertRelay(url, nowMs = Date.now()) {
    const { store } = txStore(this._db, 'relays', 'readwrite');
    const existing = await promisifyRequest(store.get(url));
    await promisifyRequest(store.put(
      existing
        ? { ...existing, last_seen_at: nowMs }
        : { url, first_seen_at: nowMs, last_seen_at: nowMs, nip11_json: null, nip11_fetched_at: null, error: null }
    ));
  }

  /**
   * Store a fetched NIP-11 info doc for a relay.
   * @param {string} url
   * @param {object} nip11
   */
  async setRelayNip11(url, nip11, nowMs = Date.now()) {
    await this.setRelayInfo(url, { nip11_json: nip11, nip11_fetched_at: nowMs, error: null }, nowMs);
  }

  /**
   * Store a measured ping time for a relay.
   * @param {string} url
   * @param {number} pingMs
   * @param {number} [nowMs]
   */
  async setRelayPing(url, pingMs, nowMs = Date.now()) {
    await this.setRelayInfo(url, { ping_ms: pingMs, ping_fetched_at: nowMs, ping_error: null }, nowMs);
  }

  /**
   * Store the full relay metadata payload.
   * @param {string} url
   * @param {object} info
   * @param {number} [nowMs]
   */
  async setRelayInfo(url, info, nowMs = Date.now()) {
    const { store } = txStore(this._db, 'relays', 'readwrite');
    const existing = await promisifyRequest(store.get(url));
    const next = existing
      ? { ...existing, ...info, last_seen_at: nowMs }
      : { url, first_seen_at: nowMs, last_seen_at: nowMs, nip11_json: null, nip11_fetched_at: null, error: null, ...info };
    await promisifyRequest(store.put(next));
  }

  /**
   * Record a fetch error for a relay.
   * @param {string} url
   * @param {string} error
   */
  async setRelayError(url, error, nowMs = Date.now()) {
    const { store } = txStore(this._db, 'relays', 'readwrite');
    const existing = await promisifyRequest(store.get(url));
    if (existing) {
      await promisifyRequest(store.put({ ...existing, error, nip11_fetched_at: nowMs }));
    }
  }

  /** @returns {Promise<string[]>} */
  async allRelayUrls() {
    const { store } = txStore(this._db, 'relays', 'readonly');
    const all = await promisifyRequest(store.getAll());
    return all.map((r) => r.url).sort();
  }

  /** @returns {Promise<number>} */
  async relayCount() {
    const { store } = txStore(this._db, 'relays', 'readonly');
    return promisifyRequest(store.count());
  }

  // -------------------------------------------------------------------------
  // User helpers
  // -------------------------------------------------------------------------

  /**
   * Insert or update a user pubkey record.
   * @param {string} pubkey  hex
   * @param {number} [nowMs]
   */
  async upsertUser(pubkey, nowMs = Date.now()) {
    const { store } = txStore(this._db, 'users', 'readwrite');
    const existing = await promisifyRequest(store.get(pubkey));
    await promisifyRequest(store.put(
      existing
        ? { ...existing, last_seen_at: nowMs }
        : { pubkey, first_seen_at: nowMs, last_seen_at: nowMs, metadata_event_id: null }
    ));
  }

  /**
   * Point a user's metadata_event_id to a kind-0 event.
   * @param {string} pubkey
   * @param {string} eventId
   */
  async setUserMetadataEvent(pubkey, eventId) {
    const { store } = txStore(this._db, 'users', 'readwrite');
    const existing = await promisifyRequest(store.get(pubkey));
    if (existing) {
      await promisifyRequest(store.put({ ...existing, metadata_event_id: eventId }));
    }
  }

  /** @returns {Promise<number>} */
  async userCount() {
    const { store } = txStore(this._db, 'users', 'readonly');
    return promisifyRequest(store.count());
  }

  // -------------------------------------------------------------------------
  // Event helpers
  // -------------------------------------------------------------------------

  /**
   * Insert a raw Nostr event.  No-op if the id already exists.
   *
   * Also inserts / updates:
   *   - A `users` record for the author
   *   - A `relays` record for `sourceRelay` if provided
   *   - `tags` rows for every tag element
   *   - `dag_edges` rows for every `e`-tag parent reference
   *   - `relays` + `user_relays` rows for every `r`-tag relay URL
   *
   * @param {object} event        — raw Nostr event object
   * @param {string|null} [sourceRelay]  — wss:// URL this event arrived from
   * @param {number} [nowMs]
   */
  async upsertEvent(event, sourceRelay = null, nowMs = Date.now()) {
    if (!event?.id) return;

    // Ensure FK targets exist first.
    await this.upsertUser(event.pubkey, nowMs);
    if (sourceRelay) {
      await this.upsertRelay(sourceRelay, nowMs);
    }

    // Insert the event record (skip if id already present).
    const { store: evStore } = txStore(this._db, 'events', 'readwrite');
    const existing = await promisifyRequest(evStore.get(event.id));
    if (!existing) {
      await promisifyRequest(evStore.put({
        id:           event.id,
        pubkey:       event.pubkey,
        kind:         event.kind,
        created_at:   event.created_at,
        content:      event.content ?? '',
        sig:          event.sig ?? '',
        raw_json:     JSON.stringify(event),
        first_seen_at: nowMs,
        source_relay: sourceRelay,
      }));
    }

    // Normalise tags.
    const tags = Array.isArray(event.tags) ? event.tags : [];
    for (let pos = 0; pos < tags.length; pos++) {
      const tag = tags[pos];
      if (!Array.isArray(tag) || tag.length === 0) continue;
      const [name, value = '', ...rest] = tag;

      // tags store
      const { store: tagStore } = txStore(this._db, 'tags', 'readwrite');
      await promisifyRequest(tagStore.put({
        event_id:  event.id,
        position:  pos,
        tag_name:  name,
        tag_value: value,
        tag_extra: rest.length > 0 ? rest : null,
      }));

      // DAG edges from 'e' tags
      if (name === 'e' && value) {
        const { store: edgeStore } = txStore(this._db, 'dag_edges', 'readwrite');
        const existingEdge = await promisifyRequest(edgeStore.get([value, event.id]));
        if (!existingEdge) {
          await promisifyRequest(edgeStore.put({ parent_id: value, child_id: event.id, depth: 0 }));
        }
      }

      // Relay discovery from 'r' tags
      if (name === 'r' && value) {
        await this.upsertRelay(value, nowMs);
        await this.upsertUserRelay(event.pubkey, value, event.id, null, nowMs);
      }
    }

    // For kind 0, update the user's metadata pointer.
    if (event.kind === 0) {
      await this.setUserMetadataEvent(event.pubkey, event.id);
    }

    return event.id;
  }

  /** @returns {Promise<number>} */
  async eventCount() {
    const { store } = txStore(this._db, 'events', 'readonly');
    return promisifyRequest(store.count());
  }

  // -------------------------------------------------------------------------
  // Event-relay helpers
  // -------------------------------------------------------------------------

  /**
   * Record that an event was seen on (or published to) a relay.
   * @param {string} eventId
   * @param {string} relayUrl
   * @param {boolean} [verified]
   * @param {number} [nowMs]
   */
  async upsertEventRelay(eventId, relayUrl, verified = false, nowMs = Date.now()) {
    await this.upsertRelay(relayUrl, nowMs);
    const { store } = txStore(this._db, 'event_relays', 'readwrite');
    const existing = await promisifyRequest(store.get([eventId, relayUrl]));
    await promisifyRequest(store.put(
      existing
        ? { ...existing, verified: existing.verified || verified }
        : { event_id: eventId, relay_url: relayUrl, seen_at: nowMs, verified }
    ));
  }

  /** Mark an event as verified (or unverified) on a relay. */
  async setEventRelayVerified(eventId, relayUrl, verified) {
    const { store } = txStore(this._db, 'event_relays', 'readwrite');
    const existing = await promisifyRequest(store.get([eventId, relayUrl]));
    if (existing) {
      await promisifyRequest(store.put({ ...existing, verified }));
    }
  }

  // -------------------------------------------------------------------------
  // User-relay helpers
  // -------------------------------------------------------------------------

  /**
   * Record that a pubkey lists a relay (from kind 10002 / kind 3).
   * @param {string} pubkey
   * @param {string} relayUrl
   * @param {string} sourceEventId
   * @param {string|null} marker — 'read', 'write', or null
   * @param {number} [updatedAt]
   */
  async upsertUserRelay(pubkey, relayUrl, sourceEventId, marker = null, updatedAt = Date.now()) {
    const { store } = txStore(this._db, 'user_relays', 'readwrite');
    const existing = await promisifyRequest(store.get([pubkey, relayUrl]));
    await promisifyRequest(store.put(
      existing
        ? { ...existing, source_event_id: sourceEventId, marker: marker ?? existing.marker, updated_at: updatedAt }
        : { pubkey, relay_url: relayUrl, source_event_id: sourceEventId, marker, updated_at: updatedAt }
    ));
  }

  /**
   * Return all relay URLs a pubkey has ever listed.
   * @param {string} pubkey
   * @returns {Promise<string[]>}
   */
  async relaysForUser(pubkey) {
    const { store } = txStore(this._db, 'user_relays', 'readonly');
    const idx = store.index('by_pubkey');
    const rows = await promisifyRequest(idx.getAll(pubkey));
    return rows.map((r) => r.relay_url).sort();
  }

  // -------------------------------------------------------------------------
  // DAG helpers
  // -------------------------------------------------------------------------

  /**
   * Record that a peer has acked a DAG event.
   * @param {string} eventId
   * @param {string} peerPubkey
   * @param {string|null} [ackEventId]
   */
  async upsertDagSeenBy(eventId, peerPubkey, ackEventId = null) {
    const { store } = txStore(this._db, 'dag_seen_by', 'readwrite');
    const existing = await promisifyRequest(store.get([eventId, peerPubkey]));
    await promisifyRequest(store.put(
      existing
        ? { ...existing, ack_event_id: ackEventId ?? existing.ack_event_id }
        : { event_id: eventId, pubkey: peerPubkey, ack_event_id: ackEventId }
    ));
  }

  /** Update the cached depth for a DAG edge. */
  async setDagEdgeDepth(parentId, childId, depth) {
    const { store } = txStore(this._db, 'dag_edges', 'readwrite');
    const existing = await promisifyRequest(store.get([parentId, childId]));
    if (existing) {
      await promisifyRequest(store.put({ ...existing, depth }));
    }
  }

  /**
   * Return all pubkeys that have acked an event.
   * @param {string} eventId
   * @returns {Promise<string[]>}
   */
  async seenByForEvent(eventId) {
    const { store } = txStore(this._db, 'dag_seen_by', 'readonly');
    const idx = store.index('by_event');
    const rows = await promisifyRequest(idx.getAll(eventId));
    return rows.map((r) => r.pubkey);
  }

  /**
   * Return all parent event IDs for a child event (one level up).
   * @param {string} childId
   * @returns {Promise<string[]>}
   */
  async parentsOf(childId) {
    const { store } = txStore(this._db, 'dag_edges', 'readonly');
    const idx = store.index('by_child');
    const rows = await promisifyRequest(idx.getAll(childId));
    return rows.map((r) => r.parent_id);
  }

  /**
   * Return all child event IDs for a parent event (one level down).
   * @param {string} parentId
   * @returns {Promise<string[]>}
   */
  async childrenOf(parentId) {
    const { store } = txStore(this._db, 'dag_edges', 'readonly');
    const idx = store.index('by_parent');
    const rows = await promisifyRequest(idx.getAll(parentId));
    return rows.map((r) => r.child_id);
  }

  // -------------------------------------------------------------------------
  // Query helpers
  // -------------------------------------------------------------------------

  /**
   * Return the raw stored event object for an id, or null if not found.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getEvent(id) {
    const { store } = txStore(this._db, 'events', 'readonly');
    return promisifyRequest(store.get(id)) ?? null;
  }

  /**
   * Return all stored events of a given kind, sorted by created_at desc.
   * @param {number} kind
   * @param {number} [limit]
   * @returns {Promise<object[]>}
   */
  async eventsByKind(kind, limit = 100) {
    const { store } = txStore(this._db, 'events', 'readonly');
    const idx = store.index('by_kind');
    const rows = await promisifyRequest(idx.getAll(kind));
    return rows
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit);
  }

  /**
   * Return all stored events from a pubkey, sorted by created_at desc.
   * @param {string} pubkey
   * @param {number} [limit]
   * @returns {Promise<object[]>}
   */
  async eventsByPubkey(pubkey, limit = 100) {
    const { store } = txStore(this._db, 'events', 'readonly');
    const idx = store.index('by_pubkey');
    const rows = await promisifyRequest(idx.getAll(pubkey));
    return rows
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit);
  }

  /**
   * Return all stored events seen on a relay, sorted by seen_at desc.
   * @param {string} relayUrl
   * @param {number} [limit]
   * @returns {Promise<object[]>}
   */
  async eventsForRelay(relayUrl, limit = 100) {
    const { store: erStore } = txStore(this._db, 'event_relays', 'readonly');
    const idx = erStore.index('by_relay');
    const erRows = await promisifyRequest(idx.getAll(relayUrl));
    erRows.sort((a, b) => b.seen_at - a.seen_at);
    const ids = erRows.slice(0, limit).map((r) => r.event_id);

    const { store: evStore } = txStore(this._db, 'events', 'readonly');
    const events = await Promise.all(ids.map((id) => promisifyRequest(evStore.get(id))));
    return events.filter(Boolean);
  }

  /**
   * Return summary counts for the three main tables.
   * @returns {Promise<{events: number, relays: number, users: number}>}
   */
  async stats() {
    const [events, relays, users] = await Promise.all([
      this.eventCount(),
      this.relayCount(),
      this.userCount(),
    ]);
    return { events, relays, users };
  }

  /**
   * Post a raw event to the server's /events endpoint (when running on
   * localhost with the nostr-dag server).  Silently skips if unreachable.
   * @param {object} event
   * @param {string|null} [sourceRelay]
   */
  async syncEventToServer(event, sourceRelay = null) {
    try {
      const base = window.location.origin;
      if (!base.startsWith('http://localhost') && !base.startsWith('http://127.')) return;
      const body = sourceRelay
        ? JSON.stringify({ ...event, source_relay: sourceRelay })
        : JSON.stringify(event);
      await fetch(`${base}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch {
      // Silently ignore — server may not be running.
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Open (or upgrade) the IndexedDB database and return a {@link DagDb}.
 * @returns {Promise<DagDb>}
 */
export async function openDagDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (evt) => upgrade(evt.target.result);
    req.onsuccess = (evt) => resolve(new DagDb(evt.target.result));
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Singleton helper — opens the DB once and caches the instance.
 * @returns {Promise<DagDb>}
 */
let _dbPromise = null;
export function getDagDb() {
  if (!_dbPromise) _dbPromise = openDagDb();
  return _dbPromise;
}
