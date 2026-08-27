import { BRIDGE_CACHE_KEY } from './bridge-relay-data.mjs';

export function persistBridgeCacheState(state) {
  const {
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
    log = () => {},
  } = state;
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
    window.localStorage.setItem(BRIDGE_CACHE_KEY, JSON.stringify(payload));
    log('bridge', 'bridge cache persisted', 'trace', 'available');
  } catch {
    log('bridge', 'bridge cache persist failed', 'warn', 'unavailable');
  }
}

export function restoreBridgeCacheState(state) {
  const {
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
    log = () => {},
  } = state;
  try {
    const raw = window.localStorage.getItem(BRIDGE_CACHE_KEY);
    if (!raw) {
      log('bridge', 'no cached bridge state found', 'debug', 'idle');
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
    log('bridge', `restored cached bridge state (${relayCatalog.size} relay groups, ${localPeers.size + remotePeers.size} peers)`, 'info', 'available');
    return true;
  } catch {
    log('bridge', 'failed to restore cached bridge state', 'warn', 'unavailable');
    return false;
  }
}
