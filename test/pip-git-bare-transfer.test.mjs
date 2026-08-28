/**
 * PIP git bare-repo transfer — WASM-path contract test.
 *
 * This test exercises the JavaScript side of the Perfect IP (PIP) transfer
 * protocol as it would run inside a browser WASM context.  No WASM binary is
 * loaded here; instead the transfer logic (packetize / reconstruct /
 * manifest+slice envelope format) is implemented directly in JS, matching the
 * wire contracts defined in PIP.md and implemented in src/p2p.rs.
 *
 * SHA-256 is computed with the Node.js built-in `node:crypto` module, which
 * is the same API available to browsers via `crypto.subtle.digest`.  The
 * digest results are compared to verify bit-for-bit accuracy after every
 * roundtrip, including multi-level depth transfers with many slice counts.
 *
 * Test structure
 * --------------
 * 1. Synthetic "git bare" payload — a deterministic binary blob built to
 *    resemble a git bundle header + pack data for DEPTH_LEVELS commit levels.
 * 2. packetize() — splits the payload into ordered PIP slices.
 * 3. buildManifestEnvelope() / buildSliceEnvelope() — wraps each chunk in the
 *    nostr-dag-transfer JSON envelope format (kinds 39078 / 39079).
 * 4. parseTransferEvent() — decodes and validates each envelope.
 * 5. reconstruct() — reassembles ordered slices into the original bytes.
 * 6. SHA-256 comparison between original and reconstructed bytes.
 * 7. Repeat at several slice granularities (depth levels).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from 'nostr-tools/pure';

// ---------------------------------------------------------------------------
// PIP constants (mirrors src/p2p.rs)
// ---------------------------------------------------------------------------

const TRANSFER_PROTOCOL  = 'nostr-dag-transfer';
const TRANSFER_VERSION   = 1;
const MANIFEST_KIND      = 39078;
const SLICE_KIND         = 39079;

/** Number of simulated commit-depth levels in the synthetic payload. */
const DEPTH_LEVELS = 10;

// ---------------------------------------------------------------------------
// SHA-256 helper
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 of a Uint8Array and return a lowercase hex string.
 *
 * Uses node:crypto — in a browser WASM context this maps to:
 *   const buf = await crypto.subtle.digest('SHA-256', bytes);
 *   Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeSignedTransferEvent(secretKey, kind, content, tags = []) {
  const unsigned = {
    kind,
    created_at: Math.floor(Date.now() / 1000),
    pubkey: getPublicKey(secretKey),
    content,
    tags,
  };
  const event = finalizeEvent(unsigned, secretKey);
  assert.equal(verifyEvent(event), true, 'transfer event signature must verify');
  return event;
}

function gitRun(args, cwd, extra = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...extra.env },
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed in ${cwd}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout.trim();
}

function logTree(root, label) {
  console.log(`${label} tree at ${root}`);

  function walk(dir, indent) {
    const entries = readdirSync(dir, { withFileTypes: true })
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    for (const name of entries) {
      const full = join(dir, name);
      const rel = full.slice(root.length + 1);
      const prefix = ' '.repeat(indent);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        console.log(`${prefix}${rel}/`);
        walk(full, indent + 2);
      } else {
        console.log(`${prefix}${rel} (${stat.size})`);
      }
    }
  }

  walk(root, 2);
}

// ---------------------------------------------------------------------------
// Synthetic "git bare" payload builder
//
// Produces a deterministic binary blob that structurally resembles a git
// bundle (magic bytes + pack header + per-level commit data).  This lets us
// test multi-level depth transfer without requiring git2 or an installed git
// binary in the JS test environment.
// ---------------------------------------------------------------------------

/**
 * Build a synthetic git-bare-like binary payload with `depth` ancestry levels.
 *
 * Layout (all values are ASCII/UTF-8 unless stated):
 *   4 bytes  — magic  "GITB"
 *   4 bytes  — version uint32 big-endian (1)
 *   4 bytes  — object count uint32 big-endian (depth)
 *   per level:
 *     4 bytes  — level index uint32 big-endian
 *    32 bytes  — simulated SHA-1 object id (repeated level-byte × 20, hex × 2)
 *   256 bytes  — simulated pack body for this level (deterministic pattern)
 *
 * @param {number} depth
 * @returns {Uint8Array}
 */
