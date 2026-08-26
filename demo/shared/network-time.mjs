const STORAGE_KEY = 'nostr-dag.network-time.v1';
const NETWORK_TIME_PROTOCOL = 'nostr-dag-network-time';
const NETWORK_TIME_VERSION = 1;
const NETWORK_TIME_TOPIC = 'nostr-dag-bridge';
const SYNC_INTERVAL_MS = 30_000;
const QUERY_WAIT_MS = 1_200;
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

function updateHeader() {
  const headerApi = currentHeaderApi();
  if (!headerApi?.setNetworkTime) return;
  const syncedAgoMs = state.lastSyncAt ? Math.max(0, Date.now() - state.lastSyncAt) : null;
  const syncText = syncedAgoMs == null ? 'no sync yet' : `${Math.round(syncedAgoMs / 1000)}s ago`;
  const accuracyText = Number.isFinite(state.lastAccuracyMs) ? `${Math.round(state.lastAccuracyMs)}ms` : 'n/a';
  const sampleText = state.lastSampleCount ? `${state.lastSampleCount} peer${state.lastSampleCount === 1 ? '' : 's'}` : 'local clock';
  headerApi.setNetworkTime({
    text: formatUtcTime(getNetworkNowMs()),
    title: `Network time ${state.status} · ${sampleText} · accuracy ${accuracyText} · last sync ${syncText}`,
    state: state.status,
  });
}

function ensureTickTimer() {
  if (state.tickTimer) return;
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
  if (!state.node?.services?.pubsub?.publish) return;
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

export function computeConsensusOffset(responses = []) {
  return median(
    responses
      .map((response) => Number(response?.offsetMs))
      .filter((value) => Number.isFinite(value)),
  );
}

function noteConsensusResponses(responses) {
  if (!responses.length) {
    state.status = state.lastSyncAt ? 'available' : 'unavailable';
    updateHeader();
    return;
  }
  state.offsetMs = computeConsensusOffset(responses);
  state.lastSyncAt = Date.now();
  state.lastSampleCount = responses.length;
  state.lastAccuracyMs = median(responses.map((response) => response.rttMs / 2));
  state.status = 'available';
  // Log the integer delta (ms) between network time and local UTC time.
  console.error(`[network-time] delta network-utc: ${Math.round(state.offsetMs)} ms`);
  persistState();
  updateHeader();
}

async function publishNetworkTimeMessage(payload) {
  if (!state.node?.services?.pubsub?.publish) return;
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
    await publishNetworkTimeMessage(response);
    return;
  }

  const pending = state.pendingRequests.get(payload.request_id);
  if (!pending) return;
  if (payload.requester_peer_id && payload.requester_peer_id !== state.localPeerId) return;
  const receivedAtMs = Date.now();
  const sentAtMs = Number(payload.sent_at_ms);
  const serverTimeMs = Number(payload.server_time_ms);
  if (!Number.isFinite(sentAtMs) || !Number.isFinite(serverTimeMs)) return;
  pending.responses.push({
    responderPeerId: payload.responder_peer_id || '',
    offsetMs: serverTimeMs - ((pending.sentAtMs + receivedAtMs) / 2),
    rttMs: Math.max(0, receivedAtMs - pending.sentAtMs),
  });
}

export function getNetworkNowMs() {
  return Date.now() + state.offsetMs;
}

export function getNetworkUnixTime() {
  return Math.floor(getNetworkNowMs() / 1000);
}

export async function syncNetworkTime({ waitMs = QUERY_WAIT_MS } = {}) {
  if (!state.node?.services?.pubsub?.publish) {
    state.status = state.lastSyncAt ? 'available' : 'unavailable';
    updateHeader();
    return {
      offsetMs: state.offsetMs,
      status: state.status,
      sampleCount: state.lastSampleCount,
    };
  }

  state.status = 'checking';
  updateHeader();
  state.requestCounter += 1;
  const requestId = `${Date.now()}-${state.requestCounter}`;
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

  noteConsensusResponses(pending.responses);
  return {
    offsetMs: state.offsetMs,
    status: state.status,
    sampleCount: state.lastSampleCount,
  };
}

export function initSharedNetworkTime({ headerApi = null } = {}) {
  restoreState();
  if (headerApi) {
    state.headerApi = headerApi;
  } else if (!state.headerApi && globalThis.__sharedHeaderApi) {
    state.headerApi = globalThis.__sharedHeaderApi;
  }
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
        updateHeader();
        return;
      }
      if (state.node === node) {
        scheduleSyncLoop();
        return;
      }
      state.node = node;
      state.localPeerId = node?.peerId?.toString?.() || '';
      node.services.pubsub.addEventListener('message', (event) => {
        void handleNetworkTimeMessage(event);
      });
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
