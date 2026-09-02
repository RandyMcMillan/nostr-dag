/**
 * nostr-dag chat protocol — shared wire format for peer-to-peer chat.
 *
 * Message types:
 *   message  — regular text payload
 *   join     — peer entered the chat
 *   leave    — peer left the chat
 *
 * All messages carry the same envelope:
 *   {"protocol":"nostr-dag-chat","version":1,"type":"...",
 *    "from":"<peer_id>","timestamp":<unix_ms>,"text":"..."}
 */

export const CHAT_PROTOCOL = 'nostr-dag-chat';
export const CHAT_VERSION = 1;

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

export function buildChatJoin(peerId) {
  return JSON.stringify({
    protocol: CHAT_PROTOCOL,
    version: CHAT_VERSION,
    type: 'join',
    from: peerId,
    timestamp: Date.now(),
  });
}

export function buildChatLeave(peerId) {
  return JSON.stringify({
    protocol: CHAT_PROTOCOL,
    version: CHAT_VERSION,
    type: 'leave',
    from: peerId,
    timestamp: Date.now(),
  });
}

export function parseChatEvent(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed?.protocol !== CHAT_PROTOCOL ||
      Number(parsed?.version) !== CHAT_VERSION
    ) {
      return null;
    }
    const type = String(parsed?.type || 'message');
    const from = String(parsed.from || 'unknown');
    const timestamp = Number(parsed.timestamp) || 0;
    if (type === 'join') {
      return { type: 'join', from, text: `Peer joined: ${from.slice(0, 16)}`, timestamp };
    }
    if (type === 'leave') {
      return { type: 'leave', from, text: `Peer left: ${from.slice(0, 16)}`, timestamp };
    }
    return {
      type: 'message',
      from,
      text: String(parsed.text || ''),
      timestamp,
    };
  } catch {
    return null;
  }
}

export function parseChatMessage(raw) {
  const ev = parseChatEvent(raw);
  if (!ev || ev.type !== 'message') return null;
  return {
    from: ev.from,
    text: ev.text,
    timestamp: ev.timestamp,
  };
}