function buildSyntheticGitBarePayload(depth) {
  const MAGIC       = new TextEncoder().encode('GITB');
  const HEADER_SIZE = MAGIC.length + 4 + 4; // magic + version + count
  const LEVEL_SIZE  = 4 + 32 + 256;         // index + oid + pack-body

  const total = HEADER_SIZE + depth * LEVEL_SIZE;
  const buf   = new Uint8Array(total);
  const view  = new DataView(buf.buffer);

  // magic
  buf.set(MAGIC, 0);
  // version
  view.setUint32(4, 1, false);
  // object count
  view.setUint32(8, depth, false);

  let offset = HEADER_SIZE;
  for (let level = 0; level < depth; level++) {
    // level index
    view.setUint32(offset, level, false);
    offset += 4;

    // simulated 32-byte OID (hex encoding of level byte × 20)
    const oidByte  = (level + 1) & 0xff;
    const oidBytes = new TextEncoder().encode(
      oidByte.toString(16).padStart(2, '0').repeat(20)
    );
    buf.set(oidBytes, offset);
    offset += 32;

    // 256-byte pack body: deterministic pseudo-random pattern seeded by level
    for (let i = 0; i < 256; i++) {
      buf[offset + i] = (level * 31 + i * 17 + 0xAB) & 0xff;
    }
    offset += 256;
  }

  return buf;
}

// ---------------------------------------------------------------------------
// PIP transfer protocol implementation (JS mirror of src/p2p.rs)
// ---------------------------------------------------------------------------

/**
 * Split payload bytes into ordered PIP transfer slices.
 *
 * @param {string}     rootId
 * @param {Uint8Array} payload
 * @param {number}     maxSliceBytes
 * @returns {{ rootId: string, seq: number, totalSlices: number, data: Uint8Array }[]}
 */
function packetize(rootId, payload, maxSliceBytes) {
  const chunkSize   = Math.max(1, maxSliceBytes);
  const totalSlices = Math.max(1, Math.ceil(payload.length / chunkSize));
  const slices      = [];

  if (payload.length === 0) {
    return [{ rootId, seq: 0, totalSlices: 1, data: new Uint8Array(0) }];
  }

  for (let seq = 0; seq < totalSlices; seq++) {
    const start = seq * chunkSize;
    const end   = Math.min(start + chunkSize, payload.length);
    slices.push({ rootId, seq, totalSlices, data: payload.slice(start, end) });
  }
  return slices;
}

/**
 * Reconstruct the original payload from a set of PIP slices.
 *
 * Slices may arrive in any order; they are sorted by seq before concatenation.
 *
 * @param {{ rootId: string, seq: number, totalSlices: number, data: Uint8Array }[]} slices
 * @returns {Uint8Array}
 */
