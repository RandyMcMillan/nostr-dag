/**
 * GitP2PTransport unit test
 *
 * Exercises the browser-side git transport over libp2p gossipsub using a
 * mock libp2p node.  Verifies manifest indexing, slice accumulation, and
 * payload reconstruction without requiring a real browser or WASM binary.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { GitP2PTransport } from '../demo/shared/git-p2p-transport.mjs';
import { encodeBridgeMessage } from '../demo/shared/bridge-protocol.mjs';

const MANIFEST_KIND = 39078;
const SLICE_KIND    = 39079;
const PIP_PROTOCOL  = 'nostr-dag-transfer';
const PIP_VERSION   = 1;

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function createMockNode() {
  const listeners = new Map();
  return {
    services: {
      pubsub: {
        subscribe() {},
        addEventListener(type, handler) {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type).add(handler);
        },
        _emit(type, detail) {
          for (const handler of listeners.get(type) || []) {
            handler({ detail });
          }
        },
      },
    },
  };
}

function buildManifestEvent({ rootId, totalBytes, totalSlices, path }) {
  return {
    kind: MANIFEST_KIND,
    id: `manifest-${rootId}`,
    pubkey: 'pubkey-1',
    sig: 'sig-manifest',
    created_at: 1,
    content: JSON.stringify({
      protocol: PIP_PROTOCOL,
      version: PIP_VERSION,
      type: 'manifest',
      root_id: rootId,
      total_bytes: totalBytes,
      total_slices: totalSlices,
      path,
    }),
    tags: [],
  };
}

function buildSliceEvent({ rootId, seq, totalSlices, data, manifestEventId }) {
  return {
    kind: SLICE_KIND,
    id: `slice-${rootId}-${seq}`,
    pubkey: 'pubkey-1',
    sig: 'sig-slice',
    created_at: 1,
    content: JSON.stringify({
      protocol: PIP_PROTOCOL,
      version: PIP_VERSION,
      type: 'slice',
      root_id: rootId,
      seq,
      total_slices: totalSlices,
      data: [...data],
    }),
    tags: [['e', manifestEventId]],
  };
}

function buildPayload(size) {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 7 + 0xAB) & 0xff;
  return buf;
}

test('GitP2PTransport indexes manifest and reconstructs payload', async () => {
  const node = createMockNode();
  const logs = [];
  const transport = new GitP2PTransport({
    node,
    onLog: (level, message) => logs.push({ level, message }),
  });
  transport.start();

  const repoUrl = 'https://github.com/test/repo';
  const payload = buildPayload(512);
  const sliceSize = 128;
  const totalSlices = Math.ceil(payload.length / sliceSize);
  const rootId = 'test-root-1';

  const manifestEvent = buildManifestEvent({
    rootId,
    totalBytes: payload.length,
    totalSlices,
    path: repoUrl,
  });

  // Emit manifest through mock pubsub as a bridge envelope
  node.services.pubsub._emit('message', {
    data: encodeBridgeMessage(manifestEvent, 'libp2p->nostr'),
  });

  assert.equal(transport.hasRepo(repoUrl), true, 'manifest should be indexed');

  // Emit slices
  for (let seq = 0; seq < totalSlices; seq++) {
    const start = seq * sliceSize;
    const end = Math.min(start + sliceSize, payload.length);
    const sliceEvent = buildSliceEvent({
      rootId,
      seq,
      totalSlices,
      data: payload.slice(start, end),
      manifestEventId: manifestEvent.id,
    });
    node.services.pubsub._emit('message', {
      data: encodeBridgeMessage(sliceEvent, 'libp2p->nostr'),
    });
  }

  const result = await transport.requestBundle(repoUrl, 5000);
  assert.equal(result.length, payload.length, 'reconstructed length mismatch');
  assert.deepEqual(result, payload, 'bit-for-bit mismatch');
  assert.equal(sha256Hex(result), sha256Hex(payload), 'SHA-256 mismatch');
});

test('GitP2PTransport cache hit returns immediately', async () => {
  const node = createMockNode();
  const transport = new GitP2PTransport({ node });
  transport.start();

  const repoUrl = 'https://github.com/test/repo2';
  const payload = buildPayload(256);
  const totalSlices = 2;
  const rootId = 'test-root-2';

  const manifestEvent = buildManifestEvent({
    rootId,
    totalBytes: payload.length,
    totalSlices,
    path: repoUrl,
  });

  node.services.pubsub._emit('message', {
    data: encodeBridgeMessage(manifestEvent, 'libp2p->nostr'),
  });

  for (let seq = 0; seq < totalSlices; seq++) {
    const sliceEvent = buildSliceEvent({
      rootId,
      seq,
      totalSlices,
      data: payload.slice(seq * 128, (seq + 1) * 128),
      manifestEventId: manifestEvent.id,
    });
    node.services.pubsub._emit('message', {
      data: encodeBridgeMessage(sliceEvent, 'libp2p->nostr'),
    });
  }

  // First request populates cache
  await transport.requestBundle(repoUrl, 1000);

  // Second request should be cache hit
  const logs = [];
  const transport2 = new GitP2PTransport({
    node,
    onLog: (level, message) => logs.push(message),
  });
  transport2.start();

  // Share the same indexed data by copying internal state (simulate same page)
  transport2.manifests = transport.manifests;
  transport2.slices = transport.slices;

  const result = await transport2.requestBundle(repoUrl, 1000);
  assert.ok(logs.some(m => m.includes('cache hit')), 'expected cache hit log');
  assert.deepEqual(result, payload);
});

test('GitP2PTransport requestBundle times out when slices missing', async () => {
  const node = createMockNode();
  const transport = new GitP2PTransport({ node });
  transport.start();

  const repoUrl = 'https://github.com/test/repo3';
  const manifestEvent = buildManifestEvent({
    rootId: 'test-root-3',
    totalBytes: 256,
    totalSlices: 4,
    path: repoUrl,
  });

  node.services.pubsub._emit('message', {
    data: encodeBridgeMessage(manifestEvent, 'libp2p->nostr'),
  });

  await assert.rejects(
    () => transport.requestBundle(repoUrl, 100),
    /timeout/
  );
});
