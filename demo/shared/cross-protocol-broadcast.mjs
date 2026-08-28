import { buildBridgeEnvelope, decodeBridgeMessage, encodeBridgeMessage } from './bridge-protocol.mjs';

export const DAG_BRIDGE_TOPIC = 'nostr/bridge';

export function buildDagBridgeEnvelope(event, relayHints = [], meta = {}) {
  return buildBridgeEnvelope(event, 'nostr->libp2p', relayHints, {
    ...meta,
    topic: meta.topic || DAG_BRIDGE_TOPIC,
  });
}

export function serializeDagBridgeEnvelope(event, relayHints = [], meta = {}) {
  return encodeBridgeMessage(event, 'nostr->libp2p', relayHints, {
    ...meta,
    topic: meta.topic || DAG_BRIDGE_TOPIC,
  });
}

export function decodeDagBridgeEnvelope(message) {
  return decodeBridgeMessage(message);
}

export function summarizeBroadcastEvents(events = []) {
  return events.map((event) => event?.id || '').filter(Boolean).join(', ');
}

export function summarizeBroadcastTargets(relayUrls = []) {
  return [...new Set(relayUrls.filter(Boolean))];
}
