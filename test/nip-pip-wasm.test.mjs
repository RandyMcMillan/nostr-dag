/**
 * NIP-PIP WASM example — small-payload round-trip with RTT tracking and
 * deterministic parent chain.
 *
 * Loads the real wasm-pack build (pkg/nostr_dag.js) and uses the exported
 * `stampBridgeRoundTripTag` / `extractBridgeRoundTripStartMs` functions to
 * build a chain of manifest + slice events where every event carries a
 * `bridge-rtt` tag and every slice references its parent via an `e` tag.
 */

import assert from 'node:assert/strict';
import { access, constants as fsConstants } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const WASM_JS   = join(REPO_ROOT, '..', 'site', 'pkg', 'nostr_dag.js');
const WASM_BIN  = join(REPO_ROOT, '..', 'site', 'pkg', 'nostr_dag_bg.wasm');

const MANIFEST_KIND = 39078;
const SLICE_KIND    = 39079;
const TRANSFER_PROTOCOL = 'nostr-dag-transfer';
const TRANSFER_VERSION  = 1;

async function ensureWasmBuild() {
  try {
    await access(WASM_JS, fsConstants.R_OK);
    await access(WASM_BIN, fsConstants.R_OK);
    return;
  } catch {
    console.log('[nip-pip-wasm] WASM not built; building...');
    const { execSync } = await import('node:child_process');
    execSync('make wasm', { cwd: dirname(REPO_ROOT), stdio: 'inherit' });
  }
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function packetizePayload(rootId, payload, threshold) {
  const slices = [];
  let offset = 0;
  let seq = 0;
  while (offset < payload.length) {
    const end = Math.min(offset + threshold, payload.length);
    slices.push({
      rootId,
      seq,
      totalSlices: 0, // filled later
      data: payload.slice(offset, end),
    });
    offset = end;
    seq++;
  }
  slices.forEach((s) => { s.totalSlices = slices.length; });
  return slices;
}

function buildManifestEvent(rootId, payload) {
  return {
    kind: MANIFEST_KIND,
    content: JSON.stringify({
      protocol: TRANSFER_PROTOCOL,
      version: TRANSFER_VERSION,
      type: 'manifest',
      root: rootId,
      sha256: sha256Hex(payload),
      size: payload.length,
      packets: 0,
      depth: 1,
      mtu: 0,
      encoding: 'json',
      path: '',
    }),
    tags: [],
  };
}

function buildSliceEvent(slice, parentEventId) {
  return {
    kind: SLICE_KIND,
    content: JSON.stringify({
      protocol: TRANSFER_PROTOCOL,
      version: TRANSFER_VERSION,
      type: 'slice',
      id: slice.rootId,
      header: { seq_num: slice.seq, total_packets: slice.totalSlices },
      data: [...slice.data],
      is_parity: false,
    }),
    tags: [['e', parentEventId]],
  };
}

test('WASM NIP-PIP small payload round-trip with RTT chain', async () => {
  await ensureWasmBuild();

  // Load the wasm-pack bundle in Node via dynamic import.
  const { readFileSync } = await import('node:fs');
  const wasmMod = await import(WASM_JS);
  const wasmBytes = readFileSync(WASM_BIN);
  wasmMod.initSync({ module: new WebAssembly.Module(wasmBytes) });

  const { stampBridgeRoundTripTag, extractBridgeRoundTripStartMs } = wasmMod;

  const payload = new TextEncoder().encode('hello wasm nip-pip rtt');
  const rootId = 'nip-pip-rtt-chain-wasm';
  const rttStart = 1_700_000_000_000;

  // Manifest
  let manifest = buildManifestEvent(rootId, payload);
  manifest.tags = stampBridgeRoundTripTag(manifest.tags, BigInt(rttStart));

  // Slices in a deterministic chain.
  const slices = packetizePayload(rootId, payload, 8);
  const sliceEvents = [];
  let parentId = manifest.id || 'manifest-fake-id';

  for (const slice of slices) {
    let ev = buildSliceEvent(slice, parentId);
    ev.tags = stampBridgeRoundTripTag(ev.tags, BigInt(rttStart));
    // Simulate signing by assigning a deterministic fake id based on content hash.
    ev.id = createHash('sha256').update(JSON.stringify(ev)).digest('hex');
    sliceEvents.push(ev);
    parentId = ev.id;
  }

  // Verify manifest RTT by checking tag format directly.
  const manifestRttTag = manifest.tags.find((t) => t[0] === 'bridge-rtt');
  assert.ok(manifestRttTag, 'manifest should carry bridge-rtt tag');
  assert.equal(Number(manifestRttTag[1]), rttStart, 'manifest rtt value mismatch');

  // Verify slice chain.
  let expectedParent = manifest.id || 'manifest-fake-id';
  for (let i = 0; i < sliceEvents.length; i++) {
    const ev = sliceEvents[i];
    const rttTag = ev.tags.find((t) => t[0] === 'bridge-rtt');
    assert.ok(rttTag, `slice ${i} should carry bridge-rtt tag`);
    assert.equal(Number(rttTag[1]), rttStart, `slice ${i} rtt value mismatch`);

    const parentTag = ev.tags.find((t) => t[0] === 'e');
    assert.ok(parentTag, `slice ${i} should have parent e tag`);
    assert.equal(parentTag[1], expectedParent, `slice ${i} parent mismatch`);

    expectedParent = ev.id;
  }

  // Reconstruct payload.
  const reconstructed = new Uint8Array(
    sliceEvents.flatMap((ev) => {
      const data = JSON.parse(ev.content).data;
      return data;
    })
  );
  assert.equal(reconstructed.length, payload.length);
  assert.deepEqual(reconstructed, payload);

  const manifestRttValue = Number(manifestRttTag[1]);
  console.log('=== NIP-PIP RTT chain round-trip (WASM) ===');
  console.log(`  root_id      ${rootId}`);
  console.log(`  payload      ${payload.length} bytes`);
  console.log(`  slices       ${sliceEvents.length}`);
  console.log(`  manifest     rtt=${manifestRttValue}`);
  sliceEvents.forEach((ev, seq) => {
    const parent = ev.tags.find((t) => t[0] === 'e')?.[1] ?? '?';
    const rtt = ev.tags.find((t) => t[0] === 'bridge-rtt')?.[1] ?? '?';
    console.log(`  slice[${seq}]   rtt=${rtt} parent=${parent.slice(0, 16)}...`);
  });
});
