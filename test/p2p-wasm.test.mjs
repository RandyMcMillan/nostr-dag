/**
 * Tests for the WASM P2pNode binding surface.
 *
 * The WASM binary is not loaded here.  Instead we exercise the JavaScript
 * contract: the P2pNode constructor, `on_message` callback registration, and
 * the `broadcast` / message-delivery round-trip, using a minimal mock that
 * mirrors the wasm_bindgen-generated class shape defined in src/p2p.rs.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

// ---------------------------------------------------------------------------
// Minimal P2pNode mock — mirrors the wasm_bindgen class shape
// ---------------------------------------------------------------------------

class P2pNode {
  constructor() {
    this._callbacks = [];
    this._outbox = [];
    this._started = false;
  }

  /** Register a callback for inbound messages. */
  on_message(cb) {
    this._callbacks.push(cb);
  }

  /** Start the swarm event loop (mocked: records that start was called). */
  async start() {
    this._started = true;
  }

  /** Publish a message (mocked: stores in outbox and delivers to callbacks). */
  async broadcast(msg) {
    this._outbox.push(msg);
    // Simulate loopback delivery (what a real gossipsub peer would do when
    // there are no other peers — useful for unit testing the callback path).
    for (const cb of this._callbacks) {
      cb(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('P2pNode constructor creates a node with no callbacks', () => {
  const node = new P2pNode();
  assert.equal(node._callbacks.length, 0);
  assert.equal(node._started, false);
});

test('on_message registers a callback', () => {
  const node = new P2pNode();
  let received = null;
  node.on_message((msg) => { received = msg; });
  assert.equal(node._callbacks.length, 1);
  assert.equal(received, null); // not called yet
});

test('start() sets _started to true', async () => {
  const node = new P2pNode();
  await node.start();
  assert.equal(node._started, true);
});

test('broadcast() invokes the on_message callback', async () => {
  const node = new P2pNode();
  const received = [];
  node.on_message((msg) => received.push(msg));
  await node.start();
  await node.broadcast('hello from test');
  assert.deepEqual(received, ['hello from test']);
});

test('broadcast() stores message in outbox', async () => {
  const node = new P2pNode();
  await node.broadcast('msg-1');
  await node.broadcast('msg-2');
  assert.deepEqual(node._outbox, ['msg-1', 'msg-2']);
});

test('multiple on_message callbacks are all invoked', async () => {
  const node = new P2pNode();
  const log1 = [];
  const log2 = [];
  node.on_message((m) => log1.push(m));
  node.on_message((m) => log2.push(m));
  await node.broadcast('ping');
  assert.deepEqual(log1, ['ping']);
  assert.deepEqual(log2, ['ping']);
});

test('broadcast messages match the nostr-dag-bridge envelope shape', async () => {
  const node = new P2pNode();
  const received = [];
  node.on_message((msg) => received.push(JSON.parse(msg)));

  const envelope = {
    protocol: 'nostr-dag-bridge',
    version: '1',
    direction: 'outbound',
    event: { id: 'a'.repeat(64), kind: 21000 },
    relay_hints: [],
  };

  await node.broadcast(JSON.stringify(envelope));

  assert.equal(received.length, 1);
  assert.equal(received[0].protocol, 'nostr-dag-bridge');
  assert.equal(received[0].direction, 'outbound');
  assert.equal(received[0].event.id.length, 64);
});

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

test('wasm deterministic seed label hashes are stable', () => {
  assert.equal(
    sha256Hex('nostr-dag-native'),
    '0401a34dbb8fd5fee2ffd914b184de1b89e78df8c76b68b01cf941570be8b872',
  );
  assert.equal(
    sha256Hex('nostr-dag-wasm'),
    '3870cd6b88012214ab72801833c63ff224a18ac7e859c489df7be554bf88c78a',
  );
});
