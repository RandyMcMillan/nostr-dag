const STORAGE_KEY = 'nostr-dag.network-time.v2';
const NETWORK_TIME_PROTOCOL = 'nostr-dag-network-time';
const NETWORK_TIME_VERSION = 1;
const NETWORK_TIME_TOPIC = 'nostr-dag-bridge';
const SYNC_INTERVAL_MS = 5_000;
const RETRY_DELAY_MS = 2_000;
const QUERY_WAIT_MS = 1_200;
const SAMPLE_WINDOW = 10;
const DAMPING_FACTOR = 0.1;
const MIN_SAMPLES_FOR_RECALIBRATION = 3;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const state = globalThis.__nostrDagNetworkTimeState || {
  offsetMs: 0,
  status: 'checking',
  lastSyncAt: 0,
  lastSampleCount: 0,
  lastAccuracyMs: null,
  node: null,
  localPeerId: '',
  headerApi: null,
  syncTimer: null,
  tickTimer: null,
  pendingRequests: new Map(),
  requestCounter: 0,
  // Persistent sliding window of recent peer samples for damped consensus.
  peerSamples: [],
  // Tracks whether we have already attached the visibility listener so that
  // re-calling initSharedNetworkTime() (e.g. hot-module reload) does not
  // register a second handler.
  visibilityListenerAttached: false,
};

globalThis.__nostrDagNetworkTimeState = state;

function median(values) {
  if (!Array.isArray(values) || !values.length) return 0;
  const sorted = [...values]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function formatUtcTime(timestampMs) {
  return new Date(timestampMs).toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function persistState() {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({
      offsetMs: state.offsetMs,
      status: state.status,
      lastSyncAt: state.lastSyncAt,
      lastSampleCount: state.lastSampleCount,
      lastAccuracyMs: state.lastAccuracyMs,
    }));
  } catch {
    // best effort only
  }
}

function restoreState() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Number.isFinite(Number(parsed?.offsetMs))) state.offsetMs = Number(parsed.offsetMs);
    if (typeof parsed?.status === 'string') state.status = parsed.status;
    if (Number.isFinite(Number(parsed?.lastSyncAt))) state.lastSyncAt = Number(parsed.lastSyncAt);
    if (Number.isFinite(Number(parsed?.lastSampleCount))) state.lastSampleCount = Number(parsed.lastSampleCount);
    if (Number.isFinite(Number(parsed?.lastAccuracyMs))) state.lastAccuracyMs = Number(parsed.lastAccuracyMs);
  } catch {
    // ignore corrupt cache
  }
}

function currentHeaderApi() {
  return state.headerApi || globalThis.__sharedHeaderApi || null;
}

function logEvent(text) {
  const api = currentHeaderApi();
  if (api?.logNetworkTime) {
    api.logNetworkTime(text);
  }
}

function updateHeader() {
  const headerApi = currentHeaderApi();
  const syncedAgoMs = state.lastSyncAt ? Math.max(0, Date.now() - state.lastSyncAt) : null;
  const syncText = syncedAgoMs == null ? 'no sync yet' : `${Math.round(syncedAgoMs / 1000)}s ago`;
  const accuracyText = Number.isFinite(state.lastAccuracyMs) ? `${Math.round(state.lastAccuracyMs)}ms` : 'n/a';
  const sampleText = state.peerSamples.length ? `${state.peerSamples.length} sample${state.peerSamples.length === 1 ? '' : 's'}` : 'local clock';
  const deltaText = formatDeltaMs(state.offsetMs);
  const localNow = Date.now();
  const consensusNow = getNetworkNowMs();
  const peerList = state.peerSamples.map((s) => s.responderPeerId.slice(0, 12)).join(',');
  if (!headerApi?.setNetworkTime) return;
  headerApi.setNetworkTime({
    text: `${formatUtcTime(consensusNow)} (${deltaText}) · ${sampleText}`,
    title: `Network time ${state.status} · ${sampleText} · accuracy ${accuracyText} · delta ${deltaText} · last sync ${syncText}`,
    state: state.status,
  });
}

