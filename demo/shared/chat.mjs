/**
 * Browser chat module for nostr-dag.
 *
 * Uses the shared libp2p gossipsub stack to send and receive chat messages
 * that interoperate with the Rust native and WASM peers.
 */

import {
  buildChatMessage,
  buildChatJoin,
  buildChatLeave,
  buildChatPing,
  buildChatPong,
  parseChatEvent,
  parseChatMessage,
  CHAT_PROTOCOL,
  CHAT_VERSION,
} from './chat-protocol.mjs';

const TOPIC = 'nostr-dag-bridge';
const BC_CHANNEL = 'nostr-dag-chat';
const LS_KEY = 'nostr-dag-chat-msg';

const TAB_ID = globalThis.__nostrDagChatTabId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
globalThis.__nostrDagChatTabId = TAB_ID;

const state = globalThis.__nostrDagChatState || {
  node: null,
  localPeerId: '',
  messages: [],
  onMessageHandler: null,
  onPeerHandler: null,
  onStatusHandler: null,
  onPingHandler: null,
  bc: null,
  lsSeen: new Set(),
  pendingPings: new Map(),
};
globalThis.__nostrDagChatState = state;

function initBroadcastChannel() {
  if (state.bc) return;
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const bc = new BroadcastChannel(BC_CHANNEL);
    bc.onmessage = (ev) => {
      if (!ev.data || typeof ev.data !== 'object') return;
      const { payload, sourceId } = ev.data;
      if (!payload || sourceId === TAB_ID) return;
      handleIncomingChatRaw(payload, 'broadcast-channel');
    };
    state.bc = bc;
  } catch {
    // BroadcastChannel not available
  }
}

function broadcastChannelSend(payload) {
  if (!state.bc) return;
  try {
    state.bc.postMessage({ payload, sourceId: TAB_ID });
  } catch {
    // ignore
  }
}

function initLocalStorage() {
  if (typeof window === 'undefined') return;
  try {
    window.addEventListener('storage', (ev) => {
      if (ev.key !== LS_KEY || !ev.newValue) return;
      try {
        const data = JSON.parse(ev.newValue);
        if (!data || data.sourceId === state.localPeerId) return;
        if (state.lsSeen.has(data.id)) return;
        state.lsSeen.add(data.id);
        handleIncomingChatRaw(data.payload, 'localStorage');
      } catch {
        // ignore malformed storage events
      }
    });
  } catch {
    // localStorage not available
  }
}

