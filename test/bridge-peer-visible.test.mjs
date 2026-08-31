/**
 * Verify the bridge page can see the local embedded peer via /peers endpoint.
 * This proves the server is exposing peer info and the bridge UI can render it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.SERVER_URL || 'http://127.0.0.1:3000';

test('bridge page lists local embedded peer', { timeout: 10_000 }, async () => {
  const res = await fetch(`${BASE}/peers`);
  assert.strictEqual(res.status, 200);
  const peers = await res.json();
  assert.ok(Array.isArray(peers), 'peers should be an array');
  assert.ok(peers.length >= 1, 'peers should not be empty');

  const localPeer = peers.find((p) => p.source === 'localhost');
  assert.ok(localPeer, 'should have a localhost peer (embedded native peer)');
  assert.ok(localPeer.peer_id, 'local peer should have a peer_id');
  assert.strictEqual(localPeer.kind, 'native', 'local peer should be native');

  const wellKnown = peers.find((p) => p.source === 'well-known');
  assert.ok(wellKnown, 'should have a well-known peer (gh-pages)');
});