function reconstruct(slices) {
  if (slices.length === 0) return new Uint8Array(0);

  const sorted = [...slices].sort((a, b) => a.seq - b.seq);
  const { rootId, totalSlices } = sorted[0];

  assert.equal(sorted.length, totalSlices, `slice count mismatch: expected ${totalSlices}, got ${sorted.length}`);

  for (let i = 0; i < sorted.length; i++) {
    assert.equal(sorted[i].rootId, rootId,      `rootId mismatch at seq ${i}`);
    assert.equal(sorted[i].totalSlices, totalSlices, `totalSlices mismatch at seq ${i}`);
    assert.equal(sorted[i].seq, i,              `missing slice sequence ${i}`);
  }

  const parts  = sorted.map(s => s.data);
  const length = parts.reduce((sum, p) => sum + p.length, 0);
  const out    = new Uint8Array(length);
  let offset   = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodePayloadAsTransferEvents(rootId, payload, sliceSize) {
  const secretKey = generateSecretKey();
  const slices = packetize(rootId, payload, sliceSize);
  const manifestEvent = makeSignedTransferEvent(
    secretKey,
    MANIFEST_KIND,
    JSON.stringify({
      protocol: TRANSFER_PROTOCOL,
      version: TRANSFER_VERSION,
      type: 'manifest',
      root_id: rootId,
      total_bytes: payload.length,
      total_slices: slices.length,
    }),
  );
  const sliceEvents = slices.map((slice) => makeSignedTransferEvent(
    secretKey,
    SLICE_KIND,
    JSON.stringify({
      protocol: TRANSFER_PROTOCOL,
      version: TRANSFER_VERSION,
      type: 'slice',
      root_id: slice.rootId,
      seq: slice.seq,
      total_slices: slice.totalSlices,
      data: [...slice.data],
    }),
    [['e', manifestEvent.id]],
  ));
  return { manifestEvent, sliceEvents, slices };
}

/**
 * Build a PIP transfer-manifest envelope (kind 39078).
 *
 * @param {{ rootId: string, totalBytes: number, totalSlices: number }} manifest
 * @returns {object}  Nostr-shaped event object
 */
function buildManifestEnvelope(manifest) {
  return {
    kind: MANIFEST_KIND,
    content: JSON.stringify({
      protocol:     TRANSFER_PROTOCOL,
      version:      TRANSFER_VERSION,
      type:         'manifest',
      root_id:      manifest.rootId,
      total_bytes:  manifest.totalBytes,
      total_slices: manifest.totalSlices,
    }),
    tags: [],
  };
}

function buildSliceEnvelope(slice, manifestEventId) {
  return {
    kind: SLICE_KIND,
    content: JSON.stringify({
      protocol:     TRANSFER_PROTOCOL,
      version:      TRANSFER_VERSION,
      type:         'slice',
      root_id:      slice.rootId,
      seq:          slice.seq,
      total_slices: slice.totalSlices,
      data:         [...slice.data],
    }),
    tags: [['e', manifestEventId]],
  };
}

function parseTransferEvent(event) {
  const payload = JSON.parse(event.content);
  assert.equal(payload.protocol, TRANSFER_PROTOCOL, 'protocol mismatch');
  assert.equal(payload.version, TRANSFER_VERSION, 'version mismatch');

  if (event.kind === MANIFEST_KIND) {
    assert.equal(payload.type, 'manifest', 'expected manifest type');
    return {
      type: 'manifest',
      manifest: {
        rootId: payload.root_id,
        totalBytes: payload.total_bytes,
        totalSlices: payload.total_slices,
      },
    };
  }

  if (event.kind === SLICE_KIND) {
    assert.equal(payload.type, 'slice', 'expected slice type');
    return {
      type: 'slice',
      slice: {
        rootId: payload.root_id,
        seq: payload.seq,
        totalSlices: payload.total_slices,
        data: new Uint8Array(payload.data),
      },
    };
  }

  throw new Error(`unsupported kind: ${event.kind}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('synthetic git-bare payload has correct structure', () => {
  const payload = buildSyntheticGitBarePayload(DEPTH_LEVELS);
  // magic 'GITB'
  assert.deepEqual(payload.slice(0, 4), new TextEncoder().encode('GITB'));
  // version = 1
  assert.equal(new DataView(payload.buffer).getUint32(4, false), 1);
  // object count = DEPTH_LEVELS
  assert.equal(new DataView(payload.buffer).getUint32(8, false), DEPTH_LEVELS);
});

test('packetize produces correct slice count and metadata', () => {
  const payload    = buildSyntheticGitBarePayload(DEPTH_LEVELS);
  const sliceSize  = 64;
  const slices     = packetize('root-1', payload, sliceSize);
  const expected   = Math.ceil(payload.length / sliceSize);

  assert.equal(slices.length, expected, 'slice count');
  assert.ok(slices.every(s => s.totalSlices === expected),   'totalSlices consistent');
  assert.ok(slices.every(s => s.rootId === 'root-1'),        'rootId consistent');
  for (let i = 0; i < slices.length; i++) {
    assert.equal(slices[i].seq, i, `seq at index ${i}`);
  }
});

test('packetize empty payload emits single empty slice', () => {
  const slices = packetize('root-empty', new Uint8Array(0), 64);
  assert.equal(slices.length, 1);
  assert.equal(slices[0].seq, 0);
  assert.equal(slices[0].data.length, 0);
});

test('reconstruct reassembles payload from shuffled slices', () => {
  const payload   = buildSyntheticGitBarePayload(DEPTH_LEVELS);
  const slices    = packetize('root-2', payload, 128);
  // Shuffle slices to verify order-independent reconstruction.
  const shuffled  = [...slices].sort(() => 0.5 - Math.sin(slices.length));
  const result    = reconstruct(shuffled);
  assert.deepEqual(result, payload);
});

test('manifest envelope roundtrip', () => {
  const payload = buildSyntheticGitBarePayload(DEPTH_LEVELS);
  const slices  = packetize('root-manifest', payload, 256);
  const env     = buildManifestEnvelope({
    rootId:      'root-manifest',
    totalBytes:  payload.length,
    totalSlices: slices.length,
  });
  assert.equal(env.kind, MANIFEST_KIND);

  const parsed = parseTransferEvent(env);
  assert.equal(parsed.type,               'manifest');
  assert.equal(parsed.manifest.rootId,    'root-manifest');
  assert.equal(parsed.manifest.totalBytes, payload.length);
  assert.equal(parsed.manifest.totalSlices, slices.length);
});

test('slice envelope roundtrip — first slice', () => {
  const payload = buildSyntheticGitBarePayload(DEPTH_LEVELS);
  const slices  = packetize('root-slice', payload, 256);
  const env     = buildSliceEnvelope(slices[0], 'manifest-id-placeholder');
  assert.equal(env.kind, SLICE_KIND);

  const parsed = parseTransferEvent(env);
  assert.equal(parsed.type,             'slice');
  assert.equal(parsed.slice.rootId,     'root-slice');
  assert.equal(parsed.slice.seq,        0);
  assert.equal(parsed.slice.totalSlices, slices.length);
  assert.deepEqual(parsed.slice.data,   slices[0].data);
});

// ---------------------------------------------------------------------------
// Multi-depth SHA-256 transfer accuracy tests
//
// Each sub-test runs a full packetize → envelope → parse → reconstruct cycle
// at a different slice granularity and verifies the reconstructed SHA-256
// matches the reference hash.
// ---------------------------------------------------------------------------

const SLICE_CONFIGS = [
  { name: 'depth-1  (1 slice)',        sliceSize: (n) => n },
  { name: 'depth-2  (~2 slices)',      sliceSize: (n) => Math.floor(n / 2) + 1 },
  { name: 'depth-4  (~4 slices)',      sliceSize: (n) => Math.floor(n / 4) + 1 },
  { name: 'depth-8  (~8 slices)',      sliceSize: (n) => Math.floor(n / 8) + 1 },
  { name: 'depth-16 (~16 slices)',     sliceSize: (n) => Math.floor(n / 16) + 1 },
  { name: 'depth-64b (fine 64-byte)',  sliceSize: ()  => 64 },
  { name: 'depth-32b (very fine 32b)', sliceSize: ()  => 32 },
];

for (const cfg of SLICE_CONFIGS) {
  test(`PIP git-bare SHA-256 transfer: ${cfg.name}`, () => {
    const payload      = buildSyntheticGitBarePayload(DEPTH_LEVELS);
    const referenceSha = sha256Hex(payload);
    const sliceSize    = cfg.sliceSize(payload.length);
    const rootId       = `git-bare-pip-${sliceSize}`;

    // packetize
    const slices = packetize(rootId, payload, sliceSize);
    console.log(`  ${cfg.name}  sliceSize=${sliceSize}  slices=${slices.length}`);

    // build manifest + slice envelopes
    const manifestEnv = buildManifestEnvelope({
      rootId,
      totalBytes:  payload.length,
      totalSlices: slices.length,
    });
    const sliceEnvs = slices.map(s => buildSliceEnvelope(s, 'synthetic-manifest-id'));

    // parse manifest
    const parsedManifest = parseTransferEvent(manifestEnv);
    assert.equal(parsedManifest.type,                 'manifest');
    assert.equal(parsedManifest.manifest.rootId,      rootId);
    assert.equal(parsedManifest.manifest.totalBytes,  payload.length);
    assert.equal(parsedManifest.manifest.totalSlices, slices.length);

    // parse slices (shuffle to prove order-independence)
    const parsedSlices = sliceEnvs
      .map(e => parseTransferEvent(e).slice)
      .sort(() => 0.5 - Math.sin(slices.length + sliceSize));

    // reconstruct
    const reconstructed = reconstruct(parsedSlices);

    // bit-for-bit comparison
    assert.equal(reconstructed.length, payload.length,
      `${cfg.name}: reconstructed length mismatch`);
    assert.deepEqual(reconstructed, payload,
      `${cfg.name}: bit-for-bit mismatch`);

    // SHA-256 comparison
    const reconstructedSha = sha256Hex(reconstructed);
    assert.equal(reconstructedSha, referenceSha,
      `${cfg.name}: SHA-256 mismatch\n  expected  ${referenceSha}\n  got       ${reconstructedSha}`);

    console.log(`  ${cfg.name}  SHA-256 VERIFIED: ${reconstructedSha}`);
  });
}

// ---------------------------------------------------------------------------
// Bridge envelope integration: git-bare bundle transferred via PIP bridge
//
// Wraps each slice event in a nostr-dag-bridge envelope and verifies the
// full encode→decode→reconstruct chain including bridge-layer metadata.
// ---------------------------------------------------------------------------

test('PIP git-bare SHA-256 transfer via bridge envelope', () => {
  const BRIDGE_PROTOCOL = 'nostr-dag-bridge';
  const RELAY_HINTS     = ['wss://relay.nostr.example', 'wss://backup.nostr.example'];

  /** Encode a PIP event inside a bridge envelope. */
  function encodeBridgeMessage(event, direction, relayHints) {
    return JSON.stringify({
      protocol:    BRIDGE_PROTOCOL,
      version:     '1',
      direction,
      event,
      relay_hints: relayHints,
    });
  }

  /** Decode a bridge envelope back to the inner event. */
  function decodeBridgeMessage(msg) {
    const env = JSON.parse(msg);
    assert.equal(env.protocol, BRIDGE_PROTOCOL, 'bridge protocol mismatch');
    assert.ok(env.event, 'missing event in bridge envelope');
    return env.event;
  }

  const payload      = buildSyntheticGitBarePayload(DEPTH_LEVELS);
  const referenceSha = sha256Hex(payload);
  const sliceSize    = 128;
  const rootId       = 'git-bare-pip-bridge';

  console.log(`bridge transfer start root_id=${rootId} slice_size=${sliceSize} payload_bytes=${payload.length}`);
  const slices = packetize(rootId, payload, sliceSize);
  const manifestEnv = buildManifestEnvelope({
    rootId,
    totalBytes:  payload.length,
    totalSlices: slices.length,
  });
  const sliceEnvs = slices.map(s => buildSliceEnvelope(s, 'bridge-manifest-id'));
  console.log(`bridge transfer encoded manifest kind=${manifestEnv.kind} slices=${sliceEnvs.length}`);

  // Encode through bridge
  const bridgeMessages = [
    encodeBridgeMessage(manifestEnv, 'libp2p->nostr', RELAY_HINTS),
    ...sliceEnvs.map(e => encodeBridgeMessage(e, 'libp2p->nostr', RELAY_HINTS)),
  ];

  // Decode from bridge
  let receivedManifest = null;
  const receivedSlices = [];
  for (const msg of bridgeMessages) {
    const event  = decodeBridgeMessage(msg);
    const parsed = parseTransferEvent(event);
    console.log(`bridge transfer parsed kind=${parsed.type}`);
    if (parsed.type === 'manifest') receivedManifest = parsed.manifest;
    else                             receivedSlices.push(parsed.slice);
  }

  assert.ok(receivedManifest, 'manifest not received');
  assert.equal(receivedManifest.rootId,      rootId);
  assert.equal(receivedManifest.totalSlices, slices.length);
  assert.equal(receivedSlices.length,        slices.length);

  const reconstructed    = reconstruct(receivedSlices);
  const reconstructedSha = sha256Hex(reconstructed);
  console.log(`bridge transfer reconstructed_bytes=${reconstructed.length} sha256=${reconstructedSha}`);
  assert.equal(reconstructedSha, referenceSha,
    `bridge transfer SHA-256 mismatch\n  expected  ${referenceSha}\n  got       ${reconstructedSha}`);

  console.log(`  bridge transfer SHA-256 VERIFIED: ${reconstructedSha}`);
});

test('PIP git-bare verbose bare-repo roundtrip', () => {
  const work = mkdtempSync(join(tmpdir(), 'nostr-dag-pip-'));
  const srcDir = join(work, 'src-repo');
  mkdirSync(srcDir);

  try {
    const depth = DEPTH_LEVELS;
    gitRun(['init', '-b', 'main'], srcDir);
    gitRun(['config', 'user.email', 'pip-test@nostr-dag'], srcDir);
    gitRun(['config', 'user.name', 'PIP Test'], srcDir);

    for (let level = 0; level < depth; level++) {
      const file = join(srcDir, `level-${String(level).padStart(3, '0')}.txt`);
      writeFileSync(
        file,
        `PIP git-bare transfer depth level ${level}\nroot_id: git-bare-pip-test\ndepth: ${depth}\nlevel: ${level}\n`,
      );
      gitRun(['add', '-A'], srcDir);
      gitRun(['commit', '-m', `depth level ${level}: add level-${String(level).padStart(3, '0')}.txt`], srcDir);
    }

    const originalHead = gitRun(['rev-parse', 'HEAD'], srcDir);
    logTree(srcDir, 'created source repo');

    const bundlePath = join(work, 'verbose.bundle');
    gitRun(['bundle', 'create', bundlePath, 'main'], srcDir);
    const bundleBytes = new Uint8Array(readFileSync(bundlePath));
    const referenceSha = sha256Hex(bundleBytes);
    console.log(`created bundle bytes=${bundleBytes.length} sha256=${referenceSha}`);
    console.log(`created HEAD ${originalHead}`);

    const rootId = 'git-bare-pip-verbose';
    const sliceSize = 64;
    const { manifestEvent, sliceEvents, slices } = encodePayloadAsTransferEvents(rootId, bundleBytes, sliceSize);
    console.log(`broadcast root_id=${rootId} slices=${slices.length} slice_size=${sliceSize}`);
    console.log(`encoded bare repo into manifest=${manifestEvent.id ?? 'manifest-id'} slices=${sliceEvents.length}`);
    console.log(`manifest event:\n${JSON.stringify(manifestEvent, null, 2)}`);
    sliceEvents.forEach((event, index) => {
      console.log(`slice event seq=${index}:\n${JSON.stringify(event, null, 2)}`);
    });

    const parsedManifest = parseTransferEvent(manifestEvent);
    assert.equal(parsedManifest.type, 'manifest');
    console.log(`received manifest root_id=${parsedManifest.manifest.rootId}`);

    const receivedSlices = sliceEvents.map((env) => parseTransferEvent(env).slice);
    console.log(`received slices=${receivedSlices.length}`);

    const shuffled = [...receivedSlices].reverse();
    const reconstructed = reconstruct(shuffled);
    const reconstructedSha = sha256Hex(reconstructed);
    console.log(`reconstructed bytes=${reconstructed.length} sha256=${reconstructedSha}`);

    assert.equal(reconstructedSha, referenceSha);

    const reconstructedBundlePath = join(work, 'reconstructed.bundle');
    writeFileSync(reconstructedBundlePath, reconstructed);

    const bareDir = join(work, 'bare-repo');
    gitRun(['clone', '--bare', reconstructedBundlePath, bareDir], work);
    logTree(bareDir, 'restored bare repo');

    const restoredHead = gitRun(
      ['-c', 'safe.bareRepository=all', 'rev-parse', 'HEAD'],
      bareDir,
      { env: { GIT_DIR: bareDir } },
    );
    assert.equal(restoredHead, originalHead);
    console.log(`restored bare repo HEAD ${restoredHead}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
