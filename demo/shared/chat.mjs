/**
 * Browser chat module for nostr-dag.
 *
 * Uses the shared libp2p gossipsub stack to send and receive chat messages
 * that interoperate with the Rust native and WASM peers.
 *
 * Wire format (matches Rust `p2p::build_chat_message`):
 *   {"protocol":"nostr-dag-chat","version":1,"type":"message",
 *    "from":"<peer_id>","text":"<content>","timestamp":<unix_ms>}
 */

const CHAT_PROTOCOL = 'nostr-dag-chat';
const CHAT_VERSION = 1;
const TOPIC = 'nostr-dag-bridge';

const state = globalThis.__nostrDagChatState || {
  node: null,
  localPeerId: '',
  messages: [],
  onMessageHandler: null,
  onStatusHandler: null,
};
globalThis.__nostrDagChatState = state;

export function buildChatMessage(peerId, text) {
  return JSON.stringify({
    protocol: CHAT_PROTOCOL,
    version: CHAT_VERSION,
    type: 'message',
    from: peerId,
    text,
    timestamp: Date.now(),
  });
}

export function parseChatMessage(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed?.protocol !== CHAT_PROTOCOL ||
      Number(parsed?.version) !== CHAT_VERSION ||
      parsed?.type !== 'message'
    ) {
      return null;
    }
    return {
      from: String(parsed.from || 'unknown'),
      text: String(parsed.text || ''),
      timestamp: Number(parsed.timestamp) || 0,
    };
  } catch {
    return null;
  }
}

export function attachChatNode(node) {
  if (!node?.services?.pubsub?.addEventListener) {
    return Promise.resolve();
  }
  if (state.node === node) {
    return Promise.resolve();
  }
  state.node = node;
  state.localPeerId = node?.peerId?.toString?.() || '';

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
    const chat = parseChatMessage(raw);
    if (!chat) return;

    const entry = {
      ...chat,
      id: `${chat.from}-${chat.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
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
  });

  return Promise.resolve(node.services.pubsub.subscribe(TOPIC)).catch(() => {});
}

export async function sendChat(text) {
  if (!state.node?.services?.pubsub?.publish) {
    throw new Error('Chat node not connected');
  }
  const trimmed = String(text).trim();
  if (!trimmed) {
    throw new Error('Empty message');
  }
  const payload = buildChatMessage(state.localPeerId, trimmed);
  await state.node.services.pubsub.publish(TOPIC, new TextEncoder().encode(payload));
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

export function getMessages() {
  return state.messages.slice();
}

export function onMessage(handler) {
  state.onMessageHandler = typeof handler === 'function' ? handler : null;
}

export function onStatus(handler) {
  state.onStatusHandler = typeof handler === 'function' ? handler : null;
}

export function resetChat() {
  state.messages = [];
  state.node = null;
  state.localPeerId = '';
}
