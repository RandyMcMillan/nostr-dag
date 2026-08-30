// Bridge page logic extracted from demo/bridge/index.html.
import { SimplePool } from 'https://esm.sh/nostr-tools@2.10.4/pool';
    import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'https://esm.sh/nostr-tools@2.10.4/pure';
    import { scheduleAfterPaint, yieldToBrowser } from './async-lifecycle.mjs';
    import { bootstrapDemoPageChrome } from './page-shell.mjs';
    import { resolveHref } from './page-path.js';
    import { measureRelayPing } from './relay-ping.mjs';
    import { createSharedLibp2pStack, deterministicPeerIdFromSeed } from './libp2p-stack.mjs';
    import { getNetworkUnixTime } from './network-time.mjs';
    import { BRIDGE_PROTOCOL, BRIDGE_PROTOCOL_VERSION, buildBridgeEnvelope, collectBridgeRelayHints, decodeBridgeMessage } from './bridge-protocol.mjs';
    import { createListContainerController } from './list-container.mjs';
    import { createPeersListController } from './peers-list.mjs';
    import { extractBridgeRoundTripStartMs } from './bridge-roundtrip.mjs';
    import { createRelaysListController } from './relays-list.mjs';
    import { neventEncode } from '../vendor/nostr-tools.mjs';
    import { getRecentItems } from './bridge-recent-query.mjs';
    import { persistBridgeCacheState, restoreBridgeCacheState } from './bridge-cache.mjs';
    import {
      bookmarkSnapshotFromItem as bookmarkSnapshotFromItemState,
      getBookmarkedSnapshot as getBookmarkedSnapshotState,
      isRecentBookmarked as isRecentBookmarkedState,
      loadPanelState as loadPanelStateSnapshot,
      loadRecentBookmarks as loadRecentBookmarksState,
      loadRecentListState as loadRecentListStateSnapshot,
      persistPanelState as persistPanelStateSnapshot,
      persistRecentBookmarks as persistRecentBookmarksState,
      persistRecentListState as persistRecentListStateSnapshot,
      restorePanelState as restorePanelStateFromSnapshot,
      restoreRecentListUiState as restoreRecentListUiStateFromSnapshot,
      restoreStatPanelState as restoreStatPanelStateFromSnapshot,
      syncRecentListPauseState as syncRecentListPauseStateFromState,
      toggleRecentBookmark as toggleRecentBookmarkState,
      updateBookmarkButtons as updateBookmarkButtonsState,
    } from './bridge-recent-state.mjs';
        // Persistent IndexedDB store for all Nostr events and relationships
        // seen by the bridge (events, tags, relays, users, DAG edges, peer acks).
        import { getDagDb } from './dag-db.mjs';

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const SIGNER_KEY = 'nostr-dag-bridge-signer-v1';
    const DEFAULT_RELAYS = [
      'wss://nos.lol',
      'wss://relay.nostr.com',
      'wss://relay.nostr.band',
      'wss://relay.primal.net',
      'wss://nostr.wine',
      'wss://top.testrelay.top',
      'wss://relay.pocketnostr.com',
      'wss://basspistol.org',
      'wss://relay.ngit.dev',
    ];

    const { networkTime } = bootstrapDemoPageChrome({
      headerRoot: document.getElementById('sharedHeader'),
      footerRoot: document.getElementById('sharedFooter'),
      headerOptions: {
        title: 'nostr-dag',
        logoHref: resolveHref('../', window.location.href),
        iconHref: resolveHref('../shared/favicon.ico', window.location.href),
        subtitleHtml: '',
        navItems: [
          { label: 'Git viewer', href: resolveHref('../git/', window.location.href) },
          { label: 'Bridge', href: resolveHref('./', window.location.href), current: true },
        ],
      },
      footerOptions: {
        title: 'Logger',
        initialState: 'idle',
        initialTitle: 'bridge starting...',
        initialLevel: 'none',
        maxEntries: 5000,
      },
      footerMode: 'raf',
    });

    const pool = new SimplePool();
    const seenRelay = new Set();
    const seenLibp2p = new Set();
    const seenProcessed = new Set();
    const deterministicPeerKeyLabels = ['nostr-dag-native', 'nostr-dag-wasm'];
    const deterministicPeerIds = new Set();
    const deterministicNostrPubkeys = new Set();
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
      realNetworkRoundTripSamples: 0,
      realNetworkRoundTripTotalMs: 0,
      realNetworkRoundTripLastMs: null,
      realNetworkRoundTripMinMs: null,
      realNetworkRoundTripMaxMs: null,
      realNetworkRoundTripLastEventId: '',
      realNetworkRoundTripLastRelay: '',
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
    const bridgeRoundTripCountEl = document.getElementById('bridgeRoundTripCount');
    const bridgeRoundTripDetailCountEl = document.getElementById('bridgeRoundTripDetailCount');
    const bridgeRoundTripDetailStatusEl = document.getElementById('bridgeRoundTripDetailStatus');
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

    function loadRecentBookmarks() {
      return loadRecentBookmarksState();
    }

    function loadRecentListState() {
      return loadRecentListStateSnapshot();
    }

    function persistRecentListState() {
      return persistRecentListStateSnapshot(recentListState);
    }

    function loadPanelState() {
      return loadPanelStateSnapshot();
    }

    const recentPauseContainers = new Map([
      ['nostrToLibp2p', nostrToLibp2pRecentEl],
      ['libp2pToNostr', libp2pToNostrRecentEl],
      ['seenRelay', seenRelayRecentEl],
      ['seenLibp2p', seenLibp2pRecentEl],
    ]);

    function persistPanelState() {
      return persistPanelStateSnapshot({
        peerListEl,
        peerPanelEl,
        relayPanelEl,
        statPanelEls,
      });
    }

    function restorePanelState() {
      return restorePanelStateFromSnapshot(loadPanelState(), peerPanelEl, relayPanelEl);
    }

    function restoreStatPanelState() {
      return restoreStatPanelStateFromSnapshot(loadPanelState(), statPanelEls);
    }

    function restoreRecentListUiState() {
      return restoreRecentListUiStateFromSnapshot(recentListState, recentListStateSnapshot);
    }

    function syncRecentListPauseState() {
      return syncRecentListPauseStateFromState(recentListState, recentPauseContainers);
    }

    function persistRecentBookmarks() {
      return persistRecentBookmarksState(bookmarkedRecentIds, bookmarkedRecentSnapshots);
    }

    function isRecentBookmarked(id) {
      return isRecentBookmarkedState(id, bookmarkedRecentIds);
    }

    function getBookmarkedSnapshot(id) {
      return getBookmarkedSnapshotState(id, bookmarkedRecentSnapshots);
    }

    function bookmarkSnapshotFromItem(item) {
      return bookmarkSnapshotFromItemState(item);
    }

    async function initDeterministicPeerIds() {
      const ids = await Promise.all(deterministicPeerKeyLabels.map((label) => deterministicPeerIdFromSeed(label)));
      deterministicPeerIds.clear();
      for (const peerId of ids) {
        deterministicPeerIds.add(peerId);
      }
      // Compute matching Nostr pubkeys so we can query relays for presence events.
      deterministicNostrPubkeys.clear();
      for (const label of deterministicPeerKeyLabels) {
        try {
          const encoded = new TextEncoder().encode(label);
          const digest = await crypto.subtle.digest('SHA-256', encoded);
          const sk = new Uint8Array(digest);
          deterministicNostrPubkeys.add(getPublicKey(sk));
        } catch {
          // ignore
        }
      }
      schedulePeerRender();
    }

    function updateBookmarkButtons(id) {
      return updateBookmarkButtonsState(id, bookmarkedRecentIds);
    }

    function toggleRecentBookmark(id, item = null) {
      return toggleRecentBookmarkState({
        id,
        item,
        bookmarkedRecentIds,
        bookmarkedRecentSnapshots,
        scheduleRecentListsRender,
      });
    }

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
    void initDeterministicPeerIds();

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
    let topic = 'nostr-dag-bridge';
    let relays = DEFAULT_RELAYS.slice();
    let started = false;
    let peerPollTimer = null;
    const localPeers = new Map();
    const remotePeers = new Map();
    /** @type {Map<string, {bytesIn:number,msgsIn:number,bytesOut:number,msgsOut:number}>} */
    const peerIO = new Map();
    function recordPeerIn(peerId, bytes) {
      const id = String(peerId);
      const rec = peerIO.get(id) || { bytesIn: 0, msgsIn: 0, bytesOut: 0, msgsOut: 0 };
      rec.bytesIn += bytes;
      rec.msgsIn += 1;
      peerIO.set(id, rec);
    }
    function recordPeerOut(bytes) {
      // Gossipsub broadcasts to all mesh peers; we track total outbound
      // and attribute it to every known peer for a rough estimate.
      for (const [id, rec] of peerIO) {
        rec.bytesOut += bytes;
        rec.msgsOut += 1;
        peerIO.set(id, rec);
      }
    }
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
      bridgeStatusEl.innerHTML = `<span class="status-dot"></span>`;
      bridgeStatusEl.title = text;
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
      const roundTripAvgMs = metrics.realNetworkRoundTripSamples > 0
        ? Math.round(metrics.realNetworkRoundTripTotalMs / metrics.realNetworkRoundTripSamples)
        : null;
      nostrToLibp2pCountEl.textContent = String(metrics.nostrToLibp2p);
      libp2pToNostrCountEl.textContent = String(metrics.libp2pToNostr);
      seenRelayCountEl.textContent = String(seenRelay.size);
      seenLibp2pCountEl.textContent = String(seenLibp2p.size);
      relayPublishCountEl.textContent = `${metrics.relayPublishesSucceeded}/${metrics.relayPublishesAttempted}`;
      if (bridgeRoundTripCountEl) bridgeRoundTripCountEl.textContent = String(metrics.realNetworkRoundTripSamples);
      if (nostrToLibp2pDetailCountEl) nostrToLibp2pDetailCountEl.textContent = String(metrics.nostrToLibp2p);
      if (libp2pToNostrDetailCountEl) libp2pToNostrDetailCountEl.textContent = String(metrics.libp2pToNostr);
      if (seenRelayDetailCountEl) seenRelayDetailCountEl.textContent = String(seenRelay.size);
      if (seenLibp2pDetailCountEl) seenLibp2pDetailCountEl.textContent = String(seenLibp2p.size);
      if (relayPublishDetailCountEl) relayPublishDetailCountEl.textContent = `${metrics.relayPublishesSucceeded}/${metrics.relayPublishesAttempted}`;
      if (relayPublishDetailStatusEl) relayPublishDetailStatusEl.textContent = metrics.relayPublishesAttempted ? `${metrics.relayPublishesSucceeded} successful publishes` : 'No publish attempts yet.';
      if (bridgeRoundTripDetailCountEl) bridgeRoundTripDetailCountEl.textContent = metrics.realNetworkRoundTripSamples ? `${metrics.realNetworkRoundTripSamples} sample${metrics.realNetworkRoundTripSamples === 1 ? '' : 's'}` : '0 samples';
      if (bridgeRoundTripDetailStatusEl) {
        if (!metrics.realNetworkRoundTripSamples) {
          bridgeRoundTripDetailStatusEl.textContent = 'Waiting for a DAG-created event to return from a relay.';
        } else {
          const parts = [
            metrics.realNetworkRoundTripLastMs != null ? `last ${Math.round(metrics.realNetworkRoundTripLastMs)} ms` : null,
            roundTripAvgMs != null ? `avg ${roundTripAvgMs} ms` : null,
            metrics.realNetworkRoundTripMinMs != null ? `min ${Math.round(metrics.realNetworkRoundTripMinMs)} ms` : null,
            metrics.realNetworkRoundTripMaxMs != null ? `max ${Math.round(metrics.realNetworkRoundTripMaxMs)} ms` : null,
          ].filter(Boolean);
          bridgeRoundTripDetailStatusEl.textContent = parts.join(' · ');
        }
      }
    }

    function recordRealNetworkRoundTrip(event, relay) {
      const startedAtMs = extractBridgeRoundTripStartMs(event);
      if (!Number.isFinite(startedAtMs)) return;
      const elapsedMs = Math.max(0, Math.round(Date.now() - startedAtMs));
      metrics.realNetworkRoundTripSamples += 1;
      metrics.realNetworkRoundTripTotalMs += elapsedMs;
      metrics.realNetworkRoundTripLastMs = elapsedMs;
      metrics.realNetworkRoundTripMinMs = metrics.realNetworkRoundTripMinMs == null
        ? elapsedMs
        : Math.min(metrics.realNetworkRoundTripMinMs, elapsedMs);
      metrics.realNetworkRoundTripMaxMs = metrics.realNetworkRoundTripMaxMs == null
        ? elapsedMs
        : Math.max(metrics.realNetworkRoundTripMaxMs, elapsedMs);
      metrics.realNetworkRoundTripLastEventId = event.id;
      metrics.realNetworkRoundTripLastRelay = relay || '';
      refreshMetrics();
      scheduleBridgeCachePersist();
      window.__sharedFooter?.log(
        'bridge',
        `real network round trip ${elapsedMs} ms for ${event.id}${relay ? ` via ${relay}` : ''}`,
        'info',
        'available',
      );
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

    function eventDetailUrl(eventId) {
      if (!eventId) return '';
      return `./event.html?id=${encodeURIComponent(eventId)}`;
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
      const visibleItems = getRecentItems({
        key,
        items,
        recentListState,
        isRecentBookmarked,
      });
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
        const eventUrl = eventDetailUrl(event?.id || item?.id || '');
        const eventLink = eventUrl
          ? `<a class="bridge-recent-event-link" href="${escapeHtml(eventUrl)}" target="_blank" rel="noreferrer noopener" title="Open event detail">↗</a>`
          : '';
        const eventIdLink = eventUrl
          ? `<a class="bridge-event-id-link" href="${escapeHtml(eventUrl)}" target="_blank" rel="noreferrer noopener">${escapeHtml(event?.id || 'n/a')}</a>`
          : escapeHtml(event?.id || 'n/a');
        return `
          <details class="bridge-recent-event"${item?.id && openItems.has(item.id) ? ' open' : ''}>
            <summary class="bridge-recent-summary">
              <span class="bridge-recent-summary-main">
                <span class="bridge-recent-summary-top">
                  <span class="mono">${eventIdLink}</span>
                  <span class="muted">${escapeHtml(suffix)}</span>
                </span>
                <span class="bridge-recent-summary-bottom mono">${escapeHtml(createdAtText)}</span>
              </span>
              ${eventLink}
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
              <div class="mono" style="margin-bottom:8px;">${eventIdLink}</div>
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
      container.querySelectorAll('.bridge-recent-event-link').forEach((link) => {
        const stop = (event) => {
          event.stopPropagation();
        };
        link.addEventListener('pointerdown', stop);
        link.addEventListener('mousedown', stop);
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
        ? (() => {
            const url = eventDetailUrl(source);
            const link = url ? `<a class="bridge-relay-source" href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(source)}</a>` : escapeHtml(source);
            return `<div class="bridge-relay-learned small muted">Learned from ${link}</div>`;
          })()
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

    function persistBridgeCache() {
      return persistBridgeCacheState({
        relayCatalog,
        relayInfoCatalog,
        localPeers,
        remotePeers,
        metrics,
        seenRelay,
        seenLibp2p,
        recentNostrToLibp2p,
        recentLibp2pToNostr,
        recentSeenRelay,
        recentSeenLibp2p,
        log: (...args) => window.__sharedFooter?.log(...args),
      });
    }

    function restoreBridgeCache() {
      return restoreBridgeCacheState({
        relayCatalog,
        relayInfoCatalog,
        localPeers,
        remotePeers,
        seenRelay,
        seenLibp2p,
        seenProcessed,
        recentNostrToLibp2p,
        recentLibp2pToNostr,
        recentSeenRelay,
        recentSeenLibp2p,
        metrics,
        normalizeRelayUrl,
        createNostrRelay,
        peerKey,
        refreshMetrics,
        log: (...args) => window.__sharedFooter?.log(...args),
      });
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

    /**
     * Poll the local preview server's /peers endpoint and reconcile the peer list.
     *
     * Pruning policy (intentionally conservative):
     * - ONLY peers whose `source === 'localhost'` or `'http'` are candidates for
     *   removal. These are injected by the local development server and represent
     *   ephemeral preview processes.
     * - libp2p-discovered peers (`source === 'libp2p'`) are NEVER deleted.  Once a
     *   browser on GitHub Pages learns about a relay-circuit peer, we keep it so
     *   the user can still see it even if the next presence broadcast takes 30 s
     *   or the gossipsub mesh is temporarily unstable.
     * - When running on GH Pages, /peers returns 404; the catch block simply
     *   re-renders the existing list without touching any entries.
     */
    async function pollPeers() {
      try {
        const response = await fetch('/peers', { cache: 'no-store' });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const peers = await response.json();
        // Build a set of keys currently reported by the local server.
        const reportedKeys = new Set();
        const currentPeerId = node?.peerId?.toString?.() || globalThis.__currentLibp2pPeerId || '';
        for (const peer of Array.isArray(peers) ? peers : []) {
          // Skip the browser's own peer so it doesn't appear twice (localPeers already has it).
          if (peer.peer_id === currentPeerId) continue;
          // Force source to 'localhost' so pollPeers can prune stale entries correctly.
          upsertPeer('localhost', { ...peer, source: 'localhost' });
          reportedKeys.add(`${peer.peer_id}:${peer.path || '/'}:${peer.kind || 'unknown'}`);
        }
        // Remove localhost/http peers that have disappeared from the report.
        // All other sources (libp2p, browser, etc.) are left untouched.
        for (const [key, peer] of remotePeers) {
          if (peer.source === 'localhost' || peer.source === 'http') {
            const peerKey = `${peer.peer_id}:${peer.path || '/'}:${peer.kind || 'unknown'}`;
            if (!reportedKeys.has(peerKey)) remotePeers.delete(key);
          }
        }
        schedulePeerRender();
      } catch (e) {
        // On GH Pages /peers is unavailable; do not clear libp2p-discovered peers.
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
          pool.subscribeMany(relaysToQuery, { limit: 200 }, {
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
        event_id: event.id || '',
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
      peerIO,
      loadPanelState,
      persistPanelState,
      scheduleBridgeCachePersist,
      formatPeerDetail,
      sanitizePeerDetail,
      deterministicPeerIds,
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

    const RELAY_PUBLISH_DELAY_MS = 250;
    let relayPublishRound = 0;

    const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

    async function publishToRelaysRoundRobin(event, direction, relayHints = []) {
      const publishRelays = prioritizeRelayUrls([
        ...collectBridgeRelayHints(relayHints),
        ...currentRelayUrls(),
        ...DEFAULT_RELAYS,
      ]);
      if (!publishRelays.length) {
        throw new Error('no relays configured');
      }

      const startIndex = relayPublishRound % publishRelays.length;
      relayPublishRound += 1;
      const orderedRelays = [
        ...publishRelays.slice(startIndex),
        ...publishRelays.slice(0, startIndex),
      ];

      let succeeded = 0;
      for (let index = 0; index < orderedRelays.length; index += 1) {
        const relay = orderedRelays[index];
        window.__sharedFooter?.log('bridge', `${direction} ${event.kind} ${event.id} relay ${relay}`, 'trace', 'checking');
        try {
          await pool.publish([relay], event);
          succeeded += 1;
        } catch (error) {
          window.__sharedFooter?.log('bridge', `${direction} ${event.kind} ${event.id} relay ${relay} failed: ${error?.message || error}`, 'warn', 'unavailable');
        }
        if (index < orderedRelays.length - 1) {
          await sleep(RELAY_PUBLISH_DELAY_MS);
        }
      }

      metrics.relayPublishesAttempted += orderedRelays.length;
      metrics.relayPublishesSucceeded += succeeded;
      refreshMetrics();
      scheduleBridgeCachePersist();
      window.__sharedFooter?.log('bridge', `${direction} ${event.kind} ${event.id} via ${orderedRelays.join(', ')}`, 'info', 'available');
      window.__sharedFooter?.log('bridge', `publish responses ${event.id}: ${succeeded}/${orderedRelays.length} ok`, succeeded === orderedRelays.length ? 'info' : 'warn', succeeded === orderedRelays.length ? 'available' : 'checking');
      scheduleBridgeVerification(event, orderedRelays, direction);
      return orderedRelays;
    }

    async function publishToLibp2p(event, direction, meta = {}) {
      if (!node) {
        window.__sharedFooter?.log('bridge', `publishToLibp2p: node not ready, dropping ${direction} ${event.kind} ${event.id}`, 'warn', 'unavailable');
        return;
      }
      const payload = buildBridgeEnvelope(event, direction, currentRelayUrls(), { ...meta, topic });
      const encoded = encoder.encode(JSON.stringify(payload));
      await node.services.pubsub.publish(topic, encoded);
      recordPeerOut(encoded.length || encoded.byteLength || 0);
      metrics.nostrToLibp2p += direction === 'nostr->libp2p' ? 1 : 0;
      refreshMetrics();
      scheduleBridgeCachePersist();
      window.__sharedFooter?.log('bridge', `${direction} ${event.kind} ${event.id}`, 'trace', 'available');
    }

    async function forwardLibp2pEvent(event, relayHints = [], originPeerId = '', hopCount = 0) {
      const currentPeerId = node?.peerId?.toString?.() || globalThis.__currentLibp2pPeerId || '';
      if (!node || !event?.id) return;
      if (!originPeerId || originPeerId === currentPeerId) return;
      await publishToLibp2p(event, 'libp2p->libp2p', {
        originPeerId,
        forwardedBy: currentPeerId,
        hopCount: Number(hopCount) + 1,
        relayHints,
      });
    }

    async function publishToRelays(event, direction, relayHints = []) {
      const publishRelays = await publishToRelaysRoundRobin(event, direction, relayHints);
      return publishRelays[0] || null;
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
      await publishToRelaysRoundRobin(event, 'presence', relayHints);
      window.__sharedFooter?.log('bridge', `bridge presence broadcast complete (${publishRelays.length}/${publishRelays.length})`, 'info', 'available');
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
      if (source === 'relay') {
        recordRealNetworkRoundTrip(event, sourceRelay || '');
      }
      if (event.kind === 10002 || event.kind === 3) {
        recordRelayInfo(event);
        scheduleRelayRender();
      }
      // Extract peer presence from native kind-0 metadata events that carry libp2p addresses.
      if (event.kind === 0) {
        try {
          const content = JSON.parse(event.content);
          if (content.bridge_peer_id && Array.isArray(content.listen_addrs)) {
            await handleLibp2pPresence({
              type: 'presence',
              peer_id: content.bridge_peer_id,
              listen_addrs: content.listen_addrs,
              nostr_pubkey: event.pubkey,
            });
          }
        } catch (parseErr) {
          // silently ignore malformed kind-0 content
        }
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

    /**
     * Handle a libp2p presence broadcast from another peer (usually the native
     * nostr-dag-server).  This is the critical path that lets a GitHub Pages
     * browser discover and dial a developer's laptop via relay circuit addresses.
     *
     * When the native peer obtains a relay reservation it broadcasts its
     * circuit addresses (e.g. /ip4/…/tcp/4001/p2p/<relay>/p2p-circuit/p2p/<self>).
     * The browser receives this over gossipsub, stores the peer entry with
     * source='libp2p', and immediately attempts to dial every circuit address.
     * Once the circuit dial succeeds the two peers can exchange messages
     * directly without bootstrap intermediaries.
     *
     * Because libp2p peers are never pruned by pollPeers(), the entry persists
     * even if the next presence broadcast is delayed or dropped.
     */
    async function handleLibp2pPresence(message) {
      if (!message || message.type !== 'presence' || !message.peer_id) return false;
      const peerId = String(message.peer_id);
      const addrs = Array.isArray(message.listen_addrs) ? message.listen_addrs.filter(Boolean) : [];
      const detail = JSON.stringify({ addrs, nostr_pubkey: message.nostr_pubkey || '' });
      upsertPeer('libp2p', {
        peer_id: peerId,
        kind: 'presence',
        path: '/',
        detail,
        updated_at: Date.now(),
      });
      window.__sharedFooter?.log('bridge', `presence peer=${peerId} addrs=${addrs.length}`, 'debug', 'checking');
      const circuitAddrs = addrs.filter((a) => a.includes('/p2p-circuit/'));
      for (const addr of circuitAddrs) {
        try {
          window.__sharedFooter?.log('bridge', `dialing circuit ${addr}`, 'trace', 'checking');
          await node.dial(addr);
          window.__sharedFooter?.log('bridge', `dialed circuit ${addr}`, 'info', 'available');
        } catch (dialErr) {
          window.__sharedFooter?.log('bridge', `circuit dial failed ${addr}: ${dialErr?.message || dialErr}`, 'trace', 'checking');
        }
      }
      // Also try direct WSS addresses so localhost peers are reachable from HTTPS pages.
      const directWssAddrs = addrs.filter((a) => {
        const s = String(a);
        return (s.includes('/tls/ws') || s.includes('/wss')) && !s.includes('/p2p-circuit/');
      });
      for (const addr of directWssAddrs) {
        try {
          window.__sharedFooter?.log('bridge', `dialing wss ${addr}`, 'trace', 'checking');
          await node.dial(addr);
          window.__sharedFooter?.log('bridge', `dialed wss ${addr}`, 'info', 'available');
        } catch (dialErr) {
          window.__sharedFooter?.log('bridge', `wss dial failed ${addr}: ${dialErr?.message || dialErr}`, 'trace', 'checking');
        }
      }
      // Dial WebRTC-direct addresses (IPv6 public or LAN) for NAT-bypass connectivity.
      const webrtcAddrs = addrs.filter((a) => String(a).includes('/webrtc-direct'));
      for (const addr of webrtcAddrs) {
        try {
          window.__sharedFooter?.log('bridge', `dialing webrtc-direct ${addr}`, 'trace', 'checking');
          await node.dial(addr);
          window.__sharedFooter?.log('bridge', `dialed webrtc-direct ${addr}`, 'info', 'available');
        } catch (dialErr) {
          window.__sharedFooter?.log('bridge', `webrtc-direct dial failed ${addr}: ${dialErr?.message || dialErr}`, 'trace', 'checking');
        }
      }
      schedulePeerRender();
      return true;
    }

    async function handleLibp2pMessage(message) {
      if (await handleLibp2pPresence(message)) return;
      const envelope = decodeBridgeMessage(message);
      if (!envelope) {
        window.__sharedFooter?.log('bridge', 'rejected libp2p payload with unsupported protocol', 'warn', 'unavailable');
        return;
      }
      const { event, relayHints, direction, originPeerId, hopCount } = envelope;
      const seenOnLibp2pBefore = seenLibp2p.has(event.id);
      const seenOnRelayBefore = seenRelay.has(event.id);
      markSeen('libp2p', event);
      if (!verifyEvent(event)) {
        window.__sharedFooter?.log('bridge', `rejected libp2p payload ${event.id}`, 'warn', 'unavailable');
        return;
      }
      if (seenOnLibp2pBefore) return;
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
        if (!seenOnRelayBefore) {
          await publishToRelays(event, 'libp2p->nostr', relayHints);
        }
      } catch (e) {
        window.__sharedFooter?.log('bridge', `relay publish failed: ${e.message}`, 'error', 'unavailable');
      }
      if (direction !== 'libp2p->libp2p' && !seenOnLibp2pBefore) {
        try {
          await forwardLibp2pEvent(event, relayHints, originPeerId, hopCount);
        } catch (e) {
          window.__sharedFooter?.log('bridge', `libp2p forward failed: ${e.message}`, 'warn', 'unavailable');
        }
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
              deterministicKeySeed: deterministicPeerKeyLabels[1] || 'nostr-dag-wasm',
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
            const isWebSocketsOnly = !config.includeWebRTC && !config.includeWebRTCDirect && !config.includeCircuitRelay;
            if (isWebSocketsOnly) {
              setStatus('', 'warning');
            }
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
          const fromPeer = evt.detail?.from?.toString?.() || evt.detail?.from || '';
          if (fromPeer && payload) {
            const byteLength = payload.length || payload.byteLength || 0;
            recordPeerIn(fromPeer, byteLength);
          }
          try {
            const message = JSON.parse(decoder.decode(payload));
            void handleLibp2pMessage(message);
          } catch {
            window.__sharedFooter?.log('bridge', 'ignored malformed pubsub payload', 'warn', 'unavailable');
          }
        });

        const relaysSnapshot = prioritizeRelayUrls([...DEFAULT_RELAYS, ...currentRelayUrls()]);
        window.__sharedFooter?.log('bridge', `subscribing Nostr relays: ${relaysSnapshot.join(', ')}`, 'trace', 'checking');
        pool.subscribeMany(relaysSnapshot, { limit: 500 }, {
          onevent(event) {
            logRawNostrEvent('relay event raw', event);
            // sourceRelay is unavailable from SimplePool's onevent callback;
            // pass null and let upsertEventRelay be called when a relay is
            // known (e.g. from the relay_hints in a libp2p envelope).
            void handleNostrEvent(event, 'relay', null);
          },
          oneose() {},
        });

        // Explicitly query for deterministic native peer presence events.
        // Generic subscriptions on busy relays may miss kind-0 metadata events.
        for (const pubkey of deterministicNostrPubkeys) {
          window.__sharedFooter?.log('bridge', `querying presence for deterministic pubkey ${pubkey.slice(0, 16)}…`, 'trace', 'checking');
          pool.querySync(relaysSnapshot, { kinds: [0], authors: [pubkey], limit: 3 }, { maxWait: 5000 })
            .then((events) => {
              for (const ev of events) {
                window.__sharedFooter?.log('bridge', `presence query hit kind=${ev.kind} ${ev.id.slice(0, 16)}…`, 'debug', 'available');
                void handleNostrEvent(ev, 'relay-query', null);
              }
            })
            .catch((e) => {
              window.__sharedFooter?.log('bridge', `presence query failed: ${e?.message || e}`, 'warn', 'checking');
            });
        }

        const measuredCount = measuredRelayCount(relaysSnapshot);
        const statusCount = measuredCount > 0 ? `${measuredCount} measured` : `${relaysSnapshot.length} known`;
        setStatus('', 'available');
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
