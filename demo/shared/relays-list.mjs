function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function createRelaysListController({
  defaultRelays,
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
  windowLog,
}) {
  const log = (...args) => windowLog?.(...args);

  function relayRowHtml(relay, info, source, loading) {
    const hasInfo = Boolean(info && !info.error);
    const gitCapable = hasInfo && info && Array.isArray(info.supported_nips) && info.supported_nips.some((nip) => Number(nip) === 34);
    const fields = hasInfo ? [
      info.name || '',
      info.description || '',
      info.version ? `v${info.version}` : '',
      Number.isFinite(Number(info.ping_ms)) ? `${Math.round(Number(info.ping_ms))} ms` : '',
    ].filter(Boolean) : [];
    const learnedFrom = source && source !== 'default'
      ? `<div class="bridge-relay-learned small muted">Learned from ${escapeHtml(source)}</div>`
      : '';
    return `
      <a class="bridge-card bridge-relay-card bridge-relay-link" href="${escapeHtml(`./relay.html?relay=${encodeURIComponent(relay)}`)}">
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

  function renderDefaultRelays() {
    const entries = sortRelaysByPing(defaultRelays).filter((relay) => relayPingSortValue(relayInfoForUrl(relay)) < Number.POSITIVE_INFINITY);
    if (defaultRelayCountEl) defaultRelayCountEl.textContent = String(entries.length);
    log?.('bridge', `render default relays (${entries.length})`, 'trace', 'checking');
    if (!defaultRelayListEl) return;
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
    if (!relayListEl || !relayCountEl) return;
    const defaultVisible = sortRelaysByPing([...new Set(defaultRelays)]).filter((relay) => relayPingSortValue(relayInfoForUrl(relay)) < Number.POSITIVE_INFINITY);
    const learnedRelays = sortRelaysByPing([...new Set([...relayCatalog.values()].flatMap((entry) => entry.relays || []))]).filter((relay) => relayPingSortValue(relayInfoForUrl(relay)) < Number.POSITIVE_INFINITY);
    const visibleRelays = learnedRelays.filter((relay) => {
      const info = relayInfoForUrl(relay);
      return Boolean(info && !info.error && !defaultVisible.includes(relay) && Number(info.ping_ms) > 0);
    });
    const combinedRelays = sortRelaysByPing([...defaultVisible, ...visibleRelays]);
    relayCountEl.textContent = String(combinedRelays.length);
    log?.('bridge', `render accumulated relays (${combinedRelays.length})`, 'trace', 'checking');
    if (!combinedRelays.length) {
      relayListEl.innerHTML = '<div class="small muted">No relays have a measured ping yet.</div>';
      return;
    }

    const learned = new Map([...relayCatalog.values()].flatMap((entry) => (entry.relays || []).map((relay) => [relay, entry])));
    relayListEl.innerHTML = combinedRelays.map((relay) => {
      const info = relayInfoForUrl(relay);
      const source = learned.get(relay);
      const loading = relayInfoInFlight.has(normalizeRelayUrl(relay) || relay);
      const sourceLabel = defaultVisible.includes(relay)
        ? 'default'
        : source
          ? (source.owner || 'unknown')
          : 'unknown';
      return relayRowHtml(relay, info, sourceLabel, loading);
    }).join('');
  }

  function recordRelayInfo(event) {
    if (!event?.pubkey) return;
    const urls = new Set();
    const collectRelayUrls = (value) => {
      if (typeof value === 'string') {
        const normalized = normalizeRelayUrl(value);
        if (normalized) urls.add(normalized);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) collectRelayUrls(item);
        return;
      }
      if (value && typeof value === 'object') {
        for (const item of Object.values(value)) collectRelayUrls(item);
      }
    };
    const collectRelayUrlsFromTags = (tags) => {
      if (!Array.isArray(tags)) return;
      for (const tag of tags) {
        if (!Array.isArray(tag) || tag[0] !== 'r' || !tag[1]) continue;
        const normalized = normalizeRelayUrl(tag[1]);
        if (normalized) urls.add(normalized);
      }
    };
    collectRelayUrlsFromTags(event.tags || []);
    collectRelayUrls(event.tags || []);
    if (typeof event.content === 'string') {
      try {
        collectRelayUrls(JSON.parse(event.content || '{}'));
      } catch {
        collectRelayUrls(event.content);
      }
    } else {
      collectRelayUrls(event.content);
    }
    for (const value of Object.values(event)) {
      if (value === event.tags || value === event.content) continue;
      collectRelayUrls(value);
    }
    if (!urls.size) return;
    log?.('bridge', `accumulate ${urls.size} relays from kind ${event.kind} ${event.pubkey}`, 'trace', 'checking');
    relayCatalog.set(event.pubkey, {
      owner: event.pubkey,
      kind: event.kind,
      relays: [...urls],
      updated_at: Date.now(),
    });
    log?.('bridge', `relay catalog size ${relayCatalog.size}`, 'trace', 'available');
    scheduleBridgeCachePersist?.();
    scheduleRelayDiscovery?.([...urls]);
    scheduleBridgePresenceBroadcast?.([...urls]);
    refreshRelayInfo?.([...urls]);
    return urls;
  }

  return { relayRowHtml, renderDefaultRelays, renderRelays, recordRelayInfo };
}
