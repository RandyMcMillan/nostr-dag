/**
 * nostr-dag chat protocol — shared wire format for peer-to-peer chat.
 *
 * Message types:
 *   message  — regular text payload
 *   join     — peer entered the chat
 *   leave    — peer left the chat
 *   ping     — request RTT measurement
 *   pong     — reply to ping
 *
 * All messages carry the same envelope:
 *   {"protocol":"nostr-dag-chat","version":1,"type":"...",
 *    "from":"<peer_id>","timestamp":<unix_ms>,"text":"..."}
 */

export const CHAT_PROTOCOL = 'nostr-dag-chat';
export const CHAT_VERSION = 1;

export function buildChatMessage(peerId, text, git = null) {
  const payload = {
    protocol: CHAT_PROTOCOL,
    version: CHAT_VERSION,
    type: 'message',
    from: peerId,
    text,
    timestamp: Date.now(),
  };
  if (git && typeof git === 'object' && git.repo && git.type) {
    payload.git = git;
  }
  return JSON.stringify(payload);
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

export function buildChatPing(peerId, pingId, timestamp = Date.now()) {
  return JSON.stringify({
    protocol: CHAT_PROTOCOL,
    version: CHAT_VERSION,
    type: 'ping',
    from: peerId,
    pingId,
    timestamp,
  });
}

export function buildChatPong(peerId, pingId, timestamp = Date.now()) {
  return JSON.stringify({
    protocol: CHAT_PROTOCOL,
    version: CHAT_VERSION,
    type: 'pong',
    from: peerId,
    pingId,
    timestamp,
  });
}

const GIT_TYPES = new Set(['repo', 'branch', 'tag', 'commit', 'file', 'blame']);

export function parseGitContext(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const repo = String(raw.repo || '').trim();
  const type = String(raw.type || '').trim();
  if (!repo || !GIT_TYPES.has(type)) return null;
  const ctx = { repo, type };
  if (raw.branch) ctx.branch = String(raw.branch);
  if (raw.tag) ctx.tag = String(raw.tag);
  if (raw.commit) ctx.commit = String(raw.commit);
  if (raw.path) ctx.path = String(raw.path);
  return ctx;
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
    const git = parseGitContext(parsed.git);
    if (type === 'join') {
      return { type: 'join', from, text: `Peer joined: ${from.slice(0, 16)}`, timestamp };
    }
    if (type === 'leave') {
      return { type: 'leave', from, text: `Peer left: ${from.slice(0, 16)}`, timestamp };
    }
    if (type === 'ping') {
      return { type: 'ping', from, text: `Ping from ${from.slice(0, 16)}`, timestamp, pingId: parsed.pingId };
    }
    if (type === 'pong') {
      return { type: 'pong', from, text: `Pong from ${from.slice(0, 16)}`, timestamp, pingId: parsed.pingId };
    }
    const result = {
      type: 'message',
      from,
      text: String(parsed.text || ''),
      timestamp,
    };
    if (git) result.git = git;
    return result;
  } catch {
    return null;
  }
}

export function parseChatMessage(raw) {
  const ev = parseChatEvent(raw);
  if (!ev || ev.type !== 'message') return null;
  const result = {
    from: ev.from,
    text: ev.text,
    timestamp: ev.timestamp,
  };
  if (ev.git) result.git = ev.git;
  return result;
}
