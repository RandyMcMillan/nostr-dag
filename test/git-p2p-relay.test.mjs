/**
 * GitP2PTransport relay-path unit tests
 *
 * Verifies that the browser transport can receive NIP-PIP manifests and slices
 * directly from Nostr relay events (kind 39078/39079) without bridge envelopes.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { GitP2PTransport } from '../demo/shared/git-p2p-transport.mjs';

const MANIFEST_KIND = 39078;
const SLICE_KIND = 39079;
const PIP_PROTOCOL = 'nostr-dag-transfer';
const PIP_VERSION = 1;

function buildManifestEvent({ rootId, totalBytes, totalSlices, path }) {
  return {
    kind: MANIFEST_KIND,
    id: `manifest-${rootId}`,
    pubkey: 'pubkey-relay',
    sig: 'sig-manifest',
    created_at: 1,
    content: JSON.stringify({
      protocol: PIP_PROTOCOL,
      version: PIP_VERSION,
      type: 'manifest',
      root: rootId,
      size: totalBytes,
      packets: totalSlices,
      depth: 1,
      mtu: 1024,
      encoding: 'json',
      path,
    }),
    tags: [['t', 'nostr-dag'], ['t', 'nip-pip']],
  };
}

function buildSliceEvent({ rootId, seq, totalSlices, data, manifestEventId }) {
  return {
    kind: SLICE_KIND,
    id: `slice-${rootId}-${seq}`,
    pubkey: 'pubkey-relay',
    sig: 'sig-slice',
    created_at: 1,
    content: JSON.stringify({
      protocol: PIP_PROTOCOL,
      version: PIP_VERSION,
      type: 'slice',
      id: `${rootId}-${seq}`,
      header: { seq_num: seq, total_packets: totalSlices },
      data: [...data],
      is_parity: false,
    }),
    tags: [['e', manifestEventId], ['t', 'nostr-dag'], ['t', 'nip-pip']],
  };
}

function buildPayload(size) {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 7 + 0xAB) & 0xff;
  return buf;
}

test('GitP2PTransport indexes relay manifest without bridge envelope', () => {
  const transport = new GitP2PTransport({ node: null, relays: [] });
  transport.start();

  const repoUrl = 'https://github.com/relay/test';
  const manifestEvent = buildManifestEvent({
    rootId: 'relay-root-1',
    totalBytes: 256,
    totalSlices: 2,
    path: repoUrl,
  });

  transport.handleNostrEvent(manifestEvent);

  assert.equal(transport.hasRepo(repoUrl), true, 'relay manifest should be indexed');
  assert.equal(transport.manifests.get(repoUrl).packets, 2);
});

test('GitP2PTransport reconstructs payload from relay events', async () => {
  const transport = new GitP2PTransport({ node: null, relays: [] });
  transport.start();

  const repoUrl = 'https://github.com/relay/test2';
  const payload = buildPayload(256);
  const totalSlices = 2;
  const rootId = 'relay-root-2';

  const manifestEvent = buildManifestEvent({
    rootId,
    totalBytes: payload.length,
    totalSlices,
    path: repoUrl,
  });

  transport.handleNostrEvent(manifestEvent);

  for (let seq = 0; seq < totalSlices; seq++) {
    const start = seq * 128;
    const end = Math.min(start + 128, payload.length);
    const sliceEvent = buildSliceEvent({
      rootId,
      seq,
      totalSlices,
      data: payload.slice(start, end),
      manifestEventId: manifestEvent.id,
    });
    transport.handleNostrEvent(sliceEvent);
  }

  const result = await transport.requestBundle(repoUrl, 5000);
  assert.equal(result.length, payload.length);
  assert.deepEqual(result, payload);
});

test('GitP2PTransport ignores non-PIP relay events', () => {
  const transport = new GitP2PTransport({ node: null, relays: [] });
  transport.start();

  transport.handleNostrEvent({
    kind: 1,
    id: 'note-1',
    pubkey: 'pk',
    content: 'hello',
    tags: [],
  });

  assert.equal(transport.manifests.size, 0);
  assert.equal(transport.slices.size, 0);
});
