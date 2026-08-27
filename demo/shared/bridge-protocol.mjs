export const BRIDGE_PROTOCOL = 'nostr-dag-bridge';
export const BRIDGE_PROTOCOL_VERSION = 1;

export function collectBridgeRelayHints(value, found = new Set()) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) found.add(trimmed);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectBridgeRelayHints(item, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectBridgeRelayHints(item, found);
  }
  return found;
}

export function buildBridgeEnvelope(event, direction, relayHints = [], meta = {}) {
  return {
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_PROTOCOL_VERSION,
    direction,
    event,
    relay_hints: [...new Set(relayHints.filter(Boolean))],
    topic: meta.topic || '',
    origin_peer_id: meta.originPeerId || '',
    forwarded_by: meta.forwardedBy || '',
    hop_count: Number.isFinite(Number(meta.hopCount)) ? Number(meta.hopCount) : 0,
    ts: Date.now(),
  };
}

export function unwrapBridgeEnvelope(message) {
  if (!message || typeof message !== 'object') return null;
  if (isNostrEvent(message)) {
    return {
      event: message,
      relayHints: [],
      direction: 'libp2p->nostr',
      originPeerId: '',
      forwardedBy: '',
      hopCount: 0,
    };
  }
  const protocol = message.protocol || message.source;
  const event = message.event || message.payload?.event || message.payload || null;
  const relayHints = [
    ...collectBridgeRelayHints(message.relay_hints),
    ...collectBridgeRelayHints(message.relayHints),
    ...collectBridgeRelayHints(message.relays),
    ...collectBridgeRelayHints(message.relayTargets),
  ];
  if (protocol && protocol !== BRIDGE_PROTOCOL && protocol !== 'nostr-dag-bridge') {
    return null;
  }
  if (!event || !isNostrEvent(event)) return null;
  return {
    event,
    relayHints,
    direction: message.direction || 'libp2p->nostr',
    originPeerId: String(message.origin_peer_id || message.originPeerId || ''),
    forwardedBy: String(message.forwarded_by || message.forwardedBy || ''),
    hopCount: Number.isFinite(Number(message.hop_count)) ? Number(message.hop_count) : 0,
  };
}

function isNostrEvent(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.pubkey === 'string' &&
    typeof value.sig === 'string' &&
    typeof value.content === 'string' &&
    Array.isArray(value.tags) &&
    Number.isFinite(Number(value.kind)) &&
    Number.isFinite(Number(value.created_at))
  );
}
