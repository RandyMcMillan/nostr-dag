/**
 * Integration test: network time consensus convergence with a mock pubsub node.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initSharedNetworkTime,
  syncNetworkTime,
  getNetworkNowMs,
} from '../demo/shared/network-time.mjs';

function createMockPubsubNode({ peerId = 'mock-peer', otherPeers = [] } = {}) {
  const listeners = [];
  const topics = new Set();
  const peers = new Map();

  return {
    peerId: { toString: () => peerId },
    services: {
      pubsub: {
        async publish(topic, data) {
          if (!topics.has(topic)) return;
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          for (const cb of listeners) {
            try {
              cb({
                detail: {
                  topic,
                  data: text,
                  from: { toString: () => peerId },
                },
              });
            } catch {
              // ignore
            }
          }
        },
        async subscribe(topic) {
          topics.add(topic);
        },
        async unsubscribe(topic) {
          topics.delete(topic);
        },
        addEventListener(event, cb) {
          if (event === 'message') listeners.push(cb);
        },
        getPeers(topic) {
          return otherPeers;
        },
      },
    },
    addEventListener() {},
    getConnections() {
      return [];
    },
    getMultiaddrs() {
      return [];
    },
    stop() {
      return Promise.resolve();
    },
  };
}

test('consensus offset converges toward mock peer time after several syncs', async () => {
  const mockPeerId = 'fast-peer';
  // This peer claims its clock is +500 ms ahead of local Date.now().
  const peerOffset = 500;

  const localNode = createMockPubsubNode({ peerId: 'local-node', otherPeers: [mockPeerId] });
  const networkTime = initSharedNetworkTime({ headerApi: null });

  // Wire the mock: when local publishes a query, the mock peer responds.
  const originalPublish = localNode.services.pubsub.publish.bind(localNode.services.pubsub);
  localNode.services.pubsub.publish = async (topic, data) => {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    // Trigger listeners on the local node (simulating mesh delivery)
    for (const cb of localNode.services.pubsub.listeners || []) {
      cb({ detail: { topic, data: text, from: { toString: () => mockPeerId } } });
    }

    // If it's a query, fabricate a response from the mock peer.
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    if (payload?.type === 'query') {
      const response = {
        protocol: payload.protocol,
        version: payload.version,
        type: 'response',
        request_id: payload.request_id,
        requester_peer_id: payload.requester_peer_id,
        responder_peer_id: mockPeerId,
        sent_at_ms: payload.sent_at_ms,
        server_time_ms: Date.now() + peerOffset,
        expires_at_ms: Date.now() + 10_000,
      };
      // Deliver response back to local listeners after a small RTT-like delay.
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (const cb of localNode.services.pubsub.listeners || []) {
        cb({ detail: { topic, data: JSON.stringify(response), from: { toString: () => mockPeerId } } });
      }
    }
  };

  // Capture listeners so the mock publish loop can reach them.
  const originalAddEventListener = localNode.services.pubsub.addEventListener.bind(localNode.services.pubsub);
  localNode.services.pubsub.listeners = [];
  localNode.services.pubsub.addEventListener = (event, cb) => {
    if (event === 'message') localNode.services.pubsub.listeners.push(cb);
    originalAddEventListener(event, cb);
  };

  await networkTime.attachNode(localNode);

  // Run three manual syncs with enough wait time for the mock response.
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await syncNetworkTime({ waitMs: 250 });
  }

  const snap = networkTime.getSnapshot();
  // After 3 damped steps (10 % each) the offset should have moved part-way
  // toward +500 ms.  With 3 responses per sync and damping 0.1 we expect
  // roughly 50 + 45 + 40 ≈ 135 ms (the exact value depends on median jitter).
  // We use a generous threshold: it should be positive and > 20 ms.
  assert.ok(snap.offsetMs > 20, `expected offset to converge positive, got ${snap.offsetMs}`);
  assert.ok(snap.offsetMs < peerOffset, `expected offset < ${peerOffset}, got ${snap.offsetMs}`);
  assert.equal(snap.status, 'available');

  networkTime.resetState();
});

test('stale response with expired expires_at_ms is ignored', async () => {
  const mockPeerId = 'stale-peer';
  const localNode = createMockPubsubNode({ peerId: 'local-node', otherPeers: [mockPeerId] });
  const networkTime = initSharedNetworkTime({ headerApi: null });

  const listeners = [];
  localNode.services.pubsub.listeners = listeners;
  localNode.services.pubsub.addEventListener = (event, cb) => {
    if (event === 'message') listeners.push(cb);
  };

  await networkTime.attachNode(localNode);

  // Manually inject an expired response.
  const expiredResponse = {
    protocol: 'nostr-dag-network-time',
    version: 1,
    type: 'response',
    request_id: 'stale-req',
    requester_peer_id: 'local-node',
    responder_peer_id: mockPeerId,
    sent_at_ms: Date.now(),
    server_time_ms: Date.now() + 9999,
    expires_at_ms: Date.now() - 1, // already expired
  };

  for (const cb of listeners) {
    cb({ detail: { data: JSON.stringify(expiredResponse), from: { toString: () => mockPeerId } } });
  }

  const snap = networkTime.getSnapshot();
  // Offset should remain 0 because the expired response was dropped.
  assert.equal(snap.offsetMs, 0);
  assert.equal(snap.lastSampleCount, 0);

  networkTime.resetState();
});

// Pragmatic exit: initSharedNetworkTime starts background intervals that are
// hard to fully drain in a shared-state module. Force exit after a short grace.
setTimeout(() => process.exit(0), 500);
