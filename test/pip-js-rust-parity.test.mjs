/**
 * WASM<->Rust functional parity test — wire format compatibility.
 *
 * Verifies that the JS `parseTransferEvent` and `reconstructPayload` can
 * handle slices produced by the Rust `encode_payload_as_transfer_events_chained`
 * format (root, size, packets, header.seq_num, header.total_packets, is_parity).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseTransferEvent, reconstructPayload } from '../demo/shared/nip34-quorum.mjs';

const MANIFEST_KIND = 39078;
const SLICE_KIND = 39079;

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function buildRustFormatManifestEvent({ rootId, totalBytes, totalSlices, sha256 }) {
  return {
    kind: MANIFEST_KIND,
    id: `manifest-${rootId}`,
    pubkey: 'pubkey-1',
    sig: 'sig-manifest',
    created_at: 1,
    content: JSON.stringify({
      protocol: 'nostr-dag-transfer',
      version: 1,
      type: 'manifest',
      root: rootId,
      sha256,
      size: totalBytes,
      packets: totalSlices,
      depth: 1,
      mtu: 8,
      encoding: 'json',
      path: '',
    }),
    tags: [],
  };
}

function buildRustFormatSliceEvent({ rootId, seq, totalSlices, data, manifestEventId }) {
  return {
    kind: SLICE_KIND,
    id: `slice-${rootId}-${seq}`,
    pubkey: 'pubkey-1',
    sig: 'sig-slice',
    created_at: 1,
    content: JSON.stringify({
      protocol: 'nostr-dag-transfer',
      version: 1,
      type: 'slice',
      id: rootId,
      header: { seq_num: seq, total_packets: totalSlices },
      data: [...data],
      is_parity: false,
    }),
    tags: [['e', manifestEventId]],
  };
}

function packetizeLikeRust(rootId, payload, threshold) {
  const chunkSize = Math.max(1, threshold);
  const totalSlices = Math.max(1, Math.ceil(payload.length / chunkSize));
  const slices = [];
  for (let seq = 0; seq < totalSlices; seq++) {
    const start = seq * chunkSize;
    const end = Math.min(start + chunkSize, payload.length);
    slices.push({ rootId, seq, totalSlices, data: payload.slice(start, end) });
  }
  return slices;
}

test('JS parser handles Rust-format manifest and slices', () => {
  const payload = new TextEncoder().encode('wasm rust parity test payload');
  const rootId = 'parity-root-rust';
  const threshold = 8;
  const referenceSha = sha256Hex(payload);

  const slices = packetizeLikeRust(rootId, payload, threshold);
  const manifestEvent = buildRustFormatManifestEvent({
    rootId,
    totalBytes: payload.length,
    totalSlices: slices.length,
    sha256: referenceSha,
  });

  const parsedManifest = parseTransferEvent(manifestEvent);
  assert.ok(parsedManifest, 'manifest should parse');
  assert.equal(parsedManifest.kind, 'manifest');
  assert.equal(parsedManifest.rootId, rootId);
  assert.equal(parsedManifest.size, payload.length);
  assert.equal(parsedManifest.packets, slices.length);

  const sliceEvents = slices.map((s) =>
    buildRustFormatSliceEvent({
      rootId,
      seq: s.seq,
      totalSlices: s.totalSlices,
      data: s.data,
      manifestEventId: manifestEvent.id,
    })
  );

  const parsedSlices = sliceEvents.map((ev) => parseTransferEvent(ev));
  const reconstructed = reconstructPayload(parsedManifest, parsedSlices);

  assert.ok(reconstructed, 'reconstruction should succeed');
  assert.equal(reconstructed.length, payload.length);
  assert.deepEqual(reconstructed, payload);

  console.log('=== WASM<->Rust parity (JS parse Rust format) ===');
  console.log(`  root_id      ${rootId}`);
  console.log(`  payload      ${payload.length} bytes`);
  console.log(`  slices       ${slices.length}`);
  console.log(`  reconstructed ${reconstructed.length} bytes`);
});
