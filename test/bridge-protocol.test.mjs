import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRIDGE_PROTOCOL,
  BRIDGE_PROTOCOL_VERSION,
  buildBridgeEnvelope,
  decodeBridgeMessage,
  collectBridgeRelayHints,
  encodeBridgeMessage,
  unwrapBridgeEnvelope,
} from '../demo/shared/bridge-protocol.mjs';

function makeEvent(overrides = {}) {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    sig: 'c'.repeat(128),
    kind: 21000,
    created_at: 1_700_000_000,
    content: '{}',
    tags: [],
    ...overrides,
  };
}

test('collectBridgeRelayHints flattens and dedupes nested relay hints', () => {
  const hints = collectBridgeRelayHints([
    'wss://relay.one',
    ['wss://relay.two', 'wss://relay.one'],
    { relay: 'wss://relay.three', nested: ['wss://relay.two'] },
  ]);

  assert.deepEqual([...hints], ['wss://relay.one', 'wss://relay.two', 'wss://relay.three']);
});

test('buildBridgeEnvelope preserves bridge metadata and relay hints', () => {
  const event = makeEvent();
  const envelope = buildBridgeEnvelope(event, 'nostr->libp2p', ['wss://relay.one', 'wss://relay.two'], {
    topic: 'nostr/bridge',
    originPeerId: 'peer-a',
    forwardedBy: 'peer-b',
    hopCount: 3,
  });

  assert.equal(envelope.protocol, BRIDGE_PROTOCOL);
  assert.equal(envelope.version, BRIDGE_PROTOCOL_VERSION);
  assert.equal(envelope.direction, 'nostr->libp2p');
  assert.equal(envelope.topic, 'nostr/bridge');
  assert.equal(envelope.origin_peer_id, 'peer-a');
  assert.equal(envelope.forwarded_by, 'peer-b');
  assert.equal(envelope.hop_count, 3);
  assert.deepEqual(envelope.relay_hints, ['wss://relay.one', 'wss://relay.two']);
  assert.equal(envelope.event.id, event.id);
});

test('buildBridgeEnvelope does not mutate the caller relay hint array', () => {
  const hints = ['wss://relay.one', 'wss://relay.two'];
  const event = makeEvent();
  buildBridgeEnvelope(event, hints);
  assert.deepEqual(hints, ['wss://relay.one', 'wss://relay.two']);
});

test('encodeBridgeMessage and decodeBridgeMessage round-trip a bridge event', () => {
  const event = makeEvent();
  const json = encodeBridgeMessage(event, 'nostr->libp2p', ['wss://relay.one'], {
    topic: 'nostr/bridge',
    originPeerId: 'peer-a',
    forwardedBy: 'peer-b',
    hopCount: 2,
  });

  const parsed = decodeBridgeMessage(json);
  assert.ok(parsed);
  assert.equal(parsed.event.id, event.id);
  assert.equal(parsed.direction, 'nostr->libp2p');
  assert.equal(parsed.topic, 'nostr/bridge');
  assert.equal(parsed.originPeerId, 'peer-a');
  assert.equal(parsed.forwardedBy, 'peer-b');
  assert.equal(parsed.hopCount, 2);
});

test('unwrapBridgeEnvelope round-trips a bridge envelope', () => {
  const event = makeEvent();
  const envelope = buildBridgeEnvelope(event, 'nostr->libp2p', ['wss://relay.one'], {
    originPeerId: 'peer-a',
    forwardedBy: 'peer-b',
    hopCount: 2,
  });
  const parsed = unwrapBridgeEnvelope(envelope);

  assert.ok(parsed);
  assert.equal(parsed.event.id, event.id);
  assert.equal(parsed.direction, 'nostr->libp2p');
  assert.deepEqual(parsed.relayHints, ['wss://relay.one']);
  assert.equal(parsed.originPeerId, 'peer-a');
  assert.equal(parsed.forwardedBy, 'peer-b');
  assert.equal(parsed.hopCount, 2);
});

test('unwrapBridgeEnvelope accepts raw nostr events as libp2p payloads', () => {
  const event = makeEvent();
  const parsed = unwrapBridgeEnvelope(event);

  assert.ok(parsed);
  assert.equal(parsed.event.id, event.id);
  assert.equal(parsed.direction, 'libp2p->nostr');
  assert.deepEqual(parsed.relayHints, []);
});

test('unwrapBridgeEnvelope accepts legacy source values and rejects foreign protocols', () => {
  const event = makeEvent();
  const legacy = unwrapBridgeEnvelope({ source: 'nostr-dag-bridge', event });
  assert.ok(legacy);
  assert.equal(legacy.event.id, event.id);

  assert.equal(unwrapBridgeEnvelope({ protocol: 'other-bridge', event }), null);
  assert.equal(unwrapBridgeEnvelope({ protocol: BRIDGE_PROTOCOL, event: { id: 'x' } }), null);
});
