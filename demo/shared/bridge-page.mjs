// Bridge page logic extracted from demo/bridge/index.html.
import { SimplePool } from 'https://esm.sh/nostr-tools@2.10.4/pool';
    import { verifyEvent } from 'https://esm.sh/nostr-tools@2.10.4/pure';
    import { createLoggerFooter } from './logger-footer.js';
    import { createSharedHeader } from './page-header.mjs';
    import { resolveHref } from './page-path.js';
    import { createSharedLibp2pStack } from './libp2p-stack.mjs';

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const CACHE_KEY = 'nostr-dag-bridge-cache-v1';
    const DEFAULT_RELAYS = [
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.nostr.com',
      'wss://relay.nostr.band',
      'wss://relay.primal.net',
      'wss://nostr.wine',
    ];

    if (!window.__bridgeChromeInitialized) {
      createSharedHeader(document.getElementById('sharedHeader'), {
        title: 'nostr-dag',
        logoHref: resolveHref('../', window.location.href),
        iconHref: resolveHref('../shared/favicon.ico', window.location.href),
        subtitleHtml: '',
        navItems: [
          { label: 'Demo', href: resolveHref('../', window.location.href) },
          { label: 'Git viewer', href: resolveHref('../git/', window.location.href) },
          { label: 'Bridge', href: resolveHref('./', window.location.href), current: true },
        ],
      });
      window.__bridgeChromeInitialized = true;
    }

    const pool = new SimplePool();
    const seen = new Set();
    const relayCatalog = new Map();
    const relayInfoCatalog = new Map();
    const relayInfoInFlight = new Map();
    const relayDiscoveryQueue = new Set();
    const relayDiscoverySeen = new Set();
    let relayDiscoveryRunning = false;
    let relayCachePersistTimer = null;
    let relayRenderScheduled = false;
    let rawEventLogCount = 0;
    let rawEventLogSuppressed = false;
    const metrics = {
      nostrToLibp2p: 0,
      libp2pToNostr: 0,
      relayPublishes: 0,
    };

    const bridgeStatusEl = document.getElementById('bridgeStatus');
    const topicInputEl = document.getElementById('topicInput');
    const relayInputEl = document.getElementById('relayInput');
    const nostrToLibp2pCountEl = document.getElementById('nostrToLibp2pCount');
    const libp2pToNostrCountEl = document.getElementById('libp2pToNostrCount');
    const seenCountEl = document.getElementById('seenCount');
    const relayPublishCountEl = document.getElementById('relayPublishCount');
    const defaultRelayCountEl = document.getElementById('defaultRelayCount');
    const defaultRelayListEl = document.getElementById('defaultRelayList');
    const relayCountEl = document.getElementById('relayCount');
    const relayListEl = document.getElementById('relayList');
    const peerCountEl = document.getElementById('peerCount');
    const peerListEl = document.getElementById('peerList');

    let node = null;
    let topic = topicInputEl.value.trim();
    let relays = DEFAULT_RELAYS.slice();
    let started = false;
    let peerPollTimer = null;
    const localPeers = new Map();
    const remotePeers = new Map();

    const sharedFooterLogBuffer = window.__sharedFooterLogBuffer || [];
    window.__sharedFooterLogBuffer = sharedFooterLogBuffer;
    if (!window.__sharedFooter) {
      window.__sharedFooter = createLoggerFooter(document.getElementById('sharedFooter'), {
        title: 'Logger',
        initialState: 'idle',
        initialTitle: 'bridge starting...',
        initialLevel: 'trace',
        maxEntries: 5000,
      });
    }
    while (sharedFooterLogBuffer.length) {
      const [label, text, levelOrState, maybeState] = sharedFooterLogBuffer.shift();
      window.__sharedFooter.log(label, text, levelOrState, maybeState);
    }

    function setStatus(text, state = 'checking') {
      bridgeStatusEl.className = `status status-${state}`;
      bridgeStatusEl.innerHTML = `<span class="status-dot"></span><span></span>`;
      bridgeStatusEl.querySelector('span:last-child').textContent = text;
      window.__sharedFooter?.log('bridge', text, state === 'available' ? 'info' : state, state);
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function refreshMetrics() {
      nostrToLibp2pCountEl.textContent = String(metrics.nostrToLibp2p);
      libp2pToNostrCountEl.textContent = String(metrics.libp2pToNostr);
      seenCountEl.textContent = String(seen.size);
      relayPublishCountEl.textContent = String(metrics.relayPublishes);
    }

    function scheduleRelayRenders() {
      if (relayRenderScheduled) return;
      relayRenderScheduled = true;
      const run = () => {
        relayRenderScheduled = false;
        renderDefaultRelays();
        renderRelays();
        renderPeers();
      };
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(run);
      } else {
        window.setTimeout(run, 0);
      }
    }

    function scheduleRelayCachePersist() {
      if (relayCachePersistTimer) return;
      relayCachePersistTimer = window.setTimeout(() => {
        relayCachePersistTimer = null;
        void persistRelayCache();
      }, 750);
    }

    function relayRowHtml(relay, info, source, loading) {
      const hasInfo = Boolean(info && !info.error);
      const fields = hasInfo ? [
        info.name || '',
        info.description || '',
        info.version ? `v${info.version}` : '',
      ].filter(Boolean) : [];
      return `
        <details class="bridge-card bridge-relay-card">
          <summary class="bridge-card-summary">
            <div class="bridge-relay-row">
              <div class="bridge-relay-url mono">
                <div>${escapeHtml(relay)}</div>
                ${hasInfo ? `<div class="small muted" style="margin-top:4px;">${escapeHtml(fields.join(' · '))}</div>` : loading ? '<div class="small muted" style="margin-top:4px;">Loading NIP-11…</div>' : ''}
              </div>
              <div class="bridge-relay-meta">
                ${source ? `<span class="bridge-pill">${escapeHtml(source)}</span>` : ''}
                ${info?.error ? `<span class="bridge-pill">NIP-11 unavailable</span>` : hasInfo ? '<span class="bridge-pill bridge-pill-ok" aria-label="NIP-11 loaded"><span class="bridge-pill-dot" aria-hidden="true"></span></span>' : loading ? '<span class="bridge-pill">NIP-11 loading</span>' : ''}
              </div>
            </div>
          </summary>
          <div class="bridge-relay-details">
          ${info?.error ? `
            <div class="small muted">NIP-11 fetch failed: ${escapeHtml(info.error)}</div>
          ` : hasInfo ? `
            <div class="small muted" style="margin-bottom:6px;">
              ${info.name ? `<b>${escapeHtml(info.name)}</b>` : 'unnamed relay'}
              ${info.version ? ` · v${escapeHtml(info.version)}` : ''}
            </div>
            ${info.description ? `<div class="small muted">${escapeHtml(info.description)}</div>` : ''}
            <div class="bridge-relay-grid" style="margin-top:8px;">
              ${info.pubkey ? `<span class="bridge-pill bridge-pill-relay">pubkey ${escapeHtml(info.pubkey)}</span>` : ''}
              ${info.contact ? `<span class="bridge-pill bridge-pill-relay">${escapeHtml(info.contact)}</span>` : ''}
              ${info.software ? `<span class="bridge-pill bridge-pill-relay">${escapeHtml(info.software)}</span>` : ''}
              ${info.icon ? `<span class="bridge-pill bridge-pill-relay">icon</span>` : ''}
              ${info.negentropy ? '<span class="bridge-pill bridge-pill-relay">negentropy</span>' : ''}
              ${typeof info.limitation?.auth_required === 'boolean' ? `<span class="bridge-pill bridge-pill-relay">${info.limitation.auth_required ? 'auth required' : 'no auth'}</span>` : ''}
              ${typeof info.limitation?.payment_required === 'boolean' ? `<span class="bridge-pill bridge-pill-relay">${info.limitation.payment_required ? 'payment required' : 'free'}</span>` : ''}
            </div>
            <div class="bridge-relay-grid" style="margin-top:8px;">
              ${Array.isArray(info.supported_nips) && info.supported_nips.length
                ? info.supported_nips.map((nip) => `<span class="bridge-pill bridge-pill-relay">NIP-${escapeHtml(nip)}</span>`).join('')
                : '<span class="bridge-pill">supported_nips unknown</span>'}
            </div>
            ${Array.isArray(info.relay_countries) && info.relay_countries.length ? `
              <div class="bridge-relay-grid" style="margin-top:8px;">
                ${info.relay_countries.map((country) => `<span class="bridge-pill bridge-pill-relay">${escapeHtml(country)}</span>`).join('')}
              </div>
            ` : ''}
          ` : loading ? `
            <div class="small muted">Loading NIP-11 metadata…</div>
          ` : `
            <div class="small muted">NIP-11 metadata not loaded yet.</div>
          `}
          </div>
        </details>
      `;
    }

    function logRawNostrEvent(prefix, event) {
      if (rawEventLogCount >= 25) {
        if (!rawEventLogSuppressed) {
          rawEventLogSuppressed = true;
          window.__sharedFooter?.log('bridge', 'raw relay event logging suppressed after 25 entries', 'trace', 'available');
        }
        return;
      }
      rawEventLogCount += 1;
      window.__sharedFooter?.log('bridge', `${prefix} ${JSON.stringify(event)}`, 'trace', 'available');
    }

    function relayInfoForUrl(url) {
      return relayInfoCatalog.get(normalizeRelayUrl(url) || url) || null;
    }

    function relayInfoForUrls(urls) {
      return [...new Set(urls.map((url) => normalizeRelayUrl(url) || url))]
        .map((url) => relayInfoForUrl(url))
        .filter(Boolean);
    }

    async function persistRelayCache() {
      try {
        const payload = {
          relayCatalog: [...relayCatalog.values()],
          relayInfoCatalog: [...relayInfoCatalog.entries()],
        };
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
        window.__sharedFooter?.log('bridge', 'bridge relay cache persisted', 'trace', 'available');
      } catch {
        window.__sharedFooter?.log('bridge', 'bridge relay cache persist failed', 'warn', 'unavailable');
      }
    }

    async function restoreRelayCache() {
      try {
        const raw = window.localStorage.getItem(CACHE_KEY);
        if (!raw) {
          window.__sharedFooter?.log('bridge', 'no cached bridge relays found', 'debug', 'idle');
          return false;
        }
        const payload = JSON.parse(raw);
        if (Array.isArray(payload.relayCatalog)) {
          relayCatalog.clear();
          for (let i = 0; i < payload.relayCatalog.length; i += 1) {
            const entry = payload.relayCatalog[i];
            if (!entry?.owner || !Array.isArray(entry.relays)) continue;
            relayCatalog.set(entry.owner, {
              owner: entry.owner,
              kind: entry.kind ?? 0,
              relays: [...new Set(entry.relays.map((relay) => normalizeRelayUrl(relay)).filter(Boolean))],
              updated_at: entry.updated_at || Date.now(),
            });
            if (i % 10 === 9) await Promise.resolve();
          }
        }
        if (Array.isArray(payload.relayInfoCatalog)) {
          relayInfoCatalog.clear();
          for (let i = 0; i < payload.relayInfoCatalog.length; i += 1) {
            const [url, info] = payload.relayInfoCatalog[i] || [];
            const normalized = normalizeRelayUrl(url);
            if (!normalized || !info) continue;
            relayInfoCatalog.set(normalized, createNostrRelay(normalized, info));
            if (i % 10 === 9) await Promise.resolve();
          }
        }
        window.__sharedFooter?.log('bridge', 'restored cached bridge relays', 'info', 'available');
        return true;
      } catch {
        window.__sharedFooter?.log('bridge', 'failed to restore cached bridge relays', 'warn', 'unavailable');
        return false;
      }
    }

    function createNostrRelay(relayUrl, data = {}) {
      const url = normalizeRelayUrl(relayUrl) || String(relayUrl || '').trim();
      const limitation = data.limitation && typeof data.limitation === 'object' ? data.limitation : {};
      return {
        url,
        fetch_url: data.fetch_url || '',
        fetched_at: data.fetched_at || 0,
        name: data.name || '',
        description: data.description || '',
        pubkey: data.pubkey || '',
        contact: data.contact || '',
        software: data.software || '',
        version: data.version || '',
        icon: data.icon || '',
        negentropy: Boolean(data.negentropy),
        supported_nips: Array.isArray(data.supported_nips)
          ? data.supported_nips.filter((nip) => Number.isFinite(Number(nip))).map((nip) => Number(nip))
          : [],
        limitation: {
          max_limit: limitation.max_limit ?? null,
          max_message_length: limitation.max_message_length ?? null,
          max_subscriptions: limitation.max_subscriptions ?? null,
          max_filters: limitation.max_filters ?? null,
          max_event_tags: limitation.max_event_tags ?? null,
          max_content_length: limitation.max_content_length ?? null,
          min_pow_difficulty: limitation.min_pow_difficulty ?? null,
          auth_required: Boolean(limitation.auth_required),
          payment_required: Boolean(limitation.payment_required),
        },
        relay_countries: Array.isArray(data.relay_countries) ? data.relay_countries.filter(Boolean) : [],
        learned_from: data.learned_from || '',
        error: data.error || '',
      };
    }

    function nip11FetchUrl(relayUrl) {
      const normalized = normalizeRelayUrl(relayUrl);
      if (!normalized) return null;
      const parsed = new URL(normalized);
      if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
      if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
      return parsed.toString().replace(/\/$/, '');
    }

    function nip11ProxyUrl(relayUrl) {
      const normalized = normalizeRelayUrl(relayUrl);
      if (!normalized) return null;
      const url = new URL('/nip11', window.location.href);
      url.searchParams.set('relay', normalized);
      return url.toString();
    }

    async function fetchRelayInfo(relayUrl) {
      const normalized = normalizeRelayUrl(relayUrl);
      const fetchUrl = nip11FetchUrl(relayUrl);
      const proxyUrl = nip11ProxyUrl(relayUrl);
      if (!normalized) return null;
      if (relayInfoCatalog.has(normalized)) return relayInfoCatalog.get(normalized);
      if (relayInfoInFlight.has(normalized)) return relayInfoInFlight.get(normalized);
      window.__sharedFooter?.log('bridge', `fetch nip11 ${normalized}`, 'trace', 'checking');

      const request = (async () => {
        try {
          const candidates = [proxyUrl, fetchUrl].filter(Boolean);
          let lastError = null;
          for (const candidate of candidates) {
            try {
              window.__sharedFooter?.log('bridge', `query relay ${normalized} via ${candidate}`, 'trace', 'checking');
              const response = await fetch(candidate, {
                method: 'GET',
                cache: 'no-store',
                headers: { Accept: 'application/nostr+json' },
              });
              const raw = await response.text();
              window.__sharedFooter?.log('bridge', `nip11 raw ${normalized} via ${candidate}\n${raw}`, 'trace', response.ok ? 'available' : 'unavailable');
              if (!response.ok) throw new Error(`${response.status} ${response.statusText}\n${raw}`);
              const data = JSON.parse(raw || '{}');
              const record = createNostrRelay(normalized, {
                ...data,
                fetch_url: candidate,
                fetched_at: Date.now(),
              });
              relayInfoCatalog.set(normalized, record);
              window.__sharedFooter?.log('bridge', `fetch nip11 ${normalized} ok ${record.name || record.version || 'loaded'}`, 'trace', 'available');
              return record;
            } catch (error) {
              lastError = error;
            }
          }
          throw lastError || new Error('unable to fetch NIP-11');
        } catch (error) {
          const record = createNostrRelay(normalized, {
            fetch_url: fetchUrl,
            fetched_at: Date.now(),
            error: error?.message || String(error),
          });
          relayInfoCatalog.set(normalized, record);
          window.__sharedFooter?.log('bridge', `fetch nip11 ${normalized} failed ${record.error}`, 'trace', 'unavailable');
          return record;
        } finally {
          relayInfoInFlight.delete(normalized);
        }
      })();

      relayInfoInFlight.set(normalized, request);
      return request;
    }

    function refreshRelayInfo(relayUrls) {
      const urls = prioritizeRelayUrls(relayUrls || currentRelayUrls());
      if (!urls.length) return;
      window.__sharedFooter?.log('bridge', `refresh nip11 for ${urls.length} relays`, 'trace', 'checking');
      void (async () => {
        for (const url of urls) {
          await fetchRelayInfo(url);
          scheduleRelayRenders();
          await Promise.resolve();
        }
      })();
    }

    function renderDefaultRelays() {
      const entries = [...DEFAULT_RELAYS].sort();
      defaultRelayCountEl.textContent = String(entries.length);
      window.__sharedFooter?.log('bridge', `render default relays (${entries.length})`, 'trace', 'checking');
      defaultRelayListEl.innerHTML = entries.map((relay) => {
        const info = relayInfoForUrl(relay);
        const loading = relayInfoInFlight.has(normalizeRelayUrl(relay) || relay);
        return relayRowHtml(relay, info, 'default', loading);
      }).join('');
    }

    function renderRelays() {
      const learnedRelays = [...new Set([...relayCatalog.values()].flatMap((entry) => entry.relays || []))].sort();
      const visibleRelays = learnedRelays.filter((relay) => {
        const info = relayInfoForUrl(relay);
        return Boolean(info && !info.error);
      });
      relayCountEl.textContent = String(visibleRelays.length);
      window.__sharedFooter?.log('bridge', `render accumulated relays (${visibleRelays.length})`, 'trace', 'checking');
      if (!visibleRelays.length) {
        relayListEl.innerHTML = '<div class="small muted">No relays with loaded NIP-11 yet.</div>';
        return;
      }

      const learned = new Map([...relayCatalog.values()].flatMap((entry) => (entry.relays || []).map((relay) => [relay, entry])));
      relayListEl.innerHTML = visibleRelays.map((relay) => {
        const source = learned.get(relay);
        const info = relayInfoForUrl(relay);
        const sourceLabel = source ? `learned from ${source.owner || 'unknown'}` : 'learned';
        return relayRowHtml(relay, info, sourceLabel, false);
      }).join('');
    }

    // Keep one merged peer registry in the browser so the bridge works on Pages and localhost.
    function upsertPeer(source, peer) {
      if (!peer?.peer_id) return;
      const key = `${source}:${peer.path || '/'}:${peer.peer_id}:${peer.kind || 'unknown'}`;
      const record = {
        ...peer,
        source: peer.source || source,
        updated_at: peer.updated_at || Date.now(),
      };
      if (source === 'browser') {
        localPeers.set(key, record);
      } else {
        remotePeers.set(key, record);
      }
    }

    function allPeers() {
      return [...localPeers.values(), ...remotePeers.values()].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    }

    function renderPeers() {
      const peers = allPeers();
      peerCountEl.textContent = String(peers.length);
      if (!peers.length) {
        peerListEl.innerHTML = '<div class="small muted">No peers reported yet.</div>';
        return;
      }
      window.__sharedFooter?.log('bridge', `render peers (${peers.length})`, 'trace', 'checking');
      const openPeerIds = [...peerListEl.querySelectorAll('details[open][data-peer-id]')]
        .map((el) => el.getAttribute('data-peer-id'))
        .filter(Boolean);
      const relaysNow = currentRelayUrls();
      peerListEl.innerHTML = peers.map((peer) => `
        <details class="bridge-card bridge-peer" data-peer-id="${escapeHtml(peer.peer_id)}">
          <summary class="bridge-card-summary">
            <div class="bridge-peer-head">
              <div class="bridge-peer-title mono">${escapeHtml(peer.peer_id)}</div>
              <div class="bridge-peer-meta">
                <span class="bridge-pill">${escapeHtml(peer.kind || 'unknown')}</span>
                <span class="bridge-pill">${escapeHtml(peer.path || '/')}</span>
                <span class="bridge-pill">${escapeHtml(new Date(peer.updated_at || Date.now()).toLocaleTimeString())}</span>
                <span class="bridge-pill bridge-pill-source">${escapeHtml(peer.source || 'browser')}</span>
              </div>
            </div>
          </summary>
          <div class="bridge-peer-relays">
            <div class="bridge-peer-relays-label">Relays</div>
            <div class="bridge-relay-grid">
              ${(peer.relays && peer.relays.length ? peer.relays : relaysNow).length
                ? (peer.relays && peer.relays.length ? peer.relays : relaysNow)
                    .map((relay) => `<span class="bridge-pill bridge-pill-relay">${escapeHtml(relay)}</span>`).join('')
                : '<span class="bridge-pill">none</span>'}
            </div>
          </div>
          <div class="bridge-peer-detail mono">${peer.detail ? escapeHtml(formatPeerDetail(peer.detail)) : 'no detail'}</div>
        </details>
      `).join('');
      for (const peerId of openPeerIds) {
        const card = peerListEl.querySelector(`details[data-peer-id="${CSS.escape(peerId)}"]`);
        if (card) card.open = true;
      }
    }

    // Poll the local preview server when available. Pages deployments just render browser peers.
    async function pollPeers() {
      try {
        const response = await fetch('/peers', { cache: 'no-store' });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const peers = await response.json();
        remotePeers.clear();
        for (const peer of Array.isArray(peers) ? peers : []) {
          upsertPeer('localhost', peer);
        }
        renderPeers();
      } catch (e) {
        renderPeers();
      }
    }

    function parseRelays(value) {
      return value
        .split(/\s+/)
        .map((line) => line.trim())
        .filter(Boolean);
    }

    function currentRelayUrls() {
      return [...new Set([
        ...parseRelays(relayInputEl.value),
        ...[...relayCatalog.values()].flatMap((entry) => entry.relays || []),
      ])];
    }

    function prioritizeRelayUrls(relayUrls) {
      const normalized = [...new Set(relayUrls.map((url) => normalizeRelayUrl(url)).filter(Boolean))];
      normalized.sort((a, b) => {
        if (a === 'wss://nos.lol') return -1;
        if (b === 'wss://nos.lol') return 1;
        return a.localeCompare(b);
      });
      return normalized;
    }

    function scheduleRelayDiscovery(relayUrls = currentRelayUrls()) {
      const urls = prioritizeRelayUrls(relayUrls);
      let added = false;
      for (const url of urls) {
        if (relayDiscoverySeen.has(url) || relayDiscoveryQueue.has(url)) continue;
        relayDiscoveryQueue.add(url);
        added = true;
      }
      if (added) {
        window.__sharedFooter?.log('bridge', `queue relay discovery (${urls.length})`, 'trace', 'checking');
        void processRelayDiscoveryQueue();
      }
    }

    async function processRelayDiscoveryQueue() {
      if (relayDiscoveryRunning) return;
      relayDiscoveryRunning = true;
      try {
        while (relayDiscoveryQueue.size) {
          const batch = [...relayDiscoveryQueue];
          relayDiscoveryQueue.clear();
          const relaysToQuery = batch.filter((url) => !relayDiscoverySeen.has(url));
          if (!relaysToQuery.length) continue;

          for (const relay of relaysToQuery) {
            relayDiscoverySeen.add(relay);
          }

          window.__sharedFooter?.log('bridge', `discover relays from ${relaysToQuery.length} known relays`, 'trace', 'checking');
          window.__sharedFooter?.log('bridge', `subscribe relay discovery batch (generic dump): ${relaysToQuery.join(', ')}`, 'trace', 'checking');
          for (const relay of relaysToQuery) {
            window.__sharedFooter?.log('bridge', `query known relay ${relay}`, 'trace', 'checking');
          }
          pool.subscribeMany(relaysToQuery, [{ limit: 200 }], {
            onevent(event) {
              logRawNostrEvent('discovery event raw', event);
              recordRelayInfo(event);
            },
            oneose() {},
          });

          await Promise.resolve();
        }
      } finally {
        relayDiscoveryRunning = false;
      }
    }

    function kindTopic(event) {
      return `${topic}/${event.kind}`;
    }

    function collectRelayUrls(value, found = new Set()) {
      if (typeof value === 'string') {
        const normalized = normalizeRelayUrl(value);
        if (normalized) found.add(normalized);
        return found;
      }
      if (Array.isArray(value)) {
        for (const item of value) collectRelayUrls(item, found);
        return found;
      }
      if (value && typeof value === 'object') {
        for (const item of Object.values(value)) collectRelayUrls(item, found);
      }
      return found;
    }

    function collectRelayUrlsFromTags(tags, found = new Set()) {
      if (!Array.isArray(tags)) return found;
      for (const tag of tags) {
        if (!Array.isArray(tag) || tag[0] !== 'r' || !tag[1]) continue;
        const normalized = normalizeRelayUrl(tag[1]);
        if (normalized) found.add(normalized);
      }
      return found;
    }

    function normalizeRelayUrl(url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'wss:') return null;
        return parsed.toString().replace(/\/$/, '');
      } catch {
        return null;
      }
    }

    function recordRelayInfo(event) {
      if (!event?.pubkey) return;
      const urls = extractRelayUrlsFromEvent(event);
      if (!urls.size) return;
      window.__sharedFooter?.log('bridge', `accumulate ${urls.size} relays from kind ${event.kind} ${event.pubkey}`, 'trace', 'checking');
      relayCatalog.set(event.pubkey, {
        owner: event.pubkey,
        kind: event.kind,
        relays: [...urls],
        updated_at: Date.now(),
      });
      window.__sharedFooter?.log('bridge', `relay catalog size ${relayCatalog.size}`, 'trace', 'available');
      scheduleRelayRenders();
      scheduleRelayCachePersist();
      scheduleRelayDiscovery([...urls]);
      void refreshRelayInfo([...urls]);
    }

    function extractRelayUrlsFromEvent(event) {
      const urls = new Set();
      if (!event || typeof event !== 'object') return urls;
      collectRelayUrlsFromTags(event.tags || [], urls);
      collectRelayUrls(event.tags || [], urls);
      if (typeof event.content === 'string') {
        try {
          collectRelayUrls(JSON.parse(event.content || '{}'), urls);
        } catch {
          collectRelayUrls(event.content, urls);
        }
      } else {
        collectRelayUrls(event.content, urls);
      }
      for (const value of Object.values(event)) {
        if (value === event.tags || value === event.content) continue;
        collectRelayUrls(value, urls);
      }
      return urls;
    }

    function formatPeerDetail(detail) {
      if (detail == null) return 'no detail';
      if (typeof detail === 'string') return detail;
      if (Array.isArray(detail)) return detail.map((item) => formatPeerDetail(item)).join(', ');
      const scalarText = (value) => {
        if (value == null) return '';
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        if (typeof value?.toString === 'function') {
          const text = value.toString();
          if (text && text !== '[object Object]') return text;
        }
        if (value?.bytes instanceof Uint8Array) {
          return [...value.bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        }
        if (value?.multihash?.bytes instanceof Uint8Array) {
          return [...value.multihash.bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        }
        return '';
      };
      const parseKeyValueString = (text) => {
        const entries = [];
        for (const token of String(text).split(/\s+/)) {
          const [key, ...rest] = token.split('=');
          if (!key || !rest.length) continue;
          entries.push([key, rest.join('=')]);
        }
        return entries;
      };
      const entriesToText = (entries) => entries
        .flatMap(([key, value]) => {
          if (value == null || value === '') return [];
          if (key === 'keys') {
            return [`keys:`, ...String(value).split(',').filter(Boolean).map((item) => `  - ${item}`)];
          }
          return [`${key}: ${value}`];
        })
        .join('\n');
      if (typeof detail === 'object') {
        const fields = [];
        if (scalarText(detail.peerId)) fields.push(['peerId', scalarText(detail.peerId)]);
        if (scalarText(detail.remotePeer)) fields.push(['remotePeer', scalarText(detail.remotePeer)]);
        if (detail.connection?.stat?.direction) fields.push(['direction', detail.connection.stat.direction]);
        if (scalarText(detail.connection?.remoteAddr)) fields.push(['remoteAddr', scalarText(detail.connection.remoteAddr)]);
        if (scalarText(detail.id)) fields.push(['id', scalarText(detail.id)]);
        if (detail.multiaddrs?.length) fields.push(['multiaddrs', detail.multiaddrs.map((addr) => scalarText(addr) || String(addr)).join(' | ')]);
        if (detail.type) fields.push(['type', detail.type]);
        if (scalarText(detail.multihash)) fields.push(['multihash', scalarText(detail.multihash)]);
        if (scalarText(detail.publicKey)) fields.push(['publicKey', scalarText(detail.publicKey)]);
        if (detail.keys && Array.isArray(detail.keys)) fields.push(['keys', detail.keys.join(',')]);
        if (detail.keys && !Array.isArray(detail.keys) && typeof detail.keys === 'string') fields.push(['keys', detail.keys]);
        return fields.length ? entriesToText(fields) : JSON.stringify(detail, null, 2);
      }
      const parsed = parseKeyValueString(detail);
      return parsed.length ? entriesToText(parsed) : String(detail);
    }

    function markSeen(event) {
      if (!event?.id || seen.has(event.id)) return false;
      seen.add(event.id);
      refreshMetrics();
      return true;
    }

    async function publishToLibp2p(event, direction) {
      if (!node) return;
      const payload = {
        source: 'nostr-dag-bridge',
        direction,
        topic: kindTopic(event),
        event,
        ts: Date.now(),
      };
      await node.services.pubsub.publish(topic, encoder.encode(JSON.stringify(payload)));
      metrics.nostrToLibp2p += direction === 'nostr->libp2p' ? 1 : 0;
      refreshMetrics();
      window.__sharedFooter?.log('bridge', `${direction} ${event.kind} ${event.id}`, 'trace', 'available');
    }

    async function publishToRelays(event, direction) {
      if (!relays.length) {
        throw new Error('no relays configured');
      }
      const publishTargets = relays.map((relay) => pool.publish([relay], event));
      const result = await Promise.any(publishTargets);
      metrics.relayPublishes += 1;
      metrics.libp2pToNostr += direction === 'libp2p->nostr' ? 1 : 0;
      refreshMetrics();
      window.__sharedFooter?.log('bridge', `${direction} ${event.kind} ${event.id}`, 'info', 'available');
      return result;
    }

    async function handleNostrEvent(event, source = 'relay') {
      if (!event || typeof event !== 'object' || !event.id) return;
      if (!verifyEvent(event)) {
        window.__sharedFooter?.log('bridge', `rejected invalid event ${event.id}`, 'warn', 'unavailable');
        return;
      }
      if (!markSeen(event)) {
        window.__sharedFooter?.log('bridge', `deduped ${event.id}`, 'trace', 'available');
        return;
      }
      if (event.kind === 10002 || event.kind === 3) {
        recordRelayInfo(event);
        scheduleRelayRenders();
      }
      window.__sharedFooter?.log('nostr', `${source} kind ${event.kind} ${event.id} by ${event.pubkey}`, 'trace', 'checking');
      try {
        await publishToLibp2p(event, 'nostr->libp2p');
      } catch (e) {
        window.__sharedFooter?.log('bridge', `libp2p publish failed: ${e.message}`, 'error', 'unavailable');
      }
    }

    async function handleLibp2pMessage(event) {
      if (!event || typeof event !== 'object' || !event.id) return;
      if (!verifyEvent(event)) {
        window.__sharedFooter?.log('bridge', `rejected libp2p payload ${event.id}`, 'warn', 'unavailable');
        return;
      }
      if (!markSeen(event)) return;
      try {
        await publishToRelays(event, 'libp2p->nostr');
      } catch (e) {
        window.__sharedFooter?.log('bridge', `relay publish failed: ${e.message}`, 'error', 'unavailable');
      }
    }

    // Start with the strongest transport set and fall back until libp2p accepts the browser runtime.
    async function startBridge() {
      if (started) return;
      started = true;
      relays = parseRelays(relayInputEl.value);
      topic = topicInputEl.value.trim() || 'nostr/bridge';

      setStatus('starting libp2p node', 'checking');
      try {
        const configs = [
          // Prefer hole punching-capable transports first.
          { includeWebRTC: true, includeWebRTCDirect: true, includeCircuitRelay: true },
          { includeWebRTC: true, includeWebRTCDirect: false, includeCircuitRelay: true },
          { includeWebRTC: true, includeWebRTCDirect: false, includeCircuitRelay: false },
          // Final fallback: a plain browser node that still can report peers and join pubsub.
          { includeWebRTC: false, includeWebRTCDirect: false, includeCircuitRelay: false },
        ];

        let lastError = null;
        for (const config of configs) {
          try {
            const stack = await createSharedLibp2pStack({
              ...config,
              onLog(level, text, state) {
                window.__sharedFooter?.log('libp2p', text, level, state);
              },
              onPeer(peer) {
                window.__sharedFooter?.log('libp2p', `${peer.kind} ${peer.peer}`, 'trace', 'checking');
                upsertPeer('browser', {
                  peer_id: peer.peer,
                  kind: peer.kind,
                  path: window.location.pathname || '/',
                  detail: peer.detail,
                  source: 'browser',
                  relays: currentRelayUrls(),
                  relay_info: [...relayCatalog.values()],
                  updated_at: Date.now(),
                });
                renderPeers();
              },
              onStatus(state, peerId) {
                setStatus(`${state} ${peerId}`, state === 'started' ? 'available' : 'checking');
              },
            });
            node = stack.node;
            window.__sharedFooter?.log('bridge', `bridge p2p config ok: ${JSON.stringify(config)}`, 'debug', 'available');
            lastError = null;
            break;
          } catch (e) {
            lastError = e;
            window.__sharedFooter?.log('bridge', `p2p config failed: ${JSON.stringify(config)} (${e.message})`, 'warn', 'unavailable');
          }
        }

        if (!node) {
          throw lastError || new Error('unable to start libp2p');
        }

        await node.services.pubsub.subscribe(topic);
        window.__sharedFooter?.log('bridge', `subscribed libp2p pubsub ${topic}`, 'trace', 'available');
        node.services.pubsub.addEventListener('message', (evt) => {
          const payload = evt.detail?.data;
          try {
            const message = JSON.parse(decoder.decode(payload));
            if (message?.event?.id) {
              void handleLibp2pMessage(message.event);
            }
          } catch {
            window.__sharedFooter?.log('bridge', 'ignored malformed pubsub payload', 'warn', 'unavailable');
          }
        });

        const relaysSnapshot = prioritizeRelayUrls([...DEFAULT_RELAYS, ...currentRelayUrls()]);
        window.__sharedFooter?.log('bridge', `subscribing Nostr relays: ${relaysSnapshot.join(', ')}`, 'trace', 'checking');
        pool.subscribeMany(relaysSnapshot, [{ limit: 500 }], {
          onevent(event) {
            logRawNostrEvent('relay event raw', event);
            void handleNostrEvent(event, 'relay');
          },
          oneose() {},
        });

        setStatus(`bridging ${relaysSnapshot.length} relays on ${topic}`, 'available');
        window.__sharedFooter?.log('bridge', `bridge ready on topic ${topic}`, 'info', 'available');
        for (const relay of relaysSnapshot) {
          window.__sharedFooter?.log('bridge', `query nostr relay ${relay}`, 'trace', 'checking');
        }
        void refreshRelayInfo(relaysSnapshot);
        scheduleRelayDiscovery(relaysSnapshot);
        await pollPeers();
        peerPollTimer = window.setInterval(() => {
          void pollPeers();
        }, 2000);
      } catch (e) {
        setStatus(`bridge failed: ${e.message}`, 'unavailable');
        window.__sharedFooter?.log('bridge', `bridge failed: ${e.message}`, 'error', 'unavailable');
      }
    }

    topicInputEl.addEventListener('change', () => {
      topic = topicInputEl.value.trim() || 'nostr/bridge';
      window.__sharedFooter?.log('bridge', `topic updated to ${topic}`, 'debug', 'checking');
    });

    relayInputEl.addEventListener('change', () => {
      relays = parseRelays(relayInputEl.value);
      scheduleRelayRenders();
      void refreshRelayInfo(relays);
      scheduleRelayDiscovery(relays);
      window.__sharedFooter?.log('bridge', `relay list updated (${relays.length})`, 'debug', 'checking');
    });

    scheduleRelayRenders();
    void restoreRelayCache().then(() => {
      scheduleRelayRenders();
      void refreshRelayInfo(currentRelayUrls());
      scheduleRelayDiscovery(currentRelayUrls());
    });
    scheduleRelayDiscovery(DEFAULT_RELAYS);
    scheduleRelayDiscovery(relays);
    void startBridge();
