/**
 * Browser chat module for nostr-dag.
 *
 * Uses the shared libp2p gossipsub stack to send and receive chat messages
 * that interoperate with the Rust native and WASM peers.
 *
 * Reusable via `createChat(options)` for multiple independent instances,
 * or import the default singleton exports for simple one-chat-per-page use.
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

// ---------------------------------------------------------------------------
// Factory — create an independent chat instance
// ---------------------------------------------------------------------------

export function createChat(options = {}) {
  const topic = options.topic || 'nostr-dag-bridge';
  const bcChannel = options.broadcastChannel || 'nostr-dag-chat';
  const lsKey = options.localStorageKey || 'nostr-dag-chat-msg';
  const httpRelayUrl = options.httpRelayUrl || '/chat/message';
  const httpPollUrlBase = options.httpPollUrl || '/chat/poll';
  const pollIntervalMs = options.pollIntervalMs || 2000;
  const httpRelayMaxAgeMs = options.httpRelayMaxAgeMs || 300_000;
  const maxMessages = options.maxMessages || 500;

  const tabId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const state = {
    node: null,
    localPeerId: '',
    messages: [],
    onMessageHandler: null,
    onPeerHandler: null,
    onStatusHandler: null,
    onPingHandler: null,
    bc: null,
    lsSeen: new Set(),
    httpSeen: new Set(),
    pendingPings: new Map(),
    pollTimer: null,
    lastHttpPollAt: null,
  };

  function initBroadcastChannel() {
    if (state.bc) return;
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      const bc = new BroadcastChannel(bcChannel);
      bc.onmessage = (ev) => {
        if (!ev.data || typeof ev.data !== 'object') return;
        const { payload, sourceId } = ev.data;
        if (!payload || sourceId === tabId) return;
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
      state.bc.postMessage({ payload, sourceId: tabId });
    } catch {
      // ignore
    }
  }

  function initLocalStorage() {
    if (typeof window === 'undefined') return;
    try {
      window.addEventListener('storage', (ev) => {
        if (ev.key !== lsKey || !ev.newValue) return;
        try {
          const data = JSON.parse(ev.newValue);
          // Skip messages that originated from this tab instance
          if (!data || data.sourceId === tabId) return;
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
      const id = `${tabId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const data = JSON.stringify({ payload, sourceId: tabId, id });
      localStorage.setItem(lsKey, data);
      setTimeout(() => {
        try {
          if (localStorage.getItem(lsKey) === data) {
            localStorage.removeItem(lsKey);
          }
        } catch {}
      }, 10000);
    } catch {
      // ignore
    }
  }

  function attachChatNode(node) {
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

    return Promise.resolve(node.services.pubsub.subscribe(topic)).catch(() => {});
  }

  function handleIncomingChatRaw(raw, relay) {
    const ev = parseChatEvent(raw);
    if (!ev) return;
    // Ignore echoes of our own messages — we already displayed them locally
    if (ev.from === state.localPeerId) return;

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
    if (ev.git) entry.git = ev.git;
    state.messages.push(entry);
    if (state.messages.length > maxMessages) {
      state.messages = state.messages.slice(-maxMessages);
    }
    if (typeof state.onMessageHandler === 'function') {
      try {
        state.onMessageHandler(entry);
      } catch {
        // ignore handler errors
      }
    }
  }

  async function sendChat(text, git = null) {
    const trimmed = String(text).trim();
    if (!trimmed) {
      throw new Error('Empty message');
    }
    const payload = buildChatMessage(state.localPeerId, trimmed, git);

    broadcastChannelSend(payload);
    localStorageSend(payload);
    await httpRelaySend(payload);

    if (state.node?.services?.pubsub?.publish) {
      try {
        await state.node.services.pubsub.publish(topic, new TextEncoder().encode(payload));
      } catch {
        // best-effort
      }
    }

    const entry = {
      from: state.localPeerId || 'me',
      text: trimmed,
      timestamp: Date.now(),
      id: `me-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      self: true,
    };
    if (git) entry.git = git;
    state.messages.push(entry);
    if (state.messages.length > maxMessages) {
      state.messages = state.messages.slice(-maxMessages);
    }
    if (typeof state.onMessageHandler === 'function') {
      try {
        state.onMessageHandler(entry);
      } catch {
        // ignore handler errors
      }
    }
    return entry;
  }

  async function sendChatJoin() {
    const payload = buildChatJoin(state.localPeerId);
    broadcastChannelSend(payload);
    localStorageSend(payload);
    await httpRelaySend(payload);
    if (state.node?.services?.pubsub?.publish) {
      try {
        await state.node.services.pubsub.publish(topic, new TextEncoder().encode(payload));
      } catch {}
    }
  }

  async function sendChatLeave() {
    const payload = buildChatLeave(state.localPeerId);
    broadcastChannelSend(payload);
    localStorageSend(payload);
    await httpRelaySend(payload);
    if (state.node?.services?.pubsub?.publish) {
      try {
        await state.node.services.pubsub.publish(topic, new TextEncoder().encode(payload));
      } catch {}
    }
  }

  async function sendChatPing() {
    const pingId = `${state.localPeerId || 'me'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = buildChatPing(state.localPeerId, pingId);
    state.pendingPings.set(pingId, Date.now());

    broadcastChannelSend(payload);
    localStorageSend(payload);
    await httpRelaySend(payload);
    if (state.node?.services?.pubsub?.publish) {
      try {
        await state.node.services.pubsub.publish(topic, new TextEncoder().encode(payload));
      } catch {}
    }

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
    if (state.node?.services?.pubsub?.publish) {
      try {
        await state.node.services.pubsub.publish(topic, new TextEncoder().encode(payload));
      } catch {}
    }
  }

  function getMessages() {
    return state.messages.slice();
  }

  function onMessage(handler) {
    state.onMessageHandler = typeof handler === 'function' ? handler : null;
  }

  function onPeer(handler) {
    state.onPeerHandler = typeof handler === 'function' ? handler : null;
  }

  function onStatus(handler) {
    state.onStatusHandler = typeof handler === 'function' ? handler : null;
  }

  function onPing(handler) {
    state.onPingHandler = typeof handler === 'function' ? handler : null;
  }

  function resetChat() {
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
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(lsKey);
      } catch {}
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP relay fallback
  // ---------------------------------------------------------------------------

  function initHttpRelay() {
    if (state.pollTimer) return;
    if (typeof fetch === 'undefined') return;
    state.pollTimer = setInterval(() => {
      void pollHttpRelay();
    }, pollIntervalMs);
    void pollHttpRelay();
  }

  async function pollHttpRelay() {
    try {
      const since = state.lastHttpPollAt || 0;
      const res = await fetch(`${httpPollUrlBase}/${since}`, { cache: 'no-store' });
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
        if (state.httpSeen.has(id)) continue;
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
      state.lastHttpPollAt = Date.now() - httpRelayMaxAgeMs;
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
      const res = await fetch(httpRelayUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      });
      if (!res.ok) {
        console.error('[chat:httpRelaySend] POST failed:', res.status, res.statusText);
      }
    } catch (err) {
      console.error('[chat:httpRelaySend] POST error:', err);
    }
  }

  return {
    attachChatNode,
    sendChat,
    sendChatJoin,
    sendChatLeave,
    sendChatPing,
    sendChatPong,
    getMessages,
    onMessage,
    onPeer,
    onStatus,
    onPing,
    resetChat,
  };
}

// ---------------------------------------------------------------------------
// Default singleton — backward-compatible module-level exports
// ---------------------------------------------------------------------------

const defaultChat = createChat();

export const attachChatNode = (...args) => defaultChat.attachChatNode(...args);
export const sendChat = (...args) => defaultChat.sendChat(...args);
export const sendChatJoin = (...args) => defaultChat.sendChatJoin(...args);
export const sendChatLeave = (...args) => defaultChat.sendChatLeave(...args);
export const sendChatPing = (...args) => defaultChat.sendChatPing(...args);
export const sendChatPong = (...args) => defaultChat.sendChatPong(...args);
export const getMessages = (...args) => defaultChat.getMessages(...args);
export const onMessage = (...args) => defaultChat.onMessage(...args);
export const onPeer = (...args) => defaultChat.onPeer(...args);
export const onStatus = (...args) => defaultChat.onStatus(...args);
export const onPing = (...args) => defaultChat.onPing(...args);
export const resetChat = (...args) => defaultChat.resetChat(...args);