function ensureTickTimer() {
  if (state.tickTimer) return;
  logEvent('[timer] tick timer started');
  // Safari iOS can suspend setInterval when the tab is backgrounded or the
  // screen dims.  We track the last-tick wall-clock so that when the page
  // becomes visible again we can detect the gap and immediately refresh the
  // displayed time rather than waiting up to one second.
  state._lastTickAt = Date.now();
  state.tickTimer = globalThis.setInterval(() => {
    state._lastTickAt = Date.now();
    updateHeader();
  }, 1000);
}

function scheduleSyncLoop() {
  if (state.syncTimer) {
    globalThis.clearInterval(state.syncTimer);
  }
  if (!state.node?.services?.pubsub?.publish) {
    logEvent('[sync] loop skipped: no pubsub');
    return;
  }
  logEvent(`[sync] loop scheduled every ${SYNC_INTERVAL_MS}ms`);
  state.syncTimer = globalThis.setInterval(() => {
    void syncNetworkTime();
  }, SYNC_INTERVAL_MS);
}

function decodePubsubMessage(event) {
  const data = event?.detail?.data;
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return decoder.decode(data);
  if (ArrayBuffer.isView(data)) return decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  if (data instanceof ArrayBuffer) return decoder.decode(new Uint8Array(data));
  return '';
}

export function buildNetworkTimeQuery({ requestId, requesterPeerId = '', sentAtMs }) {
  return {
    protocol: NETWORK_TIME_PROTOCOL,
    version: NETWORK_TIME_VERSION,
    type: 'query',
    request_id: requestId,
    requester_peer_id: requesterPeerId,
    sent_at_ms: sentAtMs,
  };
}

export function buildNetworkTimeResponse(query, responderPeerId, nowMs) {
  return {
    protocol: NETWORK_TIME_PROTOCOL,
    version: NETWORK_TIME_VERSION,
    type: 'response',
    request_id: query.request_id,
    requester_peer_id: query.requester_peer_id || '',
    responder_peer_id: responderPeerId || '',
    sent_at_ms: query.sent_at_ms,
    server_time_ms: nowMs,
  };
}

