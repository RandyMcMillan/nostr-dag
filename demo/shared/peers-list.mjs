function formatBytes(n) {
  if (n === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(n) / Math.log(k));
  return `${parseFloat((n / k ** i).toFixed(1))} ${sizes[i]}`;
}

export function createPeersListController({
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
  deterministicPeerIds = new Set(),
}) {
  function peerKey(peer) {
    return `${peer.source || 'browser'}:${peer.path || '/'}:${peer.peer_id}:${peer.kind || 'unknown'}`;
  }

  function upsertPeer(source, peer) {
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
      detail: sanitizePeerDetail?.(peer.detail) ?? formatPeerDetail(peer.detail),
      updated_at: peer.updated_at || Date.now(),
    };
    if (source === 'browser') {
      localPeers.set(key, record);
    } else {
      remotePeers.set(key, record);
    }
    persistPanelState?.();
    scheduleBridgeCachePersist?.();
  }

  function allPeers() {
    return [...localPeers.values(), ...remotePeers.values()].sort((a, b) => {
      const aDet = deterministicPeerIds.has(String(a.peer_id));
      const bDet = deterministicPeerIds.has(String(b.peer_id));
      if (aDet && !bDet) return -1;
      if (bDet && !aDet) return 1;
      return (b.updated_at || 0) - (a.updated_at || 0);
    });
  }

  function extractPeerSummary(detail) {
    let pubkey = '';
    let addr = '';
    try {
      const parsed = typeof detail === 'string' ? JSON.parse(detail) : detail;
      if (parsed && typeof parsed === 'object') {
        pubkey = parsed.nostr_pubkey || '';
        const addrs = parsed.addrs || parsed.listen_addrs || parsed.multiaddrs || [];
        addr = Array.isArray(addrs) ? addrs[0] || '' : String(addrs).split('|')[0].trim() || '';
      }
    } catch {
      // detail is not JSON — try to grab a multiaddr from plain text
      if (typeof detail === 'string') {
        const m = detail.match(/(\/ip[46]\/[^\s|]+)/);
        addr = m ? m[1] : '';
      }
    }
    const trunc = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
    return { pubkey: trunc(pubkey, 24), addr: trunc(addr, 48) };
  }

  function renderPeers() {
    const peers = allPeers();
    if (peerCountEl) peerCountEl.textContent = String(peers.length);
    if (!peerListEl) return;
    if (!peers.length) {
      peerListEl.innerHTML = '<div class="small muted">No peers reported yet.</div>';
      return;
    }

    const openPeerKeys = new Set([
      ...[...peerListEl.querySelectorAll('details[open][data-peer-key]')].map((el) => el.getAttribute('data-peer-key')).filter(Boolean),
      ...((loadPanelState?.().openPeerKeys || []).filter((value) => typeof value === 'string' && value)),
    ]);

    peerListEl.innerHTML = peers.map((peer) => {
      const { pubkey, addr } = extractPeerSummary(peer.detail);
      const subtitle = pubkey || addr
        ? `<div class="bridge-peer-subtitle mono">${pubkey ? `<span class="bridge-peer-pubkey" title="${pubkey}">${pubkey}</span>` : ''}${addr ? `<span class="bridge-peer-addr" title="${addr}">${addr}</span>` : ''}</div>`
        : '';
      const io = peerIO?.get(String(peer.peer_id));
      const ioHtml = io
        ? `<div class="bridge-peer-io mono"><span class="bridge-peer-io-label">↓</span> ${formatBytes(io.bytesIn)} <span class="muted">(${io.msgsIn} msgs)</span>  <span class="bridge-peer-io-label">↑</span> ${formatBytes(io.bytesOut)} <span class="muted">(${io.msgsOut} msgs)</span></div>`
        : '';
      return `
      <details class="bridge-card bridge-peer" data-peer-key="${String(peerKey(peer)).replaceAll('"', '&quot;')}">
        <summary class="bridge-card-summary">
          <div class="bridge-peer-head">
            <div class="bridge-peer-title-wrap">
              <div class="bridge-peer-title mono">${String(peer.peer_id).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}${deterministicPeerIds.has(String(peer.peer_id)) ? ' <span class="bridge-peer-star" title="Deterministic peer" aria-label="Deterministic peer">★</span>' : ''}</div>
              ${subtitle}
            </div>
            <div class="bridge-peer-meta">
              <span class="bridge-pill">${String(peer.kind || 'unknown').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</span>
              <span class="bridge-pill">${String(peer.path || '/').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</span>
              <span class="bridge-pill">${String(new Date(peer.updated_at || Date.now()).toLocaleTimeString()).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</span>
              <span class="bridge-pill bridge-pill-source">${String(peer.source || 'browser').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</span>
            </div>
          </div>
        </summary>
        ${ioHtml}
        <pre class="bridge-peer-detail mono">${peer.detail ? String(formatPeerDetail(peer.detail)).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') : 'no detail'}</pre>
      </details>
    `}).join('');

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
    persistPanelState?.();
  }

  return { peerKey, upsertPeer, allPeers, renderPeers };
}