function localStorageSend(payload) {
  if (typeof localStorage === 'undefined') return;
  try {
    const id = `${TAB_ID}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = JSON.stringify({ payload, sourceId: TAB_ID, id });
    localStorage.setItem(LS_KEY, data);
    setTimeout(() => {
      try {
        if (localStorage.getItem(LS_KEY) === data) {
          localStorage.removeItem(LS_KEY);
        }
      } catch {}
    }, 10000);
  } catch {
    // ignore
  }
}

export function attachChatNode(node) {
  if (state.node === node) {
    return Promise.resolve();
  }
  if (node?.services?.pubsub?.addEventListener) {
    state.node = node;
    state.localPeerId = node?.peerId?.toString?.() || '';
  }
  initBroadcastChannel();
  initLocalStorage();
  initHttpRelay();
  if (!node?.services?.pubsub?.addEventListener) {
    return Promise.resolve();
  }

  node.services.pubsub.addEventListener('message', (event) => {
    const data = event?.detail?.data;
    let raw = '';
    if (typeof data === 'string') {
      raw = data;
    } else if (data instanceof Uint8Array) {
      raw = new TextDecoder().decode(data);
    } else if (ArrayBuffer.isView(data)) {
      raw = new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } else if (data instanceof ArrayBuffer) {
      raw = new TextDecoder().decode(new Uint8Array(data));
    }
    handleIncomingChatRaw(raw, 'libp2p');
  });

  return Promise.resolve(node.services.pubsub.subscribe(TOPIC)).catch(() => {});
}

function handleIncomingChatRaw(raw, relay) {
  const ev = parseChatEvent(raw);
  if (!ev) return;
  // Ignore echoes of our own messages — we already displayed them locally
  // when sendChat() / sendChatPing() / sendChatJoin() / sendChatLeave()
  // appended the self entry.
  if (ev.from === state.localPeerId) return;

  // Emit peer lifecycle events for join/leave/ping
  if (ev.type === 'join' && typeof state.onPeerHandler === 'function') {
    try { state.onPeerHandler({ kind: 'joined', peer: ev.from, timestamp: ev.timestamp }); } catch {}
  }
  if (ev.type === 'leave' && typeof state.onPeerHandler === 'function') {
    try { state.onPeerHandler({ kind: 'left', peer: ev.from, timestamp: ev.timestamp }); } catch {}
  }
  if (ev.type === 'ping') {
    if (typeof state.onPeerHandler === 'function') {
      try { state.onPeerHandler({ kind: 'ping', peer: ev.from, timestamp: ev.timestamp }); } catch {}
    }
    // Auto-reply with pong if the ping came from another peer
    if (ev.from !== state.localPeerId && ev.pingId) {
      sendChatPong(ev.pingId);
    }
  }

  if (ev.type === 'pong') {
    if (ev.pingId && state.pendingPings.has(ev.pingId)) {
      const startTime = state.pendingPings.get(ev.pingId);
      const rtt = Date.now() - startTime;
      state.pendingPings.delete(ev.pingId);
      if (typeof state.onPingHandler === 'function') {
        try { state.onPingHandler({ peer: ev.from, rtt, pingId: ev.pingId }); } catch {}
      }
    }
    // Pongs are control traffic — don't display them in the chat stream.
    return;
  }

  const entry = {
    from: ev.from,
    text: ev.text,
    timestamp: ev.timestamp,
    id: `${ev.from}-${ev.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    relay,
    system: ev.type !== 'message',
  };
  state.messages.push(entry);
  if (state.messages.length > 500) {
    state.messages = state.messages.slice(-500);
  }
  if (typeof state.onMessageHandler === 'function') {
    try {
      state.onMessageHandler(entry);
    } catch {
      // ignore handler errors
    }
  }
}

export async function sendChat(text) {
  const trimmed = String(text).trim();
  if (!trimmed) {
    throw new Error('Empty message');
  }
  const payload = buildChatMessage(state.localPeerId, trimmed);

  // Always broadcast via BroadcastChannel + localStorage so same-origin tabs
  // see the message immediately even before libp2p mesh forms.
  // BroadcastChannel works same-browser; localStorage works cross-browser.
  broadcastChannelSend(payload);
  localStorageSend(payload);

  // Publish over the HTTP relay so cross-browser peers on the same server
  // receive the message even when libp2p WebSocket transport is unavailable.
  await httpRelaySend(payload);

  // Also publish over libp2p gossipsub when connected.
  if (state.node?.services?.pubsub?.publish) {
    try {
      await state.node.services.pubsub.publish(TOPIC, new TextEncoder().encode(payload));
    } catch {
      // best-effort; other channels already delivered locally
    }
  }

  const entry = {
    from: state.localPeerId || 'me',
    text: trimmed,
    timestamp: Date.now(),
    id: `me-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    self: true,
  };
  state.messages.push(entry);
  if (state.messages.length > 500) {
    state.messages = state.messages.slice(-500);
  }
  if (typeof state.onMessageHandler === 'function') {
    try {
      state.onMessageHandler(entry);
    } catch {
      // ignore
    }
  }
  return entry;
}

export async function sendChatJoin() {
  const payload = buildChatJoin(state.localPeerId);
  broadcastChannelSend(payload);
  localStorageSend(payload);
  await httpRelaySend(payload);
  if (state.node?.services?.pubsub?.publish) {
    try {
      await state.node.services.pubsub.publish(TOPIC, new TextEncoder().encode(payload));
    } catch {}
  }
}

export async function sendChatLeave() {
  const payload = buildChatLeave(state.localPeerId);
  broadcastChannelSend(payload);
  localStorageSend(payload);
  await httpRelaySend(payload);
  if (state.node?.services?.pubsub?.publish) {
    try {
      await state.node.services.pubsub.publish(TOPIC, new TextEncoder().encode(payload));
    } catch {}
  }
}

export async function sendChatPing() {
  const pingId = `${state.localPeerId || 'me'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = buildChatPing(state.localPeerId, pingId);
  state.pendingPings.set(pingId, Date.now());

  broadcastChannelSend(payload);
  localStorageSend(payload);
  await httpRelaySend(payload);
  if (state.node?.services?.pubsub?.publish) {
    try {
      await state.node.services.pubsub.publish(TOPIC, new TextEncoder().encode(payload));
    } catch {}
  }

  // Show the ping locally
  const entry = {
    from: state.localPeerId || 'me',
    text: 'Ping',
    timestamp: Date.now(),
    id: `me-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    self: true,
    system: true,
  };
  state.messages.push(entry);
  if (typeof state.onMessageHandler === 'function') {
    try { state.onMessageHandler(entry); } catch {}
  }
  return { pingId };
}

async function sendChatPong(pingId) {
  const payload = buildChatPong(state.localPeerId, pingId);
  broadcastChannelSend(payload);
  localStorageSend(payload);
  // Pongs carry a pingId the HTTP relay doesn't preserve; skip HTTP relay.
  if (state.node?.services?.pubsub?.publish) {
    try {
      await state.node.services.pubsub.publish(TOPIC, new TextEncoder().encode(payload));
    } catch {}
  }
}

export function getMessages() {
  return state.messages.slice();
}

export function onMessage(handler) {
  state.onMessageHandler = typeof handler === 'function' ? handler : null;
}

export function onPeer(handler) {
  state.onPeerHandler = typeof handler === 'function' ? handler : null;
}

export function onStatus(handler) {
  state.onStatusHandler = typeof handler === 'function' ? handler : null;
}

export function onPing(handler) {
  state.onPingHandler = typeof handler === 'function' ? handler : null;
}

export function resetChat() {
  state.messages = [];
  state.node = null;
  state.localPeerId = '';
  state.httpSeen = new Set();
  state.lsSeen = new Set();
  state.pendingPings.clear();
  if (state.bc) {
    try { state.bc.close(); } catch {}
    state.bc = null;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  // Clear localStorage keys belonging to this chat so other tabs
  // don't resurrect stale state after a reset.
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(LS_KEY);
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith('nostr-dag')) {
          localStorage.removeItem(key);
        }
      }
    } catch {}
  }
  // Wipe the global singletons so a fresh import starts clean.
  try {
    globalThis.__nostrDagChatTabId = undefined;
    globalThis.__nostrDagChatState = undefined;
  } catch {}
}

// ---------------------------------------------------------------------------
// HTTP relay fallback — used when libp2p mesh is not available (e.g. cross-
// browser on localhost where the JS/WASM libp2p stack cannot dial the native
// peer's WebSocket listener).  The server buffers messages and serves them via
// simple HTTP polling so any browser can participate.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2000;
const HTTP_RELAY_MAX_AGE_MS = 300_000; // 5 min

function initHttpRelay() {
  if (state.pollTimer) return;
  if (typeof fetch === 'undefined') return;
  state.pollTimer = setInterval(() => {
    void pollHttpRelay();
  }, POLL_INTERVAL_MS);
  void pollHttpRelay();
}

async function pollHttpRelay() {
  try {
    const since = state.lastHttpPollAt || 0;
    const res = await fetch(`/chat/poll/${since}`, { cache: 'no-store' });
    if (!res.ok) {
      console.error('[chat:pollHttpRelay] GET failed:', res.status, res.statusText);
      return;
    }
    const messages = await res.json();
    if (!Array.isArray(messages)) {
      console.error('[chat:pollHttpRelay] non-array response:', messages);
      return;
    }
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const id = `${msg.from}-${msg.timestamp}-${msg.id || ''}`;
      if (state.httpSeen && state.httpSeen.has(id)) continue;
      if (!state.httpSeen) state.httpSeen = new Set();
      state.httpSeen.add(id);
      const envelope = JSON.stringify({
        protocol: CHAT_PROTOCOL,
        version: CHAT_VERSION,
        type: 'message',
        from: msg.from,
        text: msg.text,
        timestamp: msg.timestamp,
      });
      handleIncomingChatRaw(envelope, 'http-relay');
    }
    state.lastHttpPollAt = Date.now() - HTTP_RELAY_MAX_AGE_MS;
  } catch (err) {
    console.error('[chat:pollHttpRelay] error:', err);
  }
}

async function httpRelaySend(payload) {
  try {
    const chat = parseChatMessage(payload);
    if (!chat) return;
    const msg = {
      ...chat,
      id: `${chat.from}-${chat.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    };
    const res = await fetch('/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });
    if (!res.ok) {
      console.error('[chat:httpRelaySend] POST /chat/message failed:', res.status, res.statusText);
    }
  } catch (err) {
    console.error('[chat:httpRelaySend] POST /chat/message error:', err);
  }
}
