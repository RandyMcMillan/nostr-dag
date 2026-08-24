// Bridge page logic extracted from demo/bridge/index.html.
import { SimplePool } from 'https://esm.sh/nostr-tools@2.10.4/pool';
    import { verifyEvent } from 'https://esm.sh/nostr-tools@2.10.4/pure';
    import { createLoggerFooter } from './logger-footer.js';
    import { createSharedHeader } from './page-header.mjs';
    import { resolveHref } from './page-path.js';
    import { createSharedLibp2pStack } from './libp2p-stack.mjs';

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const DEFAULT_RELAYS = [
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.nostr.com',
      'wss://relay.nostr.band',
      'wss://relay.primal.net',
      'wss://nostr.wine',
    ];

    createSharedHeader(document.getElementById('sharedHeader'), {
      title: 'nostr-dag',
      logoHref: resolveHref('../', window.location.href),
      iconHref: resolveHref('./favicon.ico', window.location.href),
      subtitleHtml: '',
      navItems: [
        { label: 'Demo', href: resolveHref('../', window.location.href) },
        { label: 'Git viewer', href: resolveHref('../git/', window.location.href) },
        { label: 'Bridge', href: resolveHref('./', window.location.href), current: true },
      ],
    });

    const pool = new SimplePool();
    const seen = new Set();
    const relayCatalog = new Map();
    const relayInfoCatalog = new Map();
    const relayInfoInFlight = new Map();
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
    window.__sharedFooter = createLoggerFooter(document.getElementById('sharedFooter'), {
      title: 'Logger',
      initialState: 'idle',
      initialTitle: 'bridge starting...',
      initialLevel: 'trace',
      maxEntries: 5000,
    });
    window.__sharedFooter.setLevel('trace');
    while (sharedFooterLogBuffer.length) {
      const [label, text, levelOrState, maybeState] = sharedFooterLogBuffer.shift();
      window.__sharedFooter.log(label, text, levelOrState, maybeState);
    }

    function setStatus(text, state = 'checking') {
      bridgeStatusEl.className = `status status-${state}`;
      bridgeStatusEl.innerHTML = `<span class="status-dot"></span><span>${text}</span>`;
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

    function relayInfoForUrl(url) {
      return relayInfoCatalog.get(normalizeRelayUrl(url) || url) || null;
    }

    function relayInfoForUrls(urls) {
      return [...new Set(urls.map((url) => normalizeRelayUrl(url) || url))]
        .map((url) => relayInfoForUrl(url))
        .filter(Boolean);
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

      const request = (async () => {
        try {
          const candidates = [proxyUrl, fetchUrl].filter(Boolean);
          let lastError = null;
          for (const candidate of candidates) {
            try {
              const response = await fetch(candidate, {
                method: 'GET',
                cache: 'no-store',
                headers: { Accept: 'application/nostr+json' },
              });
              if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
              const data = await response.json();
              const record = createNostrRelay(normalized, {
                ...data,
                fetch_url: candidate,
                fetched_at: Date.now(),
              });
              relayInfoCatalog.set(normalized, record);
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
          return record;
        } finally {
          relayInfoInFlight.delete(normalized);
        }
      })();

      relayInfoInFlight.set(normalized, request);
      return request;
    }

    async function refreshRelayInfo(relayUrls) {
      const urls = [...new Set((relayUrls || currentRelayUrls()).map((url) => normalizeRelayUrl(url)).filter(Boolean))];
      if (!urls.length) return;
      await Promise.allSettled(urls.map((url) => fetchRelayInfo(url)));
      renderRelays();
      renderPeers();
    }

    function renderRelays() {
      const entries = [...new Set([
        ...parseRelays(relayInputEl.value),
        ...[...relayCatalog.values()].flatMap((entry) => entry.relays || []),
      ])].sort();

      relayCountEl.textContent = String(entries.length);
      if (!entries.length) {
        relayListEl.innerHTML = '<div class="small muted">No relays configured.</div>';
        return;
      }

      const learned = new Map([...relayCatalog.values()].flatMap((entry) => (entry.relays || []).map((relay) => [relay, entry])));
      relayListEl.innerHTML = entries.map((relay) => {
        const source = learned.get(relay);
        const info = relayInfoForUrl(relay);
        const loading = relayInfoInFlight.has(normalizeRelayUrl(relay) || relay);
        return `
          <div class="bridge-relay-row">
            <div class="bridge-relay-url mono">
              <div>${escapeHtml(relay)}</div>
              ${info ? `<div class="small muted" style="margin-top:4px;">${escapeHtml(info.name || info.description || info.version || 'NIP-11 document loaded')}</div>` : loading ? '<div class="small muted" style="margin-top:4px;">Loading NIP-11…</div>' : ''}
            </div>
            <div class="bridge-relay-meta">
              <span class="bridge-pill">${source ? `learned from ${escapeHtml(source.owner || 'unknown')}` : 'configured'}</span>
              ${source ? `<span class="bridge-pill bridge-pill-source">kind ${escapeHtml(source.kind || 'unknown')}</span>` : ''}
              ${info?.error ? `<span class="bridge-pill">NIP-11 unavailable</span>` : info ? `<span class="bridge-pill">NIP-11 loaded</span>` : loading ? '<span class="bridge-pill">NIP-11 loading</span>' : ''}
            </div>
          </div>
          <div class="bridge-relay-details">
            ${info?.error ? `
              <div class="small muted">NIP-11 fetch failed: ${escapeHtml(info.error)}</div>
            ` : info ? `
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
        `;
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
      const relaysNow = currentRelayUrls();
      peerListEl.innerHTML = peers.map((peer) => `
        <div class="bridge-peer">
          <div class="bridge-peer-head">
            <div class="bridge-peer-title mono">${escapeHtml(peer.peer_id)}</div>
            <div class="bridge-peer-meta">
              <span class="bridge-pill">${escapeHtml(peer.kind || 'unknown')}</span>
              <span class="bridge-pill">${escapeHtml(peer.path || '/')}</span>
              <span class="bridge-pill">${escapeHtml(new Date(peer.updated_at || Date.now()).toLocaleTimeString())}</span>
              <span class="bridge-pill bridge-pill-source">${escapeHtml(peer.source || 'browser')}</span>
            </div>
          </div>
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
        </div>
      `).join('');
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

    function normalizeRelayUrl(url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
        return parsed.toString().replace(/\/$/, '');
      } catch {
        return null;
      }
    }

    function recordRelayInfo(event) {
      if (!event?.pubkey) return;
      const urls = new Set();
      if (event.kind === 10002) {
        for (const tag of event.tags || []) {
          if (tag?.[0] === 'r' && tag?.[1]) collectRelayUrls(tag[1], urls);
        }
      } else if (event.kind === 3) {
        try {
          const legacy = typeof event.content === 'string' ? JSON.parse(event.content || '{}') : event.content || {};
          collectRelayUrls(legacy, urls);
        } catch {
          collectRelayUrls(event.content || '', urls);
        }
      }
      if (!urls.size) return;
      relayCatalog.set(event.pubkey, {
        owner: event.pubkey,
        kind: event.kind,
        relays: [...urls],
        updated_at: Date.now(),
      });
      void refreshRelayInfo([...urls]);
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
        renderRelays();
        renderPeers();
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

        const relaysSnapshot = relays.slice();
        pool.subscribeMany(relaysSnapshot, { kinds: [0, 1, 3, 10002, 21000], limit: 500 }, {
          onevent(event) {
            void handleNostrEvent(event, 'relay');
          },
          oneose() {},
        });

        setStatus(`bridging ${relaysSnapshot.length} relays on ${topic}`, 'available');
        window.__sharedFooter?.log('bridge', `bridge ready on topic ${topic}`, 'info', 'available');
        void refreshRelayInfo(relaysSnapshot);
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
      renderRelays();
      void refreshRelayInfo(relays);
      window.__sharedFooter?.log('bridge', `relay list updated (${relays.length})`, 'debug', 'checking');
    });

    renderRelays();
    void startBridge();