export function parseNetworkTimeMessage(text) {
  try {
    const parsed = JSON.parse(text);
    if (
      parsed?.protocol !== NETWORK_TIME_PROTOCOL ||
      Number(parsed?.version) !== NETWORK_TIME_VERSION ||
      (parsed?.type !== 'query' && parsed?.type !== 'response')
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function computeConsensusOffset(samples = []) {
  return median(
    samples
      .map((sample) => Number(sample?.deltaMs))
      .filter((value) => Number.isFinite(value)),
  );
}

/**
 * Recalibrate the local offset using a damped sliding window.
 * Instead of snapping to the raw median immediately (which causes oscillation),
 * we move only a fraction of the way toward the target each round.
 */
function recalibrateOffset() {
  if (state.peerSamples.length < MIN_SAMPLES_FOR_RECALIBRATION) {
    state.status = state.lastSyncAt ? 'available' : 'unavailable';
    logEvent(`[consensus] need ${MIN_SAMPLES_FOR_RECALIBRATION}+ peers for consensus — have ${state.peerSamples.length} samples, offset=${formatDeltaMs(state.offsetMs)}`);
    return;
  }
  const medianDelta = computeConsensusOffset(state.peerSamples);
  const beforeOffset = state.offsetMs;
  state.offsetMs += Math.round(medianDelta * DAMPING_FACTOR);
  state.lastSyncAt = Date.now();
  state.lastSampleCount = state.peerSamples.length;
  state.lastAccuracyMs = median(state.peerSamples.map((s) => s.rttMs / 2));
  state.status = 'available';
  logEvent(`[consensus] medianDelta=${formatDeltaMs(medianDelta)} before=${formatDeltaMs(beforeOffset)} after=${formatDeltaMs(state.offsetMs)} samples=${state.peerSamples.length} accuracy=${Math.round(state.lastAccuracyMs)}ms`);
  persistState();
}

async function publishNetworkTimeMessage(payload) {
  if (!state.node?.services?.pubsub?.publish) return;
  logEvent(`[pubsub] publish type=${payload.type} id=${payload.request_id || 'n/a'}`);
  await state.node.services.pubsub.publish(
    NETWORK_TIME_TOPIC,
    encoder.encode(JSON.stringify(payload)),
  );
}

async function handleNetworkTimeMessage(event) {
  const payload = parseNetworkTimeMessage(decodePubsubMessage(event));
  if (!payload) return;

  if (payload.type === 'query') {
    if (!state.node?.services?.pubsub?.publish) return;
    if (payload.requester_peer_id && payload.requester_peer_id === state.localPeerId) return;
    const response = buildNetworkTimeResponse(payload, state.localPeerId, Date.now());
    logEvent(`[query] from=${payload.requester_peer_id || 'unknown'} req=${payload.request_id} localTime=${response.server_time_ms}`);
    await publishNetworkTimeMessage(response);
    return;
  }

  const pending = state.pendingRequests.get(payload.request_id);
  if (!pending) return;
  if (payload.requester_peer_id && payload.requester_peer_id !== state.localPeerId) return;
  const receivedAtMs = Date.now();
  const sentAtMs = Number(payload.sent_at_ms);
  const serverTimeMs = Number(payload.server_time_ms);
  if (!Number.isFinite(sentAtMs) || !Number.isFinite(serverTimeMs)) {
    logEvent(`[response] invalid numbers req=${payload.request_id}`);
    return;
  }
  const localConsensusTime = Date.now() + state.offsetMs;
  const deltaMs = serverTimeMs - localConsensusTime;
  const rttMs = Math.max(0, receivedAtMs - pending.sentAtMs);
  const responderPeerId = payload.responder_peer_id || 'unknown';

  // Track that this pending request got a response
  pending.responses.push({ responderPeerId, deltaMs, rttMs });

  // Add to persistent sliding window, evicting oldest if full.
  state.peerSamples.push({ responderPeerId, deltaMs, rttMs, receivedAtMs });
  if (state.peerSamples.length > SAMPLE_WINDOW) {
    state.peerSamples.shift();
  }

  const peerShort = responderPeerId.slice(0, 16);
  logEvent(`[response] peer=${peerShort}… req=${payload.request_id} localConsensus=${localConsensusTime} peerTime=${serverTimeMs} delta=${formatDeltaMs(deltaMs)} rtt=${Math.round(rttMs)}ms window=${state.peerSamples.length}`);
  logEvent(`[sample] peer=${peerShort}… delta=${formatDeltaMs(deltaMs)} rtt=${Math.round(rttMs)}ms`);
}

export function getNetworkNowMs() {
  return Date.now() + state.offsetMs;
}

export function getNetworkUnixTime() {
  return Math.floor(getNetworkNowMs() / 1000);
}

/**
 * Return the current delta between network consensus time and local UTC.
 * Positive means the local clock is behind network time;
 * negative means the local clock is ahead.
 */
export function getNetworkTimeDelta() {
  return state.offsetMs;
}

function formatDeltaMs(ms) {
  const sign = ms >= 0 ? '+' : '';
  return `${sign}${Math.round(ms)} ms`;
}

export async function syncNetworkTime({ waitMs = QUERY_WAIT_MS } = {}) {
  if (!state.node?.services?.pubsub?.publish) {
    state.status = state.lastSyncAt ? 'available' : 'unavailable';
    updateHeader();
    logEvent(`[sync] offline offset=${formatDeltaMs(state.offsetMs)} samples=${state.peerSamples.length}`);
    return {
      offsetMs: state.offsetMs,
      status: state.status,
      sampleCount: state.peerSamples.length,
    };
  }

  state.status = 'checking';
  updateHeader();
  state.requestCounter += 1;
  const requestId = `${Date.now()}-${state.requestCounter}`;
  logEvent(`[sync] query=${requestId} wait=${waitMs}ms offset=${formatDeltaMs(state.offsetMs)} samples=${state.peerSamples.length}`);
  const pending = {
    requestId,
    sentAtMs: Date.now(),
    responses: [],
  };
  state.pendingRequests.set(requestId, pending);
  try {
    await publishNetworkTimeMessage(buildNetworkTimeQuery({
      requestId,
      requesterPeerId: state.localPeerId,
      sentAtMs: pending.sentAtMs,
    }));
    await new Promise((resolve) => globalThis.setTimeout(resolve, waitMs));
  } finally {
    state.pendingRequests.delete(requestId);
  }

  if (pending.responses.length === 0) {
    logEvent(`[sync] query=${requestId} ZERO RESPONSES — scheduling retry in ${RETRY_DELAY_MS}ms`);
    globalThis.setTimeout(() => void syncNetworkTime(), RETRY_DELAY_MS);
  }

  recalibrateOffset();
  updateHeader();
  logEvent(`[sync] query=${requestId} done responses=${pending.responses.length} offset=${formatDeltaMs(state.offsetMs)} samples=${state.peerSamples.length}`);
  return {
    offsetMs: state.offsetMs,
    status: state.status,
    sampleCount: state.peerSamples.length,
  };
}

export function initSharedNetworkTime({ headerApi = null } = {}) {
  restoreState();
  if (headerApi) {
    state.headerApi = headerApi;
  } else if (!state.headerApi && globalThis.__sharedHeaderApi) {
    state.headerApi = globalThis.__sharedHeaderApi;
  }
  logEvent(`[init] restored offset=${formatDeltaMs(state.offsetMs)} status=${state.status} samples=${state.peerSamples.length}`);
  ensureTickTimer();
  updateHeader();

  // Safari iOS (and other mobile browsers) aggressively throttle or suspend
  // setInterval/setTimeout when the tab is backgrounded or the screen locks.
  // When the page becomes visible again the sync loop may have stopped running.
  // We listen for `visibilitychange` to restart the tick display immediately
  // and re-sync network time so the clock never shows a stale value.
  if (!state.visibilityListenerAttached && typeof globalThis.document !== 'undefined') {
    state.visibilityListenerAttached = true;
    globalThis.document.addEventListener('visibilitychange', () => {
      if (globalThis.document.visibilityState !== 'visible') return;
      // Immediately refresh the header so the user does not see a frozen clock.
      updateHeader();
      // Restart the tick timer in case iOS killed it while backgrounded.
      if (state.tickTimer) {
        globalThis.clearInterval(state.tickTimer);
        state.tickTimer = null;
      }
      ensureTickTimer();
      // Re-schedule the sync loop and trigger an immediate sync to recalibrate
      // the offset after any suspend-induced drift.
      scheduleSyncLoop();
      void syncNetworkTime();
    });
  }

  return {
    attachNode(node) {
      if (!node?.services?.pubsub?.addEventListener) {
        logEvent('[attach] node missing pubsub');
        updateHeader();
        return;
      }
      if (state.node === node) {
        logEvent('[attach] same node re-attached');
        scheduleSyncLoop();
        return;
      }
      state.node = node;
      state.localPeerId = node?.peerId?.toString?.() || '';
      logEvent(`[attach] peerId=${state.localPeerId}`);
      node.services.pubsub.subscribe(NETWORK_TIME_TOPIC);
      node.services.pubsub.addEventListener('message', (event) => {
        void handleNetworkTimeMessage(event);
      });
      if (!state._peerListenersAttached) {
        state._peerListenersAttached = true;
        node.addEventListener('peer:connect', () => {
          logEvent('[peer:connect] peer joined, waiting 1s for mesh graft then syncing');
          globalThis.setTimeout(() => void syncNetworkTime(), 1_000);
        });
        node.addEventListener('peer:disconnect', () => {
          logEvent('[peer:disconnect] peer left, syncing');
          void syncNetworkTime();
        });
      }
      scheduleSyncLoop();
      void syncNetworkTime();
    },
    syncNow(options) {
      return syncNetworkTime(options);
    },
    getSnapshot() {
      return {
        offsetMs: state.offsetMs,
        status: state.status,
        lastSyncAt: state.lastSyncAt,
        lastSampleCount: state.lastSampleCount,
        lastAccuracyMs: state.lastAccuracyMs,
      };
    },
  };
}
