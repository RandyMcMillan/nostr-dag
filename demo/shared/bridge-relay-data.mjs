import { measureRelayPing } from './relay-ping.mjs';
import { getDagDb } from './dag-db.mjs';
import { APP_VERSION } from './app-version.mjs';

export const BRIDGE_CACHE_KEY = `nostr-dag-bridge-cache-${APP_VERSION}`;

export function normalizeRelayUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return value;
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return value.replace(/\/$/, '');
  }
}

export function createNostrRelay(relayUrl, data = {}) {
  const url = normalizeRelayUrl(relayUrl) || String(relayUrl || '').trim();
  return {
    url,
    fetch_url: data.fetch_url || '',
    fetched_at: data.fetched_at || 0,
    ping_ms: Number.isFinite(Number(data.ping_ms)) ? Number(data.ping_ms) : null,
    ping_fetched_at: data.ping_fetched_at || 0,
    ping_error: data.ping_error || '',
    name: data.name || '',
    description: data.description || '',
    pubkey: data.pubkey || '',
    contact: data.contact || '',
    software: data.software || '',
    version: data.version || '',
    icon: data.icon || '',
    limitation: data.limitation && typeof data.limitation === 'object' ? data.limitation : {},
    supported_nips: Array.isArray(data.supported_nips) ? data.supported_nips.filter((nip) => nip !== null && nip !== undefined && nip !== '') : [],
    relay_countries: Array.isArray(data.relay_countries) ? data.relay_countries.filter(Boolean) : [],
    learned_from: data.learned_from || '',
    error: data.error || '',
  };
}

export function loadBridgeCache() {
  try {
    const raw = window.localStorage.getItem(BRIDGE_CACHE_KEY);
    if (!raw) return { relayCatalog: new Map(), relayInfoCatalog: new Map() };
    const payload = JSON.parse(raw);
    const relayCatalog = new Map();
    const relayInfoCatalog = new Map();

    if (Array.isArray(payload.relayCatalog)) {
      for (const entry of payload.relayCatalog) {
        if (!entry?.owner || !Array.isArray(entry.relays)) continue;
        relayCatalog.set(entry.owner, {
          owner: entry.owner,
          event_id: entry.event_id || '',
          kind: entry.kind ?? 0,
          relays: [...new Set(entry.relays.map((relay) => normalizeRelayUrl(relay)).filter(Boolean))],
          updated_at: entry.updated_at || Date.now(),
        });
      }
    }

    if (Array.isArray(payload.relayInfoCatalog)) {
      for (const [url, info] of payload.relayInfoCatalog) {
        const normalized = normalizeRelayUrl(url);
        if (!normalized || !info) continue;
        relayInfoCatalog.set(normalized, createNostrRelay(normalized, info));
      }
    }

    return { relayCatalog, relayInfoCatalog };
  } catch {
    return { relayCatalog: new Map(), relayInfoCatalog: new Map() };
  }
}

export function sourceForRelay(relay, relayCatalog) {
  for (const entry of relayCatalog.values()) {
    if ((entry.relays || []).includes(relay)) return entry.event_id || entry.owner || 'unknown';
  }
  return '';
}

export function nip11FetchUrl(relayUrl) {
  const normalized = normalizeRelayUrl(relayUrl);
  if (!normalized) return null;
  const parsed = new URL(normalized);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  return parsed.toString().replace(/\/$/, '');
}

export function nip11ProxyUrl(relayUrl) {
  const normalized = normalizeRelayUrl(relayUrl);
  if (!normalized) return null;
  const url = new URL('/nip11', window.location.href);
  url.searchParams.set('relay', normalized);
  return url.toString();
}

export async function fetchRelayInfo(relayUrl) {
  const normalized = normalizeRelayUrl(relayUrl);
  if (!normalized) return null;
  const cache = loadBridgeCache();
  const cached = cache.relayInfoCatalog.get(normalized);
  if (cached && cached.ping_ms !== null && cached.ping_fetched_at && !cached.error) return cached;
  if (cached && !cached.error) {
    const pingMs = await measureRelayPing(normalized);
    const record = createNostrRelay(normalized, {
      ...cached,
      ping_ms: pingMs,
      ping_fetched_at: pingMs === null ? cached.ping_fetched_at || 0 : Date.now(),
      ping_error: pingMs === null ? (cached.ping_error || 'unreachable') : '',
    });
    cache.relayInfoCatalog.set(normalized, record);
    try {
      const db = await getDagDb();
      await db.setRelayInfo(normalized, record);
    } catch {
      // best effort only
    }
    try {
      const payload = {
        relayCatalog: [...cache.relayCatalog.values()],
        relayInfoCatalog: [...cache.relayInfoCatalog.entries()],
      };
      window.localStorage.setItem(BRIDGE_CACHE_KEY, JSON.stringify(payload));
    } catch {
      // best effort only
    }
    return record;
  }

  const candidates = [nip11ProxyUrl(normalized), nip11FetchUrl(normalized)].filter(Boolean);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        method: 'GET',
        cache: 'no-store',
        headers: { Accept: 'application/nostr+json' },
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}\n${raw}`);
      const data = JSON.parse(raw || '{}');
      const pingMs = await measureRelayPing(normalized);
      const record = createNostrRelay(normalized, {
        ...data,
        fetch_url: candidate,
        fetched_at: Date.now(),
        ping_ms: pingMs,
        ping_fetched_at: pingMs === null ? 0 : Date.now(),
        ping_error: pingMs === null ? 'unreachable' : '',
      });
      cache.relayInfoCatalog.set(normalized, record);
      try {
        const db = await getDagDb();
        await db.setRelayInfo(normalized, record);
      } catch {
        // best effort only
      }
      try {
        const payload = {
          relayCatalog: [...cache.relayCatalog.values()],
          relayInfoCatalog: [...cache.relayInfoCatalog.entries()],
        };
        window.localStorage.setItem(BRIDGE_CACHE_KEY, JSON.stringify(payload));
      } catch {
        // best effort only
      }
      return record;
    } catch (error) {
      lastError = error;
    }
  }

  return createNostrRelay(normalized, {
    fetch_url: nip11FetchUrl(normalized),
    fetched_at: Date.now(),
    ping_error: lastError?.message || 'unable to fetch NIP-11',
    error: lastError?.message || 'unable to fetch NIP-11',
  });
}
