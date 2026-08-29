import { resolveHref } from './page-path.js';
import {
  fetchRelayInfo,
  loadBridgeCache,
  normalizeRelayUrl,
  sourceForRelay,
} from './bridge-relay-data.mjs';
const detailEl = document.getElementById('relayDetail');
const relayParam = new URL(window.location.href).searchParams.get('relay');

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function eventDetailUrl(eventId) {
  if (!eventId) return '';
  return `./event.html?id=${encodeURIComponent(eventId)}`;
}

function supportsNip34GitKinds(info) {
  if (!info || typeof info !== 'object') return false;
  if (Array.isArray(info.supported_nips) && info.supported_nips.some((nip) => Number(nip) === 34)) return true;
  const supportedKinds = Array.isArray(info.supported_kinds) ? info.supported_kinds : [];
  return supportedKinds.some((kind) => [30617, 30618, 30619, 30620, 30621, 30622].includes(Number(kind)));
}

function relayHeaderHtml(relay, info, source, loading) {
  const hasInfo = Boolean(info && !info.error);
  const gitCapable = hasInfo && supportsNip34GitKinds(info);
  const fields = hasInfo ? [
    info.name || '',
    info.description || '',
    info.version ? `v${info.version}` : '',
    Number.isFinite(Number(info.ping_ms)) ? `${Math.round(Number(info.ping_ms))} ms` : '',
  ].filter(Boolean) : [];
  return `
    <div class="bridge-card bridge-relay-card bridge-relay-detail-card">
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
    </div>
  `;
}

function detailSectionHtml(title, body) {
  if (!body) return '';
  return `
    <section class="bridge-relay-section">
      <h2 class="bridge-relay-section-title">${escapeHtml(title)}</h2>
      ${body}
    </section>
  `;
}

function renderRelayDetail(relay, info, source, loading) {
  const hasInfo = Boolean(info && !info.error);
  const metadataPills = hasInfo ? [
    info.pubkey ? `<span class="bridge-pill bridge-pill-relay">pubkey ${escapeHtml(info.pubkey)}</span>` : '',
    info.contact ? `<span class="bridge-pill bridge-pill-relay">${escapeHtml(info.contact)}</span>` : '',
    info.software ? `<span class="bridge-pill bridge-pill-relay">${escapeHtml(info.software)}</span>` : '',
    Number.isFinite(Number(info.ping_ms)) ? `<span class="bridge-pill bridge-pill-relay">ping ${escapeHtml(`${Math.round(Number(info.ping_ms))} ms`)}</span>` : '',
    info.icon ? `<span class="bridge-pill bridge-pill-relay">icon</span>` : '',
    info.negentropy ? '<span class="bridge-pill bridge-pill-relay">negentropy</span>' : '',
    typeof info.limitation?.auth_required === 'boolean' ? `<span class="bridge-pill bridge-pill-relay">${info.limitation.auth_required ? 'auth required' : 'no auth'}</span>` : '',
    typeof info.limitation?.payment_required === 'boolean' ? `<span class="bridge-pill bridge-pill-relay">${info.limitation.payment_required ? 'payment required' : 'free'}</span>` : '',
  ].filter(Boolean).join('') : '';
  const supportedNips = hasInfo && Array.isArray(info.supported_nips) && info.supported_nips.length
    ? info.supported_nips.map((nip) => `<span class="bridge-pill bridge-pill-relay">NIP-${escapeHtml(nip)}</span>`).join('')
    : '<span class="bridge-pill">supported_nips unknown</span>';
  const countries = hasInfo && Array.isArray(info.relay_countries) && info.relay_countries.length
    ? info.relay_countries.map((country) => `<span class="bridge-pill bridge-pill-relay">${escapeHtml(country)}</span>`).join('')
    : '';
  const rawJson = info ? escapeHtml(JSON.stringify(info, null, 2)) : '';
  detailEl.innerHTML = `
    <div class="row" style="justify-content:space-between; margin-bottom:12px;">
      <div>
        <h1 style="margin:0 0 6px;">Relay detail</h1>
        <div class="small muted">Full relay metadata view.</div>
      </div>
      <a class="button" href="${escapeHtml(resolveHref('./', window.location.href))}">Back to Bridge</a>
    </div>
    ${relayHeaderHtml(relay, info, source, loading)}
    <div class="bridge-relay-details">
      ${info?.error ? `<div class="small muted">NIP-11 fetch failed: ${escapeHtml(info.error)}</div>` : ''}
      ${hasInfo ? `
        ${detailSectionHtml('Description', info.description ? `<div class="small muted">${escapeHtml(info.description)}</div>` : '<div class="small muted">No description provided.</div>')}
        ${detailSectionHtml('Metadata', `<div class="bridge-relay-grid">${metadataPills || '<span class="bridge-pill">No metadata chips</span>'}</div>`)}
        ${detailSectionHtml('Supported NIPs', `<div class="bridge-relay-grid">${supportedNips}</div>`)}
        ${countries ? detailSectionHtml('Relay countries', `<div class="bridge-relay-grid">${countries}</div>`) : ''}
        ${detailSectionHtml('Raw NIP-11', `<pre class="bridge-relay-pre">${rawJson}</pre>`)}
      ` : loading ? `<div class="small muted">Loading NIP-11 metadata…</div>` : `<div class="small muted">NIP-11 metadata not loaded yet.</div>`}
      ${source && source !== 'default' ? (() => {
        const url = eventDetailUrl(source);
        const link = url ? `<a class="bridge-relay-source" href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(source)}</a>` : escapeHtml(source);
        return `<div class="bridge-relay-learned small muted">Learned from ${link}</div>`;
      })() : ''}
    </div>
  `;
}

async function boot() {
  if (!detailEl) return;
  if (!relayParam) {
    detailEl.innerHTML = `
      <div class="panel">
        <h1 style="margin-top:0;">Relay detail</h1>
        <p class="small muted">Missing relay query parameter.</p>
        <a class="button" href="${escapeHtml(resolveHref('./', window.location.href))}">Back to Bridge</a>
      </div>
    `;
    return;
  }

  const relay = normalizeRelayUrl(relayParam);
  const cache = loadBridgeCache();
  const source = sourceForRelay(relay, cache.relayCatalog) || '';
  const cachedInfo = cache.relayInfoCatalog.get(relay) || null;
  document.title = relay ? `nostr-dag Relay Detail · ${relay}` : 'nostr-dag Relay Detail';
  renderRelayDetail(relay, cachedInfo, source, !cachedInfo || cachedInfo.error);
  const info = await fetchRelayInfo(relay);
  renderRelayDetail(relay, info, source, false);
}

void boot();
