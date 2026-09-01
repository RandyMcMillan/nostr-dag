/**
 * Verify the bridge page can see the local embedded peer via /peers endpoint.
 * This proves the server is exposing peer info and the bridge UI can render it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.SERVER_URL || process.env.BASE_URL || 'http://127.0.0.1:3000';

async function serverHealthy() {
  try {
    const res = await fetch(`${BASE}/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Core functionality test: the embedded native peer must be visible via /peers.
 *
 * NOTE: The server seeds the peer store with `source: "localhost"` BEFORE the
 * HTTP accept loop starts, so the peer should be present immediately. If this
 * test fails, it usually means:
 *   1. The server binary was built without `--features p2p`
 *   2. P2P_ENABLE was not set when the server started
 *   3. A bug in PeerStore::all() is filtering out the localhost entry
 */
test('bridge page lists local embedded peer', { timeout: 15_000 }, async (t) => {
  if (!(await serverHealthy())) {
    t.skip('nostr-dag-server not running — start it to run this test');
    return;
  }

  const peersRes = await fetch(`${BASE}/peers`);
  assert.strictEqual(peersRes.status, 200);
  const peers = await peersRes.json();
  assert.ok(Array.isArray(peers), 'peers should be an array');

  // Log the full response so devs can diagnose missing peers quickly.
  console.log('[bridge-peer-visible] /peers returned', peers.length, 'entries');
  console.log('[bridge-peer-visible] sources:', peers.map((p) => p.source || 'undefined'));
  console.log('[bridge-peer-visible] first entry:', peers[0]);

  // The well-known (static) peer is present immediately; the localhost peer
  // is seeded synchronously before the server accept loop, so it should also
  // be present immediately when the server is built with --features p2p.
  const wellKnown = peers.find((p) => p.source === 'well-known');
  assert.ok(wellKnown, 'should have a well-known peer (gh-pages)');

  // Poll /peers until the localhost peer materializes (defensive; should not
  // be necessary if the server is built with p2p features).
  let localPeer;
  let pollCount = 0;
  const deadline = Date.now() + 10_000;
  while (!localPeer && Date.now() < deadline) {
    const r = await fetch(`${BASE}/peers`);
    const list = await r.json();
    localPeer = list.find((p) => p.source === 'localhost');
    pollCount += 1;
    if (!localPeer) {
      console.log(`[bridge-peer-visible] poll ${pollCount}: no localhost peer yet (${list.length} total)`);
      await new Promise((res) => setTimeout(res, 500));
    }
  }

  console.log('[bridge-peer-visible] localPeer after', pollCount, 'polls:', localPeer);
  assert.ok(localPeer, 'should have a localhost peer (embedded native peer)');
  assert.ok(localPeer.peer_id, 'local peer should have a peer_id');
  assert.strictEqual(localPeer.kind, 'native', 'local peer should be native');
});
