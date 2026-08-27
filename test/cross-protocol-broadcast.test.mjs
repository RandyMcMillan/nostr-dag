import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DAG_BRIDGE_TOPIC,
  buildDagBridgeEnvelope,
  serializeDagBridgeEnvelope,
  summarizeBroadcastEvents,
  summarizeBroadcastTargets,
} from '../demo/shared/cross-protocol-broadcast.mjs';

function makeEvent(id) {
  return {
    id,
    pubkey: 'b'.repeat(64),
    sig: 'c'.repeat(128),
    kind: 0,
    created_at: 1_700_000_000,
    content: '{"name":"eve"}',
    tags: [],
  };
}

test('buildDagBridgeEnvelope targets the bridge topic and libp2p direction', () => {
  const event = makeEvent('a'.repeat(64));
  const envelope = buildDagBridgeEnvelope(event, ['wss://relay.one'], {
    forwardedBy: 'peer-a',
  });

  assert.equal(envelope.topic, DAG_BRIDGE_TOPIC);
  assert.equal(envelope.direction, 'nostr->libp2p');
  assert.equal(envelope.forwarded_by, 'peer-a');
  assert.deepEqual(envelope.relay_hints, ['wss://relay.one']);
});

test('serializeDagBridgeEnvelope emits parseable JSON with the full event id', () => {
  const event = makeEvent('f'.repeat(64));
  const json = serializeDagBridgeEnvelope(event, ['wss://relay.one', 'wss://relay.two'], {
    originPeerId: 'peer-b',
  });
  const parsed = JSON.parse(json);

  assert.equal(parsed.event.id, event.id);
  assert.equal(parsed.topic, DAG_BRIDGE_TOPIC);
  assert.equal(parsed.origin_peer_id, 'peer-b');
  assert.deepEqual(parsed.relay_hints, ['wss://relay.one', 'wss://relay.two']);
});

test('serializeDagBridgeEnvelope does not truncate ids in the serialized payload', () => {
  const event = makeEvent('1'.repeat(64));
  const json = serializeDagBridgeEnvelope(event);
  assert.match(json, new RegExp(event.id));
});

test('summarizeBroadcastEvents keeps full ids in order', () => {
  const ids = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
  const summary = summarizeBroadcastEvents(ids.map((id) => ({ id })));
  assert.equal(summary, ids.join(', '));
});

test('summarizeBroadcastTargets dedupes and filters empty relay urls', () => {
  const targets = summarizeBroadcastTargets([
    'wss://relay.one',
    '',
    'wss://relay.two',
    'wss://relay.one',
    null,
  ]);

  assert.deepEqual(targets, ['wss://relay.one', 'wss://relay.two']);
});
