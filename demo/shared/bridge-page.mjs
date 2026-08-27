// Bridge page logic extracted from demo/bridge/index.html.
import { SimplePool } from 'https://esm.sh/nostr-tools@2.10.4/pool';
    import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'https://esm.sh/nostr-tools@2.10.4/pure';
    import { scheduleAfterPaint, yieldToBrowser } from './async-lifecycle.mjs';
    import { createSharedHeader } from './page-header.mjs';
    import { resolveHref } from './page-path.js';
    import { measureRelayPing } from './relay-ping.mjs';
    import { createSharedLibp2pStack } from './libp2p-stack.mjs';
    import { getNetworkUnixTime, initSharedNetworkTime } from './network-time.mjs';
    import { createListContainerController } from './list-container.mjs';
    import { createPeersListController } from './peers-list.mjs';
    import { createRelaysListController } from './relays-list.mjs';
    // Persistent IndexedDB store for all Nostr events and relationships
    // seen by the bridge (events, tags, relays, users, DAG edges, peer acks).
    import { getDagDb } from './dag-db.mjs';

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const CACHE_KEY = 'nostr-dag-bridge-cache-v2';
    const SIGNER_KEY = 'nostr-dag-bridge-signer-v1';
    const BOOKMARKS_KEY = 'nostr-dag-bridge-bookmarks-v1';
    const RECENT_LIST_STATE_KEY = 'nostr-dag-bridge-recent-list-state-v1';
    const PANEL_STATE_KEY = 'nostr-dag-bridge-panel-state-v1';
    const BRIDGE_PROTOCOL = 'nostr-dag-bridge';
    const BRIDGE_PROTOCOL_VERSION = 1;
    const DEFAULT_RELAYS = [
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.nostr.com',
      'wss://relay.nostr.band',
      'wss://relay.primal.net',
      'wss://nostr.wine',
    ];

    if (!window.__bridgeChromeInitialized) {
      window.__sharedHeaderApi = createSharedHeader(document.getElementById('sharedHeader'), {
        title: 'nostr-dag',
        logoHref: resolveHref('../', window.location.href),
        iconHref: resolveHref('../shared/favicon.ico', window.location.href),
        subtitleHtml: '',
        navItems: [
          { label: 'Git viewer', href: resolveHref('../git/', window.location.href) },
          { label: 'Bridge', href: resolveHref('./', window.location.href), current: true },
        ],
      });
      window.__bridgeChromeInitialized = true;
    }
    const networkTime = initSharedNetworkTime();

    const pool = new SimplePool();
    const seenRelay = new Set();
    const seenLibp2p = new Set();
    const seenProcessed = new Set();
    const recentNostrToLibp2p = [];
    const recentLibp2pToNostr = [];
    const recentSeenRelay = [];
    const recentSeenLibp2p = [];
    const recentListState = new Map([
      ['nostrToLibp2p', { query: '', sort: 'newest', openIds: new Set(), paused: false }],
      ['libp2pToNostr', { query: '', sort: 'newest', openIds: new Set(), paused: false }],
      ['seenRelay', { query: '', sort: 'newest', openIds: new Set(), paused: false }],
      ['seenLibp2p', { query: '', sort: 'newest', openIds: new Set(), paused: false }],
    ]);
    const recentListControllers = new Map();
    const bookmarkedRecentRecords = loadRecentBookmarks();
    const bookmarkedRecentIds = new Set(bookmarkedRecentRecords.map((record) => record.id));
    const bookmarkedRecentSnapshots = new Map(bookmarkedRecentRecords.map((record) => [record.id, record]));
    const recentListStateSnapshot = loadRecentListState();
    const relayCatalog = new Map();
    const relayInfoCatalog = new Map();
    const relayInfoInFlight = new Map();
    const relayDiscoveryQueue = new Set();
    const relayDiscoverySeen = new Set();
    let relayDiscoveryRunning = false;
    let relayCachePersistTimer = null;
    let bridgePresenceTimer = null;
    let bridgeVerificationRunning = false;
    let defaultRelayRenderScheduled = false;
    let relayRenderScheduled = false;
    let peerRenderScheduled = false;
    let recentListsRenderScheduled = false;
    let rawEventLogCount = 0;
    let rawEventLogSuppressed = false;
    const metrics = {
      nostrToLibp2p: 0,
      libp2pToNostr: 0,
      relayPublishesAttempted: 0,
      relayPublishesSucceeded: 0,
    };

    const bridgeStatusEl = document.getElementById('bridgeStatus');
    const nostrToLibp2pCountEl = document.getElementById('nostrToLibp2pCount');
    const libp2pToNostrCountEl = document.getElementById('libp2pToNostrCount');
    const seenRelayCountEl = document.getElementById('seenRelayCount');
    const seenLibp2pCountEl = document.getElementById('seenLibp2pCount');
    const relayPublishCountEl = document.getElementById('relayPublishCount');
    const nostrToLibp2pDetailCountEl = document.getElementById('nostrToLibp2pDetailCount');
    const libp2pToNostrDetailCountEl = document.getElementById('libp2pToNostrDetailCount');
    const seenRelayDetailCountEl = document.getElementById('seenRelayDetailCount');
    const seenLibp2pDetailCountEl = document.getElementById('seenLibp2pDetailCount');
    const relayPublishDetailCountEl = document.getElementById('relayPublishDetailCount');
    const nostrToLibp2pRecentEl = document.getElementById('nostrToLibp2pRecent');
    const libp2pToNostrRecentEl = document.getElementById('libp2pToNostrRecent');
    const seenRelayRecentEl = document.getElementById('seenRelayRecent');
    const seenLibp2pRecentEl = document.getElementById('seenLibp2pRecent');
    const relayPublishDetailStatusEl = document.getElementById('relayPublishDetailStatus');
    const nostrToLibp2pEventDetailEl = document.getElementById('nostrToLibp2pEventDetail');
    const libp2pToNostrEventDetailEl = document.getElementById('libp2pToNostrEventDetail');
    const seenRelayEventDetailEl = document.getElementById('seenRelayEventDetail');
    const seenLibp2pEventDetailEl = document.getElementById('seenLibp2pEventDetail');
    const relayPublishEventDetailEl = document.getElementById('relayPublishEventDetail');
    const defaultRelayCountEl = document.getElementById('defaultRelayCount');
    const defaultRelayListEl = document.getElementById('defaultRelayList');
    const relayCountEl = document.getElementById('relayCount');
    const relayListEl = document.getElementById('relayList');
    const peerCountEl = document.getElementById('peerCount');
    const peerListEl = document.getElementById('peerList');
    const peerPanelEl = peerListEl?.closest?.('details.bridge-collapsible') || null;
    const relayPanelEl = relayListEl?.closest?.('details.bridge-collapsible') || null;
    const statPanelEls = [...document.querySelectorAll('details.bridge-stat[data-stat-key]')];

    [
      ['nostrToLibp2p', nostrToLibp2pRecentEl, recentNostrToLibp2p],
      ['libp2pToNostr', libp2pToNostrRecentEl, recentLibp2pToNostr],
      ['seenRelay', seenRelayRecentEl, recentSeenRelay],
      ['seenLibp2p', seenLibp2pRecentEl, recentSeenLibp2p],
    ].forEach(([key, container, items]) => {
      recentListControllers.set(key, createListContainerController({
        items,
        state: recentListState.get(key),
        scheduleRender: scheduleRecentListsRender,
        persistState: persistRecentListState,
        onChange: scheduleBridgeCachePersist,
        renderFn: () => renderRecentList(container, items, () => {}, key),
      }));
    });

    restoreRecentListUiState();
    restorePanelState();
    restoreStatPanelState();
    statPanelEls.forEach((panel) => panel.addEventListener('toggle', persistPanelState));
    peerPanelEl?.addEventListener('toggle', persistPanelState);
    relayPanelEl?.addEventListener('toggle', persistPanelState);
    renderRecentLists();
    syncRecentListPauseState();
    scheduleRecentListsRender();

    document.querySelectorAll('[data-list-search]').forEach((input) => {
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const key = input.getAttribute('data-list-search');
        if (!key || !recentListState.has(key)) return;
        recentListState.get(key).query = input.value || '';
        persistRecentListState();
        scheduleRecentListsRender();
      });
    });
    document.querySelectorAll('[data-list-sort]').forEach((select) => {
      select.addEventListener('change', () => {
        const key = select.getAttribute('data-list-sort');
        if (!key || !recentListState.has(key)) return;
        recentListState.get(key).sort = select.value || 'newest';
        persistRecentListState();
        scheduleRecentListsRender();
      });
    });

    let node = null;
    let topic = 'nostr/bridge';
    let relays = DEFAULT_RELAYS.slice();
    let started = false;
    let peerPollTimer = null;
    const localPeers = new Map();
    const remotePeers = new Map();
    const bridgeVerificationQueue = [];
    const bridgeVerificationSeen = new Map();
    const bridgeVerificationBackoff = new Map();

    const sharedFooterLogBuffer = window.__sharedFooterLogBuffer || [];
    window.__sharedFooterLogBuffer = sharedFooterLogBuffer;
    window.__flushSharedFooterLogBuffer = () => {
      if (!window.__sharedFooter) return;
      while (sharedFooterLogBuffer.length) {
        const [label, text, levelOrState, maybeState] = sharedFooterLogBuffer.shift();
        window.__sharedFooter.log(label, text, levelOrState, maybeState);
      }
    };
    window.__flushSharedFooterLogBuffer();

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
      seenRelayCountEl.textContent = String(seenRelay.size);
      seenLibp2pCountEl.textContent = String(seenLibp2p.size);
      relayPublishCountEl.textContent = `${metrics.relayPublishesSucceeded}/${metrics.relayPublishesAttempted}`;
      if (nostrToLibp2pDetailCountEl) nostrToLibp2pDetailCountEl.textContent = String(metrics.nostrToLibp2p);
      if (libp2pToNostrDetailCountEl) libp2pToNostrDetailCountEl.textContent = String(metrics.libp2pToNostr);
      if (seenRelayDetailCountEl) seenRelayDetailCountEl.textContent = String(seenRelay.size);
      if (seenLibp2pDetailCountEl) seenLibp2pDetailCountEl.textContent = String(seenLibp2p.size);
      if (relayPublishDetailCountEl) relayPublishDetailCountEl.textContent = `${metrics.relayPublishesSucceeded}/${metrics.relayPublishesAttempted}`;
      if (relayPublishDetailStatusEl) relayPublishDetailStatusEl.textContent = metrics.relayPublishesAttempted ? `${metrics.relayPublishesSucceeded} successful publishes` : 'No publish attempts yet.';
    }

    function pushRecent(key, list, value) {
      const controller = recentListControllers.get(key);
      if (controller) {
        controller.queue(value);
        return;
      }
      if (!value?.id) return;
      const index = list.findIndex((entry) => entry?.id === value.id);
      if (index !== -1) list.splice(index, 1);
      list.push(value);
      scheduleRecentListsRender();
    }

    function escapeJson(value) {
      return escapeHtml(JSON.stringify(value, null, 2));
    }

    function loadRecentBookmarks() {
      try {
        const raw = window.localStorage.getItem(BOOKMARKS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.flatMap((value) => {
          if (typeof value === 'string' && value) {
            return [{ id: value, event: null, source: '', updated_at: 0 }];
          }
          if (value && typeof value === 'object' && typeof value.id === 'string' && value.id) {
            return [{
              id: value.id,
              event: value.event && typeof value.event === 'object' ? value.event : null,
              source: typeof value.source === 'string' ? value.source : '',
              updated_at: Number(value.updated_at) || 0,
            }];
          }
          return [];
        });
      } catch {
        return [];
      }
    }

    function loadRecentListState() {
      try {
        const raw = window.localStorage.getItem(RECENT_LIST_STATE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    function persistRecentListState() {
      try {
        const snapshot = {};
        for (const [key, state] of recentListState.entries()) {
          snapshot[key] = {
            query: String(state.query || ''),
            sort: String(state.sort || 'newest'),
            open: [...(state.openIds || new Set())],
          };
        }
        window.localStorage.setItem(RECENT_LIST_STATE_KEY, JSON.stringify(snapshot));
      } catch {
        // best effort only
      }
    }

    function loadPanelState() {
      try {
        const raw = window.localStorage.getItem(PANEL_STATE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    function persistPanelState() {
      try {
        const openPeerKeys = [...peerListEl.querySelectorAll('details[open][data-peer-key]')]
          .map((el) => el.getAttribute('data-peer-key'))
          .filter(Boolean);
        const statPanels = {};
        statPanelEls.forEach((panel) => {
          const key = panel.getAttribute('data-stat-key');
          if (!key) return;
          statPanels[key] = Boolean(panel.open);
        });
        window.localStorage.setItem(PANEL_STATE_KEY, JSON.stringify({
          peersOpen: Boolean(peerPanelEl?.open),
          relaysOpen: Boolean(relayPanelEl?.open),
          openPeerKeys,
          statPanels,
        }));
      } catch {
        // best effort only
      }
    }

    function restorePanelState() {
      const snapshot = loadPanelState();
      if (peerPanelEl) peerPanelEl.open = Boolean(snapshot.peersOpen);
      if (relayPanelEl) relayPanelEl.open = Boolean(snapshot.relaysOpen);
    }

    function restoreStatPanelState() {
      const snapshot = loadPanelState();
      const statPanels = snapshot.statPanels && typeof snapshot.statPanels === 'object' ? snapshot.statPanels : {};
      statPanelEls.forEach((panel) => {
        const key = panel.getAttribute('data-stat-key');
        if (!key) return;
        if (Object.prototype.hasOwnProperty.call(statPanels, key)) {
          panel.open = Boolean(statPanels[key]);
        }
      });
    }

    function restoreRecentListUiState() {
      for (const [key, state] of recentListState.entries()) {
        const snapshot = recentListStateSnapshot[key];
        if (snapshot && typeof snapshot === 'object') {
          state.query = String(snapshot.query || '');
          state.sort = String(snapshot.sort || 'newest');
          state.openIds = new Set(Array.isArray(snapshot.open) ? snapshot.open.filter((value) => typeof value === 'string' && value) : []);
        }
        state.paused = false;
      }
      document.querySelectorAll('[data-list-search]').forEach((input) => {
        const key = input.getAttribute('data-list-search');
        if (!key || !recentListState.has(key)) return;
        input.value = recentListState.get(key).query || '';
      });
      document.querySelectorAll('[data-list-sort]').forEach((select) => {
        const key = select.getAttribute('data-list-sort');
        if (!key || !recentListState.has(key)) return;
        select.value = recentListState.get(key).sort || 'newest';
      });
    }

    function syncRecentListPauseState() {
      for (const state of recentListState.values()) {
        state.paused = state.openIds.size > 0;
      }
    }

    function persistRecentBookmarks() {
      try {
        const snapshot = [...bookmarkedRecentIds].map((id) => bookmarkedRecentSnapshots.get(id) || { id, event: null, source: '', updated_at: 0 });
        window.localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(snapshot));
      } catch {
        // best effort only
      }
    }

    function isRecentBookmarked(id) {
      return Boolean(id && bookmarkedRecentIds.has(id));
    }

    function getBookmarkedSnapshot(id) {
      return id ? bookmarkedRecentSnapshots.get(id) || null : null;
    }

    function bookmarkSnapshotFromItem(item) {
      if (!item?.id) return null;
      return {
        id: item.id,
        event: item.event && typeof item.event === 'object' ? item.event : null,
        source: typeof item.source === 'string' ? item.source : '',
        updated_at: Date.now(),
      };
    }

    function updateBookmarkButtons(id) {
      const bookmarked = isRecentBookmarked(id);
      document.querySelectorAll('[data-bookmark-id]').forEach((button) => {
        if (button.getAttribute('data-bookmark-id') !== id) return;
        button.textContent = bookmarked ? '★' : '☆';
        button.classList.toggle('is-bookmarked', bookmarked);
        button.setAttribute('aria-label', bookmarked ? 'Remove bookmark' : 'Bookmark item');
        button.setAttribute('title', bookmarked ? 'Remove bookmark' : 'Bookmark item');
      });
    }

    function toggleRecentBookmark(id, item = null) {
      if (!id) return;
      if (bookmarkedRecentIds.has(id)) {
        bookmarkedRecentIds.delete(id);
        bookmarkedRecentSnapshots.delete(id);
      } else {
        bookmarkedRecentIds.add(id);
        const snapshot = bookmarkSnapshotFromItem(item) || bookmarkedRecentSnapshots.get(id) || { id, event: null, source: '', updated_at: Date.now() };
        bookmarkedRecentSnapshots.set(id, snapshot);
      }
      persistRecentBookmarks();
      updateBookmarkButtons(id);
      scheduleRecentListsRender();
    }

    function scheduleRecentListsRender() {
      if (recentListsRenderScheduled) return;
      recentListsRenderScheduled = true;
      queueMicrotask(() => {
        recentListsRenderScheduled = false;
        renderRecentLists();
      });
    }

    function renderRecentList(container, items, onSelect, key) {
      if (!container) return;
      const state = recentListState.get(key);
      if (!state || state.paused) return;
      const openItems = state.openIds || new Set();
      const visibleItems = getRecentItems(key, items);
      if (!visibleItems.length) {
        const query = (recentListState.get(key)?.query || '').trim();
        container.innerHTML = `
          <div class="muted">${escapeHtml(query ? 'No matching events.' : 'No recent events yet.')}</div>
          <div class="small muted" style="margin-top:6px;">
            Press Enter to search. Try <span class="mono">kind:0</span>, <span class="mono">pubkey:…</span>, <span class="mono">id:…</span>, <span class="mono">source:…</span>, <span class="mono">ascn</span>, or <span class="mono">descn</span>.
          </div>
        `;
        return;
      }
      container.innerHTML = visibleItems.map((item) => {
        const label = item?.id || 'n/a';
        const suffix = item?.source ? ` · ${item.source}` : '';
        const createdAt = Number(item?.event?.created_at);
        const createdAtText = Number.isFinite(createdAt) ? String(Math.trunc(createdAt)) : '';
        const bookmarkedSnapshot = getBookmarkedSnapshot(item?.id);
        const event = item?.event || bookmarkedSnapshot?.event || {};
        return `
          <details class="bridge-recent-event"${item?.id && openItems.has(item.id) ? ' open' : ''}>
            <summary class="bridge-recent-summary">
              <span class="bridge-recent-summary-main">
                <span class="bridge-recent-summary-top">
                  <span class="mono">${escapeHtml(label)}</span>
                  <span class="muted">${escapeHtml(suffix)}</span>
                </span>
                <span class="bridge-recent-summary-bottom mono">${escapeHtml(createdAtText)}</span>
              </span>
              <button
                type="button"
                class="bridge-recent-bookmark${isRecentBookmarked(item?.id) ? ' is-bookmarked' : ''}"
                data-bookmark-id="${escapeHtml(item?.id || '')}"
                aria-label="${escapeHtml(isRecentBookmarked(item?.id) ? 'Remove bookmark' : 'Bookmark item')}"
                title="${escapeHtml(isRecentBookmarked(item?.id) ? 'Remove bookmark' : 'Bookmark item')}"
              >${isRecentBookmarked(item?.id) ? '★' : '☆'}</button>
            </summary>
            <div class="bridge-event-detail bridge-recent-detail">
              <div class="small muted" style="margin-bottom:8px;">${escapeHtml(event?.kind != null ? `kind ${event.kind}` : 'Nostr event')}</div>
              <div class="mono" style="margin-bottom:8px;">${escapeHtml(event?.id || 'n/a')}</div>
              <div class="small" style="margin-bottom:8px;">${escapeHtml(event?.pubkey || 'n/a')}</div>
              <div class="small muted" style="margin-bottom:8px;">${escapeHtml(createdAtText)}</div>
              <pre class="mono" style="margin:0;">${escapeJson(event || {})}</pre>
            </div>
          </details>
        `;
      }).join('');
      container.querySelectorAll('[data-bookmark-id]').forEach((button) => {
        const stop = (event) => {
          event.preventDefault();
          event.stopPropagation();
        };
        button.addEventListener('pointerdown', stop);
        button.addEventListener('mousedown', stop);
        button.addEventListener('click', (event) => {
          stop(event);
          const id = button.getAttribute('data-bookmark-id');
          const item = visibleItems.find((entry) => entry?.id === id) || null;
          toggleRecentBookmark(id, item);
        });
      });
      container.querySelectorAll('details.bridge-recent-event').forEach((details, index) => {
        details.addEventListener('toggle', () => {
          const item = visibleItems[index] || null;
          const state = recentListState.get(key);
          const controller = recentListControllers.get(key) || null;
          if (!item?.id) return;
          if (details.open) {
            state.openIds.clear();
            state.openIds.add(item.id);
            container.querySelectorAll('details.bridge-recent-event[open]').forEach((other) => {
              if (other !== details) other.open = false;
            });
            controller?.pause();
            persistRecentListState();
            onSelect(item);
            return;
          }
          state.openIds.delete(item.id);
          persistRecentListState();
          controller?.resume();
        });
      });
    }

    function renderRecentLists() {
      for (const controller of recentListControllers.values()) {
        controller.render();
      }
    }

    function bytesToHex(bytes) {
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    function hexToBytes(hex) {
      const clean = String(hex || '').trim();
      if (!clean || clean.length % 2 !== 0) return null;
      const out = new Uint8Array(clean.length / 2);
      for (let i = 0; i < out.length; i += 1) {
        const part = clean.slice(i * 2, i * 2 + 2);
        const value = Number.parseInt(part, 16);
        if (!Number.isFinite(value)) return null;
        out[i] = value;
      }
      return out;
    }

    function getBridgeSigner() {
      try {
        const raw = window.localStorage.getItem(SIGNER_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          const secretKey = hexToBytes(parsed?.secretKeyHex);
          if (secretKey) {
            return {
              secretKey,
              publicKey: parsed?.publicKey || getPublicKey(secretKey),
              created_at: parsed?.created_at || Date.now(),
            };
          }
        }
      } catch {
        // fall through and create a new signer
      }

      const secretKey = generateSecretKey();
      const signer = {
        secretKey,
        publicKey: getPublicKey(secretKey),
        created_at: Date.now(),
      };
      try {
        window.localStorage.setItem(SIGNER_KEY, JSON.stringify({
          secretKeyHex: bytesToHex(secretKey),
          publicKey: signer.publicKey,
          created_at: signer.created_at,
        }));
      } catch {
        // best effort only
      }
      return signer;
    }

    function isNostrEvent(value) {
      return Boolean(
        value &&
        typeof value === 'object' &&
        typeof value.id === 'string' &&
        typeof value.pubkey === 'string' &&
        typeof value.sig === 'string' &&
        typeof value.content === 'string' &&
        Array.isArray(value.tags) &&
        Number.isFinite(Number(value.kind)) &&
        Number.isFinite(Number(value.created_at))
      );
    }

    function collectBridgeRelayHints(value, found = new Set()) {
      if (!value) return found;
      if (typeof value === 'string') {
        const normalized = normalizeRelayUrl(value);
        if (normalized) found.add(normalized);
        return found;
      }
      if (Array.isArray(value)) {
        for (const item of value) collectBridgeRelayHints(item, found);
        return found;
      }
      if (typeof value === 'object') {
        for (const item of Object.values(value)) collectBridgeRelayHints(item, found);
      }
      return found;
    }

    // Perfect IP (PIP) bridge envelope:
    // - `protocol` and `version` identify the wire format
    // - `event` remains a standard Nostr event
    // - `relay_hints` carries deduplicated relay URLs for the Nostr publish path
    // See `/PIP.md` for the repository-level specification.
    function buildBridgeEnvelope(event, direction, relayHints = []) {
      return {
        protocol: BRIDGE_PROTOCOL,
        version: BRIDGE_PROTOCOL_VERSION,
        direction,
        event,
        relay_hints: [...new Set(relayHints.filter(Boolean))],
        topic,
        ts: Date.now(),
      };
    }

    function buildBridgePresenceEvent(relayHints = []) {
      const signer = getBridgeSigner();
      const publishRelays = prioritizeRelayUrls([
        ...collectBridgeRelayHints(relayHints),
        ...currentRelayUrls(),
        ...DEFAULT_RELAYS,
      ]);
      const payload = {
        name: 'nostr-dag bridge',
        display_name: 'nostr-dag bridge',
        about: `libp2p peer ${node?.peerId?.toString?.() || 'starting'} broadcasting to Nostr relays.`,
        bridge_peer_id: node?.peerId?.toString?.() || '',
        bridge_protocol: BRIDGE_PROTOCOL,
        bridge_topic: topic,
        bridge_relays: publishRelays,
        bridge_version: BRIDGE_PROTOCOL_VERSION,
        updated_at: new Date().toISOString(),
      };
      return finalizeEvent({
        kind: 0,
        created_at: getNetworkUnixTime(),
        tags: [
          ['t', 'nostr-dag'],
          ['t', 'bridge'],
        ],
        content: JSON.stringify(payload),
        pubkey: signer.publicKey,
      }, signer.secretKey);
    }

    // PIP decoders accept either a full bridge envelope or a raw Nostr event for compatibility.
    // When relay hints are present, they are normalized and forwarded to the Nostr publish path.
    function unwrapBridgeEnvelope(message) {
      if (!message || typeof message !== 'object') return null;
      if (isNostrEvent(message)) {
        return {
          event: message,
          relayHints: [],
          direction: 'libp2p->nostr',
        };
      }
      const protocol = message.protocol || message.source;
      const event = message.event || message.payload?.event || message.payload || null;
      const relayHints = [
        ...collectBridgeRelayHints(message.relay_hints),
        ...collectBridgeRelayHints(message.relayHints),
        ...collectBridgeRelayHints(message.relays),
        ...collectBridgeRelayHints(message.relayTargets),
      ];
      if (protocol && protocol !== BRIDGE_PROTOCOL && protocol !== 'nostr-dag-bridge') {
        return null;
      }
      if (!event || !isNostrEvent(event)) return null;
      return {
        event,
        relayHints,
        direction: message.direction || 'libp2p->nostr',
      };
    }

    function scheduleDefaultRelayRender() {
      if (defaultRelayRenderScheduled) return;
      defaultRelayRenderScheduled = true;
      const run = () => {
        renderDefaultRelays();
        defaultRelayRenderScheduled = false;
      };
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(run);
      } else {
        window.setTimeout(run, 0);
      }
    }

    function scheduleRelayRender() {
      if (relayRenderScheduled) return;
      relayRenderScheduled = true;
      const run = () => {
        renderRelays();
        relayRenderScheduled = false;
      };
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(run);
      } else {
        window.setTimeout(run, 0);
      }
    }

    function schedulePeerRender() {
      if (peerRenderScheduled) return;
      peerRenderScheduled = true;
      const run = () => {
        renderPeers();
        peerRenderScheduled = false;
      };
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(run);
      } else {
        window.setTimeout(run, 0);
      }
    }

    function scheduleBridgeCachePersist() {
      if (relayCachePersistTimer) return;
      relayCachePersistTimer = window.setTimeout(() => {
        relayCachePersistTimer = null;
        void persistBridgeCache();
      }, 750);
    }

    function scheduleBridgePresenceBroadcast(relayHints = currentRelayUrls()) {
      if (bridgePresenceTimer) clearTimeout(bridgePresenceTimer);
      bridgePresenceTimer = window.setTimeout(() => {
        bridgePresenceTimer = null;
        void broadcastBridgePresence(relayHints);
      }, 1000);
    }

    function verificationKey(eventId, relay) {
      return `${eventId}:${relay}`;
    }

    function verificationBlocked(key) {
      const until = bridgeVerificationBackoff.get(key);
      if (!until) return false;
      if (until > Date.now()) return true;
      bridgeVerificationBackoff.delete(key);
      return false;
    }

    function cacheVerification(eventId, relay, verified) {
      const key = verificationKey(eventId, relay);
      bridgeVerificationSeen.set(key, {
        verified,
        at: Date.now(),
      });
    }

    function scheduleBridgeVerification(event, relayHints = [], reason = 'publish') {
      if (!event?.id) return;
      const relaysToCheck = prioritizeRelayUrls([
        ...collectBridgeRelayHints(relayHints),
        ...currentRelayUrls(),
        ...DEFAULT_RELAYS,
      ]).slice(0, 2);
      for (const relay of relaysToCheck) {
        const key = verificationKey(event.id, relay);
        if (bridgeVerificationSeen.has(key) || verificationBlocked(key)) continue;
        bridgeVerificationQueue.push({ event, relay, reason });
        bridgeVerificationBackoff.set(key, Date.now() + 10_000);
      }
      void processBridgeVerificationQueue();
    }

    async function processBridgeVerificationQueue() {
      if (bridgeVerificationRunning) return;
      bridgeVerificationRunning = true;
      try {
        while (bridgeVerificationQueue.length) {
          const { event, relay, reason } = bridgeVerificationQueue.shift();
          const key = verificationKey(event.id, relay);
          if (bridgeVerificationSeen.has(key)) continue;

          window.__sharedFooter?.log('bridge', `verify ${reason} ${event.id} from ${relay}`, 'trace', 'checking');
          try {
            const verifiedEvents = await pool.querySync([relay], { ids: [event.id], limit: 1 }, { maxWait: 2000, label: 'bridge-verify' });
            const found = Array.isArray(verifiedEvents) && verifiedEvents.some((item) => item?.id === event.id);
            cacheVerification(event.id, relay, found);
            if (found) {
              window.__sharedFooter?.log('bridge', `verify ok ${event.id} from ${relay}`, 'info', 'available');
              // Record the verified relay association in IndexedDB.
              try {
                const db = await getDagDb();
                await db.upsertEventRelay(event.id, relay, true);
              } catch { /* non-fatal */ }
            } else {
              window.__sharedFooter?.log('bridge', `verify miss ${event.id} from ${relay}`, 'warn', 'checking');
            }
          } catch (error) {
            bridgeVerificationBackoff.set(key, Date.now() + 60_000);
            window.__sharedFooter?.log('bridge', `verify failed ${event.id} from ${relay}: ${error?.message || error}`, 'warn', 'unavailable');
          }

          await yieldToBrowser();
        }
      } finally {
        bridgeVerificationRunning = false;
      }
    }

    function supportsNip34GitKinds(info) {
      if (!info || typeof info !== 'object') return false;
      if (Array.isArray(info.supported_nips) && info.supported_nips.some((nip) => Number(nip) === 34)) return true;
      const supportedKinds = Array.isArray(info.supported_kinds) ? info.supported_kinds : [];
      return supportedKinds.some((kind) => [30617, 30618, 30619, 30620, 30621, 30622].includes(Number(kind)));
    }

    function relayRowHtml(relay, info, source, loading) {
      return relaysListController.relayRowHtml(relay, info, source, loading);
      const hasInfo = Boolean(info && !info.error);
      const gitCapable = hasInfo && supportsNip34GitKinds(info);
      const fields = hasInfo ? [
        info.name || '',
        info.description || '',
        info.version ? `v${info.version}` : '',
        Number.isFinite(Number(info.ping_ms)) ? `${Math.round(Number(info.ping_ms))} ms` : '',
      ].filter(Boolean) : [];
      const learnedFrom = source && source !== 'default'
        ? `<div class="bridge-relay-learned small muted">Learned from ${escapeHtml(source)}</div>`
        : '';
      const detailHref = resolveHref(`./relay.html?relay=${encodeURIComponent(relay)}`, window.location.href);
      return `
        <a class="bridge-card bridge-relay-card bridge-relay-link" href="${escapeHtml(detailHref)}">
          <div class="bridge-card-summary">
            <div class="bridge-relay-row">
              <div class="bridge-relay-url mono">
                <div>${escapeHtml(relay)}</div>
                ${hasInfo ? `<div class="small muted" style="margin-top:4px;">${escapeHtml(fields.join(' · '))}</div>` : loading ? '<div class="small muted" style="margin-top:4px;">Loading NIP-11…</div>' : ''}
              </div>
              <div class="bridge-relay-meta">
                ${gitCapable ? '<span class="bridge-pill bridge-pill-git" aria-label="Supports NIP-34 git kinds" title="Supports NIP-34 git kinds"><span aria-hidden="true">⎇</span></span>' : ''}
                ${info?.error ? `<span class="bridge-pill">NIP-11 unavailable</span>` : hasInfo ? '<span class="bridge-pill bridge-pill-ok" aria-label="NIP-11 loaded"><span class="bridge-pill-dot" aria-hidden="true"></span></span>' : loading ? '<span class="bridge-pill">NIP-11 loading</span>' : ''}
                ${Number.isFinite(Number(info?.ping_ms)) ? `<span class="bridge-pill bridge-pill-relay" title="Measured relay ping">${escapeHtml(`${Math.round(Number(info.ping_ms))} ms`)}</span>` : ''}
              </div>
            </div>
          </div>
          ${learnedFrom}
        </a>
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

    function relayPingSortValue(info) {
      const value = Number(info?.ping_ms);
      return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
    }

    function sortRelaysByPing(relays) {
      return [...relays].sort((a, b) => {
        const pingA = relayPingSortValue(relayInfoForUrl(a));
        const pingB = relayPingSortValue(relayInfoForUrl(b));
        if (pingA !== pingB) return pingA - pingB;
        return a.localeCompare(b);
      });
    }

    function measuredRelayCount(relays) {
      return relays.filter((relay) => relayPingSortValue(relayInfoForUrl(relay)) < Number.POSITIVE_INFINITY).length;
    }

    function normalizeText(value) {
      return String(value || '').toLowerCase();
    }

    function recentItemSearchText(item) {
      const event = item?.event || {};
      const tags = Array.isArray(event.tags) ? event.tags.flat().join(' ') : '';
      return [
        item?.id,
        item?.source,
        event?.id,
        event?.kind,
        event?.pubkey,
        event?.content,
        tags,
      ].map(normalizeText).join(' ');
    }

    function tokenizeRecentQuery(rawQuery) {
      const query = String(rawQuery || '').trim();
      if (!query) return [];
      return query.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    }

    function parseRecentQuery(rawQuery) {
      const tokens = tokenizeRecentQuery(rawQuery);
      const filters = [];
      let sort = null;
      for (const token of tokens) {
        const trimmed = token.trim();
        if (!trimmed) continue;
        const lower = trimmed.toLowerCase();
        if (['asc', 'ascn', 'newest', 'down'].includes(lower)) {
          sort = 'newest';
          continue;
        }
        if (['desc', 'descn', 'oldest', 'up'].includes(lower)) {
          sort = 'oldest';
          continue;
        }
        if (['kind', 'id'].includes(lower)) {
          sort = lower;
          continue;
        }
        const colonIndex = trimmed.indexOf(':');
        if (colonIndex === -1) {
          filters.push({ type: 'text', value: trimmed.replaceAll('"', '') });
          continue;
        }
        const field = trimmed.slice(0, colonIndex).toLowerCase();
        const value = trimmed.slice(colonIndex + 1).replaceAll('"', '').trim();
        if (!value) continue;
        if (field === 'kind') {
          filters.push({ type: 'kind', value });
          continue;
        }
        if (['id', 'pubkey', 'source', 'content', 'tag', 'relay', 'event'].includes(field)) {
          filters.push({ type: field, value });
          continue;
        }
        filters.push({ type: 'text', value: trimmed.replaceAll('"', '') });
      }
      return { filters, sort };
    }

    function recentItemFieldValue(item, field) {
      const event = item?.event || {};
      if (field === 'id' || field === 'event') return `${item?.id || ''} ${event?.id || ''}`;
      if (field === 'pubkey') return event?.pubkey || '';
      if (field === 'content') return event?.content || '';
      if (field === 'source') return item?.source || '';
      if (field === 'relay') return item?.relay || item?.source || '';
      if (field === 'tag') return Array.isArray(event.tags) ? event.tags.flat().join(' ') : '';
      if (field === 'kind') return String(event?.kind ?? '');
      return recentItemSearchText(item);
    }

    function matchesRecentItemQuery(item, filters) {
      if (!filters.length) return true;
      for (const filter of filters) {
        const haystack = normalizeText(recentItemFieldValue(item, filter.type));
        const needle = normalizeText(filter.value);
        if (!needle) continue;
        if (filter.type === 'kind') {
          if (haystack !== needle) return false;
          continue;
        }
        if (!haystack.includes(needle)) return false;
      }
      return true;
    }

    function compareRecentItems(a, b, sort) {
      const eventA = a?.event || {};
      const eventB = b?.event || {};
      const bookmarkedA = isRecentBookmarked(a?.id);
      const bookmarkedB = isRecentBookmarked(b?.id);
      if (bookmarkedA !== bookmarkedB) return bookmarkedA ? -1 : 1;
      if (sort === 'newest') return Number(eventB.created_at || 0) - Number(eventA.created_at || 0);
      if (sort === 'kind') return Number(eventA.kind || 0) - Number(eventB.kind || 0) || String(a?.id || '').localeCompare(String(b?.id || ''));
      if (sort === 'id') return String(a?.id || '').localeCompare(String(b?.id || ''));
      return Number(eventA.created_at || 0) - Number(eventB.created_at || 0) || String(a?.id || '').localeCompare(String(b?.id || ''));
    }

    function getRecentItems(key, items) {
      const state = recentListState.get(key) || { query: '', sort: 'newest' };
      const parsed = parseRecentQuery(state.query);
      const sort = parsed.sort || state.sort || 'newest';
      return [...items]
        .filter((item) => matchesRecentItemQuery(item, parsed.filters))
        .sort((a, b) => compareRecentItems(a, b, sort));
    }

    async function persistBridgeCache() {
      try {
        const payload = {
          relayCatalog: [...relayCatalog.values()],
          relayInfoCatalog: [...relayInfoCatalog.entries()],
          localPeers: [...localPeers.values()],
          remotePeers: [...remotePeers.values()],
          metrics: { ...metrics },
          seenRelayIds: [...seenRelay],
          seenLibp2pIds: [...seenLibp2p],
          recentNostrToLibp2p: recentNostrToLibp2p,
          recentLibp2pToNostr: recentLibp2pToNostr,
          recentSeenRelay: recentSeenRelay,
          recentSeenLibp2p: recentSeenLibp2p,
        };
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
        window.__sharedFooter?.log('bridge', 'bridge cache persisted', 'trace', 'available');
      } catch {
        window.__sharedFooter?.log('bridge', 'bridge cache persist failed', 'warn', 'unavailable');
      }
    }

    function restoreBridgeCache() {
      try {
        const raw = window.localStorage.getItem(CACHE_KEY);
        if (!raw) {
          window.__sharedFooter?.log('bridge', 'no cached bridge state found', 'debug', 'idle');
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
          }
        }
        if (Array.isArray(payload.relayInfoCatalog)) {
          relayInfoCatalog.clear();
          for (let i = 0; i < payload.relayInfoCatalog.length; i += 1) {
            const [url, info] = payload.relayInfoCatalog[i] || [];
            const normalized = normalizeRelayUrl(url);
            if (!normalized || !info) continue;
            relayInfoCatalog.set(normalized, createNostrRelay(normalized, info));
          }
        }
        if (Array.isArray(payload.localPeers)) {
          localPeers.clear();
          for (const peer of payload.localPeers) {
            if (!peer?.peer_id) continue;
            localPeers.set(peerKey(peer), peer);
          }
        }
        if (Array.isArray(payload.remotePeers)) {
          remotePeers.clear();
          for (const peer of payload.remotePeers) {
            if (!peer?.peer_id) continue;
            remotePeers.set(peerKey(peer), peer);
          }
        }
        if (payload.metrics && typeof payload.metrics === 'object') {
          metrics.nostrToLibp2p = Number(payload.metrics.nostrToLibp2p || 0);
          metrics.libp2pToNostr = Number(payload.metrics.libp2pToNostr || 0);
          metrics.relayPublishesAttempted = Number(payload.metrics.relayPublishesAttempted || 0);
          metrics.relayPublishesSucceeded = Number(payload.metrics.relayPublishesSucceeded || 0);
        }
        if (Array.isArray(payload.seenRelayIds)) {
          seenRelay.clear();
          for (const id of payload.seenRelayIds) {
            if (typeof id === 'string' && id) seenRelay.add(id);
          }
        }
        if (Array.isArray(payload.seenLibp2pIds)) {
          seenLibp2p.clear();
          for (const id of payload.seenLibp2pIds) {
            if (typeof id === 'string' && id) seenLibp2p.add(id);
          }
        }
        seenProcessed.clear();
        for (const id of seenRelay) seenProcessed.add(id);
        for (const id of seenLibp2p) seenProcessed.add(id);
        if (Array.isArray(payload.recentNostrToLibp2p)) {
          recentNostrToLibp2p.splice(0, recentNostrToLibp2p.length, ...payload.recentNostrToLibp2p.filter((item) => item && typeof item === 'object' && item.id));
        }
        if (Array.isArray(payload.recentLibp2pToNostr)) {
          recentLibp2pToNostr.splice(0, recentLibp2pToNostr.length, ...payload.recentLibp2pToNostr.filter((item) => item && typeof item === 'object' && item.id));
        }
        if (Array.isArray(payload.recentSeenRelay)) {
          recentSeenRelay.splice(0, recentSeenRelay.length, ...payload.recentSeenRelay.filter((item) => item && typeof item === 'object' && item.id));
        }
        if (Array.isArray(payload.recentSeenLibp2p)) {
          recentSeenLibp2p.splice(0, recentSeenLibp2p.length, ...payload.recentSeenLibp2p.filter((item) => item && typeof item === 'object' && item.id));
        }
        refreshMetrics();
        window.__sharedFooter?.log('bridge', `restored cached bridge state (${relayCatalog.size} relay groups, ${localPeers.size + remotePeers.size} peers)`, 'info', 'available');
        return true;
      } catch {
        window.__sharedFooter?.log('bridge', 'failed to restore cached bridge state', 'warn', 'unavailable');
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
      const cached = relayInfoCatalog.get(normalized) || null;
      if (cached && cached.ping_ms !== null && cached.ping_fetched_at && !cached.error) return cached;
      if (relayInfoInFlight.has(normalized)) return relayInfoInFlight.get(normalized);
      window.__sharedFooter?.log('bridge', `fetch nip11 ${normalized}`, 'trace', 'checking');

      const request = (async () => {
        try {
          if (cached && !cached.error) {
            const pingMs = cached.ping_ms !== null && cached.ping_fetched_at
              ? cached.ping_ms
              : await measureRelayPing(normalized);
            const record = createNostrRelay(normalized, {
              ...cached,
              ping_ms: pingMs,
              ping_fetched_at: pingMs === null ? cached.ping_fetched_at || 0 : Date.now(),
              ping_error: pingMs === null ? (cached.ping_error || 'unreachable') : '',
            });
            relayInfoCatalog.set(normalized, record);
            if (pingMs !== null) {
              try {
                const db = await getDagDb();
                await db.setRelayInfo(normalized, record);
              } catch {
                // best effort only
              }
            }
            return record;
          }

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
              const pingMs = await measureRelayPing(normalized);
              const record = createNostrRelay(normalized, {
                ...data,
                fetch_url: candidate,
                fetched_at: Date.now(),
                ping_ms: pingMs,
                ping_fetched_at: pingMs === null ? 0 : Date.now(),
                ping_error: pingMs === null ? 'unreachable' : '',
              });
              relayInfoCatalog.set(normalized, record);
              try {
                const db = await getDagDb();
                await db.setRelayInfo(normalized, record);
              } catch {
                // best effort only
              }
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
            ping_error: lastError?.message || 'unable to fetch NIP-11',
            error: error?.message || String(error),
          });
          relayInfoCatalog.set(normalized, record);
          try {
            const db = await getDagDb();
            await db.setRelayInfo(normalized, record);
          } catch {
            // best effort only
          }
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
          scheduleDefaultRelayRender();
          scheduleRelayRender();
          await yieldToBrowser();
        }
      })();
    }

    function renderDefaultRelays() {
      return relaysListController.renderDefaultRelays();
      const entries = sortRelaysByPing(DEFAULT_RELAYS).filter((relay) => relayPingSortValue(relayInfoForUrl(relay)) < Number.POSITIVE_INFINITY);
      defaultRelayCountEl.textContent = String(entries.length);
      window.__sharedFooter?.log('bridge', `render default relays (${entries.length})`, 'trace', 'checking');
      if (!entries.length) {
        defaultRelayListEl.innerHTML = '<div class="small muted">No relays have a measured ping yet.</div>';
        return;
      }
      defaultRelayListEl.innerHTML = entries.map((relay) => {
        const info = relayInfoForUrl(relay);
        const loading = relayInfoInFlight.has(normalizeRelayUrl(relay) || relay);
        return relayRowHtml(relay, info, 'default', loading);
      }).join('');
    }

    function renderRelays() {
      return relaysListController.renderRelays();
      const defaultRelays = sortRelaysByPing([...new Set(DEFAULT_RELAYS)]).filter((relay) => relayPingSortValue(relayInfoForUrl(relay)) < Number.POSITIVE_INFINITY);
      const learnedRelays = sortRelaysByPing([...new Set([...relayCatalog.values()].flatMap((entry) => entry.relays || []))]).filter((relay) => relayPingSortValue(relayInfoForUrl(relay)) < Number.POSITIVE_INFINITY);
      const visibleRelays = learnedRelays.filter((relay) => {
        const info = relayInfoForUrl(relay);
        return Boolean(info && !info.error && !defaultRelays.includes(relay) && Number(info.ping_ms) > 0);
      });
      const combinedRelays = sortRelaysByPing([...defaultRelays, ...visibleRelays]);
      relayCountEl.textContent = String(combinedRelays.length);
      window.__sharedFooter?.log('bridge', `render accumulated relays (${combinedRelays.length})`, 'trace', 'checking');
      if (!combinedRelays.length) {
        relayListEl.innerHTML = '<div class="small muted">No relays have a measured ping yet.</div>';
        return;
      }

      const learned = new Map([...relayCatalog.values()].flatMap((entry) => (entry.relays || []).map((relay) => [relay, entry])));
      relayListEl.innerHTML = combinedRelays.map((relay) => {
        const info = relayInfoForUrl(relay);
        const source = learned.get(relay);
        const loading = relayInfoInFlight.has(normalizeRelayUrl(relay) || relay);
        const sourceLabel = defaultRelays.includes(relay)
          ? 'default'
          : source
            ? (source.owner || 'unknown')
            : 'unknown';
        return relayRowHtml(relay, info, sourceLabel, loading);
      }).join('');
    }

    // Keep one merged peer registry in the browser so the bridge works on Pages and localhost.
    function peerKey(peer) {
      return peersListController.peerKey(peer);
      return `${peer.source || 'browser'}:${peer.path || '/'}:${peer.peer_id}:${peer.kind || 'unknown'}`;
    }

    function upsertPeer(source, peer) {
      return peersListController.upsertPeer(source, peer);
      if (!peer?.peer_id) return;
      const key = peerKey({
        source,
        path: peer.path || '/',
        peer_id: peer.peer_id,
        kind: peer.kind || 'unknown',
      });
      const record = {
        ...peer,
        source: peer.source || source,
        detail: sanitizePeerDetail(peer.detail),
        updated_at: peer.updated_at || Date.now(),
      };
      if (source === 'browser') {
        localPeers.set(key, record);
      } else {
        remotePeers.set(key, record);
      }
      scheduleBridgeCachePersist();
    }

    function allPeers() {
      return peersListController.allPeers();
      return [...localPeers.values(), ...remotePeers.values()].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    }

    function renderPeers() {
      return peersListController.renderPeers();
      const peers = allPeers();
      peerCountEl.textContent = String(peers.length);
      if (!peers.length) {
        peerListEl.innerHTML = '<div class="small muted">No peers reported yet.</div>';
        return;
      }
      window.__sharedFooter?.log('bridge', `render peers (${peers.length})`, 'trace', 'checking');
      const openPeerKeys = new Set([
        ...[...peerListEl.querySelectorAll('details[open][data-peer-key]')].map((el) => el.getAttribute('data-peer-key')).filter(Boolean),
        ...((loadPanelState().openPeerKeys || []).filter((value) => typeof value === 'string' && value)),
      ]);
      peerListEl.innerHTML = peers.map((peer) => `
        <details class="bridge-card bridge-peer" data-peer-key="${escapeHtml(peerKey(peer))}">
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
          <div class="bridge-peer-detail mono">${peer.detail ? escapeHtml(formatPeerDetail(peer.detail)) : 'no detail'}</div>
        </details>
      `).join('');
      for (const peerKeyValue of openPeerKeys) {
        for (const card of peerListEl.querySelectorAll('details[data-peer-key]')) {
          if (card.getAttribute('data-peer-key') === peerKeyValue) {
            card.open = true;
            break;
          }
        }
      }
      peerListEl.querySelectorAll('details[data-peer-key]').forEach((details) => {
        details.addEventListener('toggle', persistPanelState);
      });
      persistPanelState();
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
        schedulePeerRender();
      } catch (e) {
        schedulePeerRender();
      }
    }

    function currentRelayUrls() {
      return [...new Set([
        ...relays,
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

          await yieldToBrowser();
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
      return relaysListController.recordRelayInfo(event);
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
      scheduleRelayRender();
      scheduleBridgeCachePersist();
      scheduleRelayDiscovery([...urls]);
      scheduleBridgePresenceBroadcast([...urls]);
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

    function sanitizePeerDetail(detail) {
      try {
        const text = formatPeerDetail(detail);
        return text ? String(text) : 'no detail';
      } catch {
        return 'no detail';
      }
    }

    const peersListController = createPeersListController({
      peerListEl,
      peerCountEl,
      localPeers,
      remotePeers,
      loadPanelState,
      persistPanelState,
      scheduleBridgeCachePersist,
      formatPeerDetail,
      sanitizePeerDetail,
    });

    const relaysListController = createRelaysListController({
      defaultRelays: DEFAULT_RELAYS,
      relayCatalog,
      relayInfoInFlight,
      relayInfoForUrl,
      relayPingSortValue,
      sortRelaysByPing,
      relayListEl,
      relayCountEl,
      defaultRelayListEl,
      defaultRelayCountEl,
      normalizeRelayUrl,
      scheduleBridgeCachePersist,
      scheduleRelayDiscovery,
      scheduleBridgePresenceBroadcast,
      refreshRelayInfo,
      currentRelayUrls,
      prioritizeRelayUrls,
      yieldToBrowser,
      relayInfoCatalog,
      getDagDb,
      createNostrRelay,
      measureRelayPing,
      windowLog: (...args) => window.__sharedFooter?.log(...args),
    });

    function markSeen(source, event) {
      if (!event?.id) return false;
      const sourceSet = source === 'libp2p' ? seenLibp2p : seenRelay;
      sourceSet.add(event.id);
      const alreadyProcessed = seenProcessed.has(event.id);
      seenProcessed.add(event.id);
      pushRecent(source === 'libp2p' ? 'seenLibp2p' : 'seenRelay', source === 'libp2p' ? recentSeenLibp2p : recentSeenRelay, { id: event.id, source, event });
      refreshMetrics();
      scheduleBridgeCachePersist();
      return !alreadyProcessed;
    }

    async function publishToLibp2p(event, direction) {
      if (!node) {
        window.__sharedFooter?.log('bridge', `publishToLibp2p: node not ready, dropping ${direction} ${event.kind} ${event.id}`, 'warn', 'unavailable');
        return;
      }
      const payload = buildBridgeEnvelope(event, direction, currentRelayUrls());
      await node.services.pubsub.publish(topic, encoder.encode(JSON.stringify(payload)));
      metrics.nostrToLibp2p += direction === 'nostr->libp2p' ? 1 : 0;
      refreshMetrics();
      scheduleBridgeCachePersist();
      window.__sharedFooter?.log('bridge', `${direction} ${event.kind} ${event.id}`, 'trace', 'available');
    }

    async function publishToRelays(event, direction, relayHints = []) {
      const publishRelays = prioritizeRelayUrls([
        ...collectBridgeRelayHints(relayHints),
        ...currentRelayUrls(),
        ...DEFAULT_RELAYS,
      ]);
      if (!publishRelays.length) {
        throw new Error('no relays configured');
      }
      const publishTargets = publishRelays.map((relay) => pool.publish([relay], event));
      const results = await Promise.allSettled(publishTargets);
      const successes = results.filter((result) => result.status === 'fulfilled');
      const failures = results.filter((result) => result.status === 'rejected');
      metrics.relayPublishesAttempted += results.length;
      metrics.relayPublishesSucceeded += successes.length;
      refreshMetrics();
      scheduleBridgeCachePersist();
      window.__sharedFooter?.log('bridge', `${direction} ${event.kind} ${event.id} via ${publishRelays.join(', ')}`, 'info', 'available');
      window.__sharedFooter?.log('bridge', `publish responses ${event.id}: ${successes.length}/${results.length} ok`, failures.length ? 'warn' : 'info', failures.length ? 'checking' : 'available');
      scheduleBridgeVerification(event, publishRelays, direction);
      return successes[0]?.value || null;
    }

    async function broadcastBridgePresence(relayHints = currentRelayUrls()) {
      if (!node) return;
      const publishRelays = prioritizeRelayUrls([
        ...collectBridgeRelayHints(relayHints),
        ...currentRelayUrls(),
        ...DEFAULT_RELAYS,
      ]);
      if (!publishRelays.length) return;

      const event = buildBridgePresenceEvent(publishRelays);
      if (!verifyEvent(event)) {
        window.__sharedFooter?.log('bridge', 'bridge presence event failed verification', 'error', 'unavailable');
        return;
      }

      logRawNostrEvent('bridge presence raw', event);
      window.__sharedFooter?.log('bridge', `broadcast bridge presence ${event.id} to ${publishRelays.length} relays`, 'info', 'checking');
      const results = await Promise.allSettled(publishRelays.map(async (relay) => {
        window.__sharedFooter?.log('bridge', `presence publish request ${relay} ${event.id}`, 'trace', 'checking');
        const response = await pool.publish([relay], event);
        window.__sharedFooter?.log('bridge', `presence publish response ${relay} ${event.id}: ${response}`, 'info', 'available');
      }));
      const failed = results.filter((result) => result.status === 'rejected');
      metrics.relayPublishesAttempted += results.length;
      metrics.relayPublishesSucceeded += results.length - failed.length;
      refreshMetrics();
      scheduleBridgeCachePersist();
      if (failed.length) {
        for (const result of failed) {
          window.__sharedFooter?.log('bridge', `presence publish failed: ${result.reason?.message || result.reason || 'unknown error'}`, 'warn', 'unavailable');
        }
      }
      window.__sharedFooter?.log('bridge', `bridge presence broadcast complete (${results.length - failed.length}/${results.length})`, failed.length ? 'warn' : 'info', failed.length ? 'checking' : 'available');
      scheduleBridgeVerification(event, publishRelays, 'presence');
    }

    async function handleNostrEvent(event, source = 'relay', sourceRelay = null) {
      if (!event || typeof event !== 'object' || !event.id) return;
      if (!verifyEvent(event)) {
        window.__sharedFooter?.log('bridge', `rejected invalid event ${event.id}`, 'warn', 'unavailable');
        return;
      }
      if (!markSeen('relay', event)) {
        window.__sharedFooter?.log('bridge', `deduped ${event.id}`, 'trace', 'available');
        return;
      }
      if (event.kind === 10002 || event.kind === 3) {
        recordRelayInfo(event);
        scheduleRelayRender();
      }
      pushRecent('nostrToLibp2p', recentNostrToLibp2p, { id: event.id, source: sourceRelay || 'relay', event });
      window.__sharedFooter?.log('nostr', `${source} kind ${event.kind} ${event.id} by ${event.pubkey}`, 'trace', 'checking');
      // Persist every verified event and its relationships to IndexedDB.
      try {
        const db = await getDagDb();
        await db.upsertEvent(event, sourceRelay);
        if (sourceRelay) {
          await db.upsertEventRelay(event.id, sourceRelay, false);
        }
        // Mirror to the local server store when running on localhost.
        void db.syncEventToServer(event, sourceRelay);
      } catch (dbErr) {
        window.__sharedFooter?.log('bridge', `dag-db persist failed: ${dbErr.message}`, 'warn', 'unavailable');
      }
      try {
        await publishToLibp2p(event, 'nostr->libp2p');
      } catch (e) {
        window.__sharedFooter?.log('bridge', `libp2p publish failed: ${e.message}`, 'error', 'unavailable');
      }
    }

    async function handleLibp2pMessage(message) {
      const envelope = unwrapBridgeEnvelope(message);
      if (!envelope) {
        window.__sharedFooter?.log('bridge', 'rejected libp2p payload with unsupported protocol', 'warn', 'unavailable');
        return;
      }
      const { event, relayHints, direction } = envelope;
      if (!markSeen('libp2p', event)) return;
      if (!verifyEvent(event)) {
        window.__sharedFooter?.log('bridge', `rejected libp2p payload ${event.id}`, 'warn', 'unavailable');
        return;
      }
      window.__sharedFooter?.log('bridge', `libp2p→nostr ${direction} ${event.kind} ${event.id}`, 'trace', 'checking');
      pushRecent('libp2pToNostr', recentLibp2pToNostr, { id: event.id, source: relayHints?.[0] || 'libp2p', event });
      metrics.libp2pToNostr += 1;
      refreshMetrics();
      // Persist event from libp2p, recording all relay hints as known sources.
      try {
        const db = await getDagDb();
        const firstRelay = relayHints?.[0] ?? null;
        await db.upsertEvent(event, firstRelay);
        if (Array.isArray(relayHints)) {
          for (const relay of relayHints) {
            await db.upsertEventRelay(event.id, relay, false);
          }
        }
        void db.syncEventToServer(event, firstRelay);
      } catch (dbErr) {
        window.__sharedFooter?.log('bridge', `dag-db persist (libp2p) failed: ${dbErr.message}`, 'warn', 'unavailable');
      }
      try {
        await publishToRelays(event, 'libp2p->nostr', relayHints);
      } catch (e) {
        window.__sharedFooter?.log('bridge', `relay publish failed: ${e.message}`, 'error', 'unavailable');
      }
    }

    // Start with the strongest transport set and fall back until libp2p accepts the browser runtime.
    async function startBridge() {
      if (started) return;
      started = true;
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
                schedulePeerRender();
              },
              onStatus(state, peerId) {
                setStatus(`${state} ${peerId}`, state === 'started' ? 'available' : 'checking');
              },
            });
            node = stack.node;
            networkTime.attachNode(node);
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
            void handleLibp2pMessage(message);
          } catch {
            window.__sharedFooter?.log('bridge', 'ignored malformed pubsub payload', 'warn', 'unavailable');
          }
        });

        const relaysSnapshot = prioritizeRelayUrls([...DEFAULT_RELAYS, ...currentRelayUrls()]);
        window.__sharedFooter?.log('bridge', `subscribing Nostr relays: ${relaysSnapshot.join(', ')}`, 'trace', 'checking');
        pool.subscribeMany(relaysSnapshot, [{ limit: 500 }], {
          onevent(event) {
            logRawNostrEvent('relay event raw', event);
            // sourceRelay is unavailable from SimplePool's onevent callback;
            // pass null and let upsertEventRelay be called when a relay is
            // known (e.g. from the relay_hints in a libp2p envelope).
            void handleNostrEvent(event, 'relay', null);
          },
          oneose() {},
        });

        const measuredCount = measuredRelayCount(relaysSnapshot);
        const statusCount = measuredCount > 0 ? `${measuredCount} measured` : `${relaysSnapshot.length} known`;
        setStatus(`bridging ${statusCount} relays on ${topic}`, 'available');
        window.__sharedFooter?.log('bridge', `bridge ready on topic ${topic}`, 'info', 'available');
        window.__sharedFooter?.log('bridge', `relay snapshot known=${relaysSnapshot.length} measured=${measuredCount}`, 'debug', 'available');
        for (const relay of relaysSnapshot) {
          window.__sharedFooter?.log('bridge', `query nostr relay ${relay}`, 'trace', 'checking');
        }
        void refreshRelayInfo(relaysSnapshot);
        scheduleRelayDiscovery(relaysSnapshot);
        scheduleBridgePresenceBroadcast(relaysSnapshot);
        void pollPeers();
        peerPollTimer = window.setInterval(() => {
          void pollPeers();
        }, 2000);
      } catch (e) {
        setStatus(`bridge failed: ${e.message}`, 'unavailable');
        window.__sharedFooter?.log('bridge', `bridge failed: ${e.message}`, 'error', 'unavailable');
      }
    }

    const bootBridge = async () => {
      refreshMetrics();
      restoreBridgeCache();
      renderRecentLists();
      scheduleRelayDiscovery(DEFAULT_RELAYS);
      scheduleRelayDiscovery(relays);
      scheduleDefaultRelayRender();
      scheduleRelayRender();
      schedulePeerRender();
      void refreshRelayInfo(DEFAULT_RELAYS);
      void refreshRelayInfo(currentRelayUrls());
      scheduleRelayDiscovery(currentRelayUrls());
      scheduleBridgePresenceBroadcast(currentRelayUrls());
      // Yield once before network startup so cached relay data can paint first
      // and regressions in bridge boot are easier to detect.
      await yieldToBrowser();
      void startBridge();
    };

    // Keep page-interactive rendering ahead of bridge startup by waiting until
    // after first paint before running bootBridge().
    scheduleAfterPaint(() => {
      void bootBridge();
    });
