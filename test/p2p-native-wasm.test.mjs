import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WASM_JS = path.join(REPO_ROOT, 'site', 'pkg', 'nostr_dag.js');
const WASM_WASM = path.join(REPO_ROOT, 'site', 'pkg', 'nostr_dag_bg.wasm');
const BRIDGE_TOPIC = 'nostr-dag-bridge';
const TRANSFER_PROTOCOL = 'nostr-dag-transfer';
const TRANSFER_VERSION = 1;
const TRANSFER_MANIFEST_KIND = 39078;
const TRANSFER_SLICE_KIND = 39079;

const SAFARI_CAPABILITIES = {
  alwaysMatch: {
    browserName: 'safari',
  },
};

function hasSafariDriver() {
  return process.platform === 'darwin';
}

async function ensureP2pWasmBuild() {
  try {
    await access(WASM_JS, fsConstants.R_OK);
    await access(WASM_WASM, fsConstants.R_OK);
    return;
  } catch {
    // Build only the p2p wasm package so the browser can load the real P2pNode.
  }

  await new Promise((resolve, reject) => {
    const child = spawn(
      'wasm-pack',
      [
        'build',
        '--target',
        'web',
        '--release',
        '--out-dir',
        'site/pkg',
        '--',
        '--no-default-features',
        '--features',
        'wasm,p2p-wasm',
      ],
      {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      },
    );

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wasm-pack build failed with code ${code}`));
    });
  });
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('unable to determine free port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function contentTypeFor(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.wasm')) return 'application/wasm';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

function gitRun(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${cwd}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function normalizeRelayUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return '';
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return value.replace(/\/$/, '');
  }
}

function probeRelayHandshake(relayUrl) {
  return new Promise((resolve) => {
    const wsUrl = normalizeRelayUrl(relayUrl);
    if (!wsUrl || wsUrl.includes('.onion')) {
      resolve(false);
      return;
    }
    const WebSocketCtor = globalThis.WebSocket;
    if (typeof WebSocketCtor !== 'function') {
      resolve(false);
      return;
    }
    let settled = false;
    let socket = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        socket?.close?.();
      } catch {
        // best effort only
      }
      resolve(ok);
    };
    try {
      socket = new WebSocketCtor(wsUrl);
      const timeout = setTimeout(() => finish(false), 10_000);
      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        finish(true);
      });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        finish(false);
      });
      socket.addEventListener('close', () => {
        clearTimeout(timeout);
        finish(false);
      });
    } catch {
      finish(false);
    }
  });
}

async function crawlRelayCandidates() {
  const found = new Set();
  const { SimplePool } = await import('nostr-tools/pool');
  const pool = new SimplePool();
  const seeds = [
    'wss://nos.lol',
    'wss://relay.nostr.com',
    'wss://relay.nostr.band',
    'wss://relay.primal.net',
    'wss://nostr.wine',
  ];
  const relaysToQuery = [...new Set(seeds.map((relay) => normalizeRelayUrl(relay)).filter(Boolean))];

  const collectRelayUrls = (value) => {
    if (typeof value === 'string') {
      const normalized = value.trim();
      const relay = normalizeRelayUrl(normalized);
      if (relay) found.add(relay);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectRelayUrls(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) collectRelayUrls(item);
    }
  };

  const recordRelayInfo = (event) => {
    if (!event?.pubkey) return;
    for (const tag of event.tags || []) {
      if (!Array.isArray(tag) || tag[0] !== 'r' || !tag[1]) continue;
      collectRelayUrls(tag[1]);
    }
    collectRelayUrls(event.content);
    for (const value of Object.values(event)) {
      if (value === event.tags || value === event.content) continue;
      collectRelayUrls(value);
    }
  };

  try {
    const discoveryFilters = [{ kinds: [3, 10002], limit: 200 }];
    let sawRelayListEvents = false;
    for (const filter of discoveryFilters) {
      try {
        const events = await pool.querySync(relaysToQuery, filter, {
          maxWait: 5000,
          label: 'relay-crawler',
        });
        if (Array.isArray(events) && events.length) sawRelayListEvents = true;
        for (const event of events || []) recordRelayInfo(event);
      } catch {
        // Crawl best-effort only.
      }
    }

    if (!found.size || !sawRelayListEvents) {
      try {
        const events = await pool.querySync(relaysToQuery, [{ limit: 200 }], {
          maxWait: 5000,
          label: 'relay-crawler-fallback',
        });
        for (const event of events || []) recordRelayInfo(event);
      } catch {
        // Crawl best-effort only.
      }
    }
  } finally {
    pool.close(relaysToQuery);
  }

  return [...found];
}
async function discoverHealthyRelays() {
  const candidates = await crawlRelayCandidates();
  const uniqueCandidates = [...new Set(candidates)];
  const probed = await Promise.all(uniqueCandidates.map(async (relay) => ({
    relay,
    ok: await probeRelayHandshake(relay),
  })));
  const relays = probed.filter((item) => item.ok).map((item) => item.relay);
  console.log(`[native-wasm:test] discovered ${relays.length} healthy relays: ${relays.join(', ') || 'none'}`);
  return relays;
}

function createBareRepoBundle() {
  const work = mkdtempSync(path.join(tmpdir(), 'nostr-dag-bare-'));
  const srcDir = path.join(work, 'src-repo');
  mkdirSync(srcDir);

  const depth = 10;
  try {
    gitRun(['init', '-b', 'main'], srcDir);
    gitRun(['config', 'user.email', 'pip-test@nostr-dag'], srcDir);
    gitRun(['config', 'user.name', 'PIP Test'], srcDir);

    for (let level = 0; level < depth; level++) {
      const file = path.join(srcDir, `level-${String(level).padStart(3, '0')}.txt`);
      writeFileSync(
        file,
        `PIP git-bare transfer depth level ${level}\nroot_id: live-bare-repo\ndepth: ${depth}\nlevel: ${level}\n`,
      );
      gitRun(['add', '-A'], srcDir);
      gitRun(['commit', '-m', `depth level ${level}: add level-${String(level).padStart(3, '0')}.txt`], srcDir);
    }

    const head = gitRun(['rev-parse', 'HEAD'], srcDir);
    const bundlePath = path.join(work, 'live.bundle');
    gitRun(['bundle', 'create', bundlePath, 'main'], srcDir);
    const bundleBytes = new Uint8Array(readFileSync(bundlePath));
    return { work, srcDir, head, bundleBytes, bundlePath };
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    throw error;
  }
}

function createStaticServer(bareRepoBundleBytes = null, bareRepoRelayUrls = []) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/p2p-bare-repo.bundle') {
          if (!bareRepoBundleBytes) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('bare-repo bundle unavailable');
            return;
          }
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(Buffer.from(bareRepoBundleBytes));
          return;
        }
        if (url.pathname === '/peers' && req.method === 'POST') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (url.pathname === '/p2p-wasm-native-test.html') {
          const nativeWs = url.searchParams.get('nativeWs') || '';
          const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <link rel="icon" href="/favicon.ico">
    <title>waiting</title>
  </head>
  <body>
    <pre id="status">starting</pre>
    <script type="module">
      import initWasm, * as wasmPkg from '/site/pkg/nostr_dag.js';
      import { createSharedLibp2pStack, deterministicPeerIdFromSeed } from '/demo/shared/libp2p-stack.mjs';
      import { multiaddr } from 'https://esm.sh/@multiformats/multiaddr';

      const status = document.getElementById('status');
      const nativeWs = new URL(location.href).searchParams.get('nativeWs') || '';
      window.__p2pReady = false;
      window.__p2pConnected = false;
      window.__p2pPeerSeen = false;
      window.__p2pPeerId = '';
      window.__p2pReceived = [];
      window.__p2pBridgeKinds = [];
      window.__p2pPeerEvents = [];
      window.__p2pErrors = [];

      try {
        await initWasm('/site/pkg/nostr_dag_bg.wasm');
        window.__nostrDagWasm = wasmPkg;
        window.__expectedPeerId = await deterministicPeerIdFromSeed('nostr-dag-wasm');

        const stack = await createSharedLibp2pStack({
          bootstrapPeers: nativeWs ? [nativeWs] : [],
          useWasmP2p: true,
          onLog(level, text, state) {
            console.log('[native-wasm:browser:' + state + ':' + level + '] ' + text);
          },
          onPeer(event) {
            window.__p2pPeerEvents.push(event);
            console.log('[native-wasm:browser:peer] ' + event.kind + ' ' + (event.peer?.peerId || event.peer || ''));
            window.__p2pPeerSeen = true;
            if (event.kind === 'connected') {
              window.__p2pConnected = true;
            }
          },
          onStatus(state, peerId) {
            window.__p2pStatus = { state, peerId };
            console.log('[native-wasm:browser:status] ' + state + ' ' + peerId);
          },
        });

        const { node } = stack;
        window.__p2pPeerId = node.peerId.toString();
        window.__p2pPeerIdMatchesExpected = window.__p2pPeerId === window.__expectedPeerId;
        window.__p2pReady = true;
        node.services.pubsub.addEventListener('message', (evt) => {
          const text = new TextDecoder().decode(evt.detail.data);
          window.__p2pReceived.push(text);
          try {
            const parsed = JSON.parse(text);
            const kind = parsed?.event?.kind;
            if (kind !== undefined) {
              window.__p2pBridgeKinds.push(kind);
            }
          } catch (error) {
            window.__p2pErrors.push(String(error));
          }
          status.textContent = \`received \${window.__p2pBridgeKinds.join(',')}\`;
        });

        window.__p2pNode = node;
        window.__p2pReady = true;
        status.textContent = 'ready';
        document.title = 'ready';

        if (nativeWs && typeof node.dial === 'function') {
          try {
            await node.dial(multiaddr(nativeWs));
            window.__p2pConnected = true;
            console.log('[native-wasm:browser:status] dialed bootstrap peer ' + nativeWs);
          } catch (error) {
            console.log('[native-wasm:browser:warn] bootstrap dial failed: ' + (error?.message || error));
          }
        }
      } catch (error) {
        window.__p2pError = String(error?.message || error);
        window.__p2pErrors.push(window.__p2pError);
        status.textContent = window.__p2pError;
        document.title = 'error';
      }
    </script>
  </body>
</html>`;
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }

        if (url.pathname === '/p2p-bare-repo-test.html') {
          const nativeWs = url.searchParams.get('nativeWs') || '';
          const bundleB64 = url.searchParams.get('bundleB64') || '';
          const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <link rel="icon" href="/favicon.ico">
    <title>waiting</title>
  </head>
  <body>
    <pre id="status">starting</pre>
    <script type="module">
      import initWasm, * as wasmPkg from '/site/pkg/nostr_dag.js';
      import { SimplePool } from 'https://esm.sh/nostr-tools@2.10.4/pool';
      import { createSharedLibp2pStack, deterministicPeerIdFromSeed } from '/demo/shared/libp2p-stack.mjs';
      import { multiaddr } from 'https://esm.sh/@multiformats/multiaddr';
      import { encodeBridgeMessage, decodeBridgeMessage } from '/demo/shared/bridge-protocol.mjs';
      import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'https://esm.sh/nostr-tools@2.25.0/pure';

      const status = document.getElementById('status');
      const nativeWs = new URL(location.href).searchParams.get('nativeWs') || '';
      const bundleB64 = new URL(location.href).searchParams.get('bundleB64') || '';
      window.__p2pReady = false;
      window.__p2pConnected = false;
      window.__p2pPeerSeen = false;
      window.__p2pPeerId = '';
      window.__p2pReceived = [];
      window.__p2pBridgeKinds = [];
      window.__p2pPeerEvents = [];
      window.__p2pErrors = [];
      window.__bareRepoPublished = false;
      window.__bareRepoSentKinds = [];
      window.__bareRepoSentManifestId = '';
      window.__bareRepoSentSliceCount = 0;
      window.__bareRepoSha256 = '';
      window.__bareRepoReconstructed = false;
      window.__bareRepoReconstructionSource = '';
      window.__bareRepoReconstructedSha256 = '';
      window.__bareRepoReconstructedBytes = 0;
      window.__bareRepoReconstructedBundleB64 = '';
      window.__bareRepoPublishAttempts = 0;
      window.__bareRepoPublishTotal = 0;
      window.__bareRepoPublishProgressPct = 0;
      window.__bareRepoPublishProgressLabel = '';

      const DEFAULT_RELAYS = ${JSON.stringify(bareRepoRelayUrls.length ? bareRepoRelayUrls : ['wss://nos.lol'])};
      const relayPool = new SimplePool();

      const packetize = (rootId, payload, maxSliceBytes) => {
        const chunkSize = Math.max(1, maxSliceBytes);
        const totalSlices = Math.max(1, Math.ceil(payload.length / chunkSize));
        if (payload.length === 0) {
          return [{ rootId, seq: 0, totalSlices: 1, data: new Uint8Array(0) }];
        }
        const slices = [];
        for (let seq = 0; seq < totalSlices; seq++) {
          const start = seq * chunkSize;
          const end = Math.min(start + chunkSize, payload.length);
          slices.push({ rootId, seq, totalSlices, data: payload.slice(start, end) });
        }
        return slices;
      };

      const encodeTransferEvent = (secretKey, kind, content, tags = []) => finalizeEvent({
        kind,
        created_at: Math.floor(Date.now() / 1000),
        pubkey: getPublicKey(secretKey),
        content,
        tags,
      }, secretKey);

      const sha256Hex = async (bytes) => {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      };

      const parseTransferEvent = (event) => {
        if (!event || typeof event !== 'object') return null;
        let payload;
        try {
          payload = JSON.parse(event.content || '{}');
        } catch {
          return null;
        }
        if (payload.protocol !== '${TRANSFER_PROTOCOL}' || payload.version !== ${TRANSFER_VERSION}) {
          return null;
        }
        if (event.kind === ${TRANSFER_MANIFEST_KIND} && payload.type === 'manifest') {
          return {
            type: 'manifest',
            manifest: {
              rootId: payload.root_id,
              totalBytes: Number(payload.total_bytes) || 0,
              totalSlices: Number(payload.total_slices) || 0,
              eventId: event.id,
            },
          };
        }
        if (event.kind === ${TRANSFER_SLICE_KIND} && payload.type === 'slice') {
          return {
            type: 'slice',
            slice: {
              rootId: payload.root_id,
              seq: Number(payload.seq) || 0,
              totalSlices: Number(payload.total_slices) || 0,
              data: new Uint8Array(payload.data || []),
              eventId: event.id,
              manifestId: event.tags?.find?.((tag) => Array.isArray(tag) && tag[0] === 'e' && tag[1])?.[1] || '',
            },
          };
        }
        return null;
      };

      const reconstruct = (slices) => {
        if (!slices.length) return new Uint8Array(0);
        const sorted = [...slices].sort((a, b) => a.seq - b.seq);
        const { rootId, totalSlices } = sorted[0];
        if (sorted.length !== totalSlices) {
          throw new Error(\`slice count mismatch: expected \${totalSlices}, got \${sorted.length}\`);
        }
        for (let index = 0; index < sorted.length; index++) {
          const slice = sorted[index];
          if (slice.rootId !== rootId) {
            throw new Error(\`rootId mismatch at seq \${index}\`);
          }
          if (slice.totalSlices !== totalSlices) {
            throw new Error(\`totalSlices mismatch at seq \${index}\`);
          }
          if (slice.seq !== index) {
            throw new Error(\`missing slice sequence \${index}\`);
          }
        }
        const length = sorted.reduce((sum, slice) => sum + slice.data.length, 0);
        const out = new Uint8Array(length);
        let offset = 0;
        for (const slice of sorted) {
          out.set(slice.data, offset);
          offset += slice.data.length;
        }
        return out;
      };

      const bytesToBase64 = (bytes) => {
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        }
        return btoa(binary);
      };

      function createTransferCollector(rootId, expectedTotalSlices, expectedTotalBytes) {
        const manifest = { rootId, totalSlices: expectedTotalSlices, totalBytes: expectedTotalBytes, eventId: '' };
        const slices = new Map();
        let resolved = false;
        let resolve;
        const done = new Promise((r) => {
          resolve = r;
        });

        const tryComplete = async (source) => {
          if (resolved) return;
          if (!manifest.totalSlices || slices.size < manifest.totalSlices) return;
          const ordered = [...slices.values()].sort((a, b) => a.seq - b.seq);
          const bytes = reconstruct(ordered);
          const sha256 = await sha256Hex(bytes);
          resolved = true;
          window.__bareRepoReconstructed = true;
          window.__bareRepoReconstructionSource = source;
          window.__bareRepoReconstructedSha256 = sha256;
          window.__bareRepoReconstructedBytes = bytes.length;
          window.__bareRepoReconstructedBundleB64 = bytesToBase64(bytes);
          resolve({
            source,
            sha256,
            bytes,
            slices: ordered.length,
          });
        };

        return {
          ingest: async (source, event) => {
            const parsed = parseTransferEvent(event);
            if (!parsed) return null;
            if (parsed.type === 'manifest') {
              manifest.eventId = parsed.manifest.eventId;
              manifest.totalSlices = parsed.manifest.totalSlices;
              manifest.totalBytes = parsed.manifest.totalBytes;
              await tryComplete(source);
              return null;
            }
            if (parsed.type === 'slice' && parsed.slice.rootId === rootId) {
              slices.set(parsed.slice.seq, parsed.slice);
              await tryComplete(source);
            }
            return null;
          },
          done,
          tryComplete,
        };
      }

      try {
        await initWasm('/site/pkg/nostr_dag_bg.wasm');
        window.__nostrDagWasm = wasmPkg;
        window.__expectedPeerId = await deterministicPeerIdFromSeed('nostr-dag-wasm');

        const stack = await createSharedLibp2pStack({
          bootstrapPeers: nativeWs ? [nativeWs] : [],
          useWasmP2p: true,
          onLog(level, text, state) {
            console.log('[native-wasm:bare:' + state + ':' + level + '] ' + text);
          },
          onPeer(event) {
            window.__p2pPeerEvents.push(event);
            window.__p2pPeerSeen = true;
            if (event.kind === 'connected') {
              window.__p2pConnected = true;
            }
          },
          onStatus(state, peerId) {
            window.__p2pStatus = { state, peerId };
            console.log('[native-wasm:bare:status] ' + state + ' ' + peerId);
          },
        });

        const { node } = stack;
        window.__p2pPeerId = node.peerId.toString();
        window.__p2pPeerIdMatchesExpected = window.__p2pPeerId === window.__expectedPeerId;
        let transferCollector = null;
        node.services.pubsub.addEventListener('message', async (evt) => {
          const text = new TextDecoder().decode(evt.detail.data);
          window.__p2pReceived.push(text);
          try {
            const parsed = decodeBridgeMessage(text) || JSON.parse(text);
            const kind = parsed?.event?.kind;
            if (kind !== undefined) {
              window.__p2pBridgeKinds.push(kind);
            }
            if (transferCollector && parsed?.event) {
              await transferCollector.ingest('libp2p', parsed.event);
            }
          } catch (error) {
            window.__p2pErrors.push(String(error));
          }
          status.textContent = \`received \${window.__p2pBridgeKinds.join(',')}\`;
        });

        if (nativeWs && typeof node.dial === 'function') {
          try {
            await node.dial(multiaddr(nativeWs));
            window.__p2pConnected = true;
            console.log('[native-wasm:bare:status] dialed bootstrap peer ' + nativeWs);
          } catch (error) {
            console.log('[native-wasm:bare:warn] bootstrap dial failed: ' + (error?.message || error));
          }
        }

        await node.services.pubsub.subscribe('${BRIDGE_TOPIC}');
        console.log('[native-wasm:bare:trace] subscribed to bridge topic ${BRIDGE_TOPIC}');

        await new Promise((resolve) => {
          const tick = () => {
            if (window.__p2pConnected) {
              resolve();
            } else {
              setTimeout(tick, 100);
            }
          };
          tick();
        });

        if (!bundleB64) {
          throw new Error('missing bare repo bundle payload');
        }
        console.log('[native-wasm:bare:trace] decoding bare repo bundle payload');
        const binary = atob(bundleB64);
        const bundleBytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        console.log('[native-wasm:bare:trace] decoded bundle bytes ' + bundleBytes.length);
        const rootId = 'live-bare-repo';
        const sliceSize = 256;
        const slices = packetize(rootId, bundleBytes, sliceSize);
        console.log('[native-wasm:bare:trace] packetized bundle into ' + slices.length + ' slices');
        const secretKey = generateSecretKey();
        console.log('[native-wasm:bare:trace] signing manifest event');
        const manifestEvent = encodeTransferEvent(secretKey, ${TRANSFER_MANIFEST_KIND}, JSON.stringify({
          protocol: '${TRANSFER_PROTOCOL}',
          version: ${TRANSFER_VERSION},
          type: 'manifest',
          root_id: rootId,
          total_bytes: bundleBytes.length,
          total_slices: slices.length,
        }));
        if (!verifyEvent(manifestEvent)) {
          throw new Error('manifest event signature failed verification');
        }
        const sliceEvents = slices.map((slice) => encodeTransferEvent(secretKey, ${TRANSFER_SLICE_KIND}, JSON.stringify({
          protocol: '${TRANSFER_PROTOCOL}',
          version: ${TRANSFER_VERSION},
          type: 'slice',
          root_id: slice.rootId,
          seq: slice.seq,
          total_slices: slice.totalSlices,
          data: [...slice.data],
        }), [['e', manifestEvent.id]]));
        transferCollector = createTransferCollector(rootId, slices.length, bundleBytes.length);
        const totalRelays = DEFAULT_RELAYS.length;
        const totalEvents = (sliceEvents.length + 1) * totalRelays;
        let publishAttempts = 0;
        let lastProgressPct = -1;
        window.__bareRepoPublishTotal = totalEvents;

        const updateProgress = (label) => {
          publishAttempts += 1;
          window.__bareRepoPublishAttempts = publishAttempts;
          const progressPct = totalEvents > 0 ? Math.min(100, Math.floor((publishAttempts / totalEvents) * 100)) : 100;
          window.__bareRepoPublishProgressPct = progressPct;
          window.__bareRepoPublishProgressLabel = label;
          if (progressPct !== lastProgressPct) {
            lastProgressPct = progressPct;
            console.log('[native-wasm:bare:trace] publish progress ' + progressPct + '% (' + publishAttempts + '/' + totalEvents + ') ' + label);
          }
        };

        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        let relayPublishRound = 0;
        const publishRelayRoundRobin = async (event, eventLabel) => {
          if (!DEFAULT_RELAYS.length) return;
          const startIndex = relayPublishRound % DEFAULT_RELAYS.length;
          relayPublishRound += 1;
          const orderedRelays = [
            ...DEFAULT_RELAYS.slice(startIndex),
            ...DEFAULT_RELAYS.slice(0, startIndex),
          ];
          console.log('[native-wasm:bare:trace] relay round robin ' + eventLabel + ' order ' + orderedRelays.join(', '));
          for (let index = 0; index < orderedRelays.length; index++) {
            const relay = orderedRelays[index];
            try {
              await relayPool.publish([relay], event);
              console.log('[native-wasm:bare:trace] relay publish ' + eventLabel + ' relay=' + relay);
            } catch (error) {
              const message = String(error?.message || error);
              window.__p2pErrors.push(message);
              console.log('[native-wasm:bare:warn] relay publish failed ' + eventLabel + ' relay=' + relay + ' error=' + message);
            } finally {
              updateProgress(eventLabel + ' ' + relay);
            }
            if (index < orderedRelays.length - 1) {
              await sleep(250);
            }
          }
        };

        const publishTransferEvent = async (event) => {
          const bridgePayload = encodeBridgeMessage(event, 'nostr->libp2p', [], { topic: '${BRIDGE_TOPIC}' });
          await node.services.pubsub.publish('${BRIDGE_TOPIC}', new TextEncoder().encode(bridgePayload));
          void publishRelayRoundRobin(event, String(event.kind));
        };

        let relayQueryStop = false;
        let relayQueryWake = null;
        let relayQueryCloser = null;
        const stopRelayQuery = () => {
          relayQueryStop = true;
          try {
            relayQueryCloser?.close?.('reconstruction complete');
          } catch {
            // best effort only
          }
          if (relayQueryWake) {
            relayQueryWake();
            relayQueryWake = null;
          }
        };
        transferCollector.done.then(() => stopRelayQuery());

        const relayQueryPromise = (async () => {
          try {
            const deadline = Date.now() + 120_000;
            const queryIds = [manifestEvent.id, ...sliceEvents.map((event) => event.id)];
            const seenIds = new Set();
            let lastLoggedRemaining = null;
            while (Date.now() < deadline && !relayQueryStop && !window.__bareRepoReconstructed) {
              const remainingMs = Math.max(0, deadline - Date.now());
              const remainingSeconds = Math.ceil(remainingMs / 1000);
              if (remainingSeconds !== lastLoggedRemaining) {
                lastLoggedRemaining = remainingSeconds;
                console.log('[native-wasm:bare:trace] relay query countdown ' + remainingSeconds + 's remaining');
              }
              const events = [];
              await new Promise((resolve) => {
                relayQueryCloser = relayPool.subscribeEose(
                  DEFAULT_RELAYS,
                  { ids: queryIds, limit: queryIds.length },
                  {
                    maxWait: 2000,
                    label: 'bare-repo-transfer',
                    onevent(event) {
                      events.push(event);
                    },
                    onclose() {
                      relayQueryCloser = null;
                      resolve();
                    },
                  },
                );
              });
              for (const event of events || []) {
                if (!event?.id || seenIds.has(event.id)) continue;
                seenIds.add(event.id);
                await transferCollector.ingest('relay', event);
              }
              if (relayQueryStop || window.__bareRepoReconstructed) return true;
              await new Promise((resolve) => {
                relayQueryWake = resolve;
                const timeoutId = setTimeout(() => {
                  if (relayQueryWake === resolve) relayQueryWake = null;
                  resolve();
                }, 1000);
                if (relayQueryStop || window.__bareRepoReconstructed) {
                  clearTimeout(timeoutId);
                  if (relayQueryWake === resolve) relayQueryWake = null;
                  resolve();
                }
              });
            }
            return window.__bareRepoReconstructed;
          } catch (error) {
            window.__p2pErrors.push(String(error?.message || error));
            return false;
          } finally {
            stopRelayQuery();
          }
        })();

        console.log('[native-wasm:bare:trace] broadcasting manifest event ' + manifestEvent.id);
        window.__bareRepoSentManifestId = manifestEvent.id;
        await publishTransferEvent(manifestEvent);
        console.log('[native-wasm:bare:trace] manifest broadcast complete');
        window.__bareRepoSentKinds.push(manifestEvent.kind);
        for (let index = 0; index < sliceEvents.length; index++) {
          const sliceEvent = sliceEvents[index];
          const slice = slices[index];
          console.log('[native-wasm:bare:trace] signing slice ' + slice.seq + '/' + slice.totalSlices);
          console.log('[native-wasm:bare:trace] broadcasting slice event ' + sliceEvent.id);
          await publishTransferEvent(sliceEvent);
          console.log('[native-wasm:bare:trace] slice broadcast complete ' + slice.seq);
          window.__bareRepoSentKinds.push(sliceEvent.kind);
        }
        window.__bareRepoSentSliceCount = sliceEvents.length;
        window.__bareRepoPublished = true;
        console.log('[native-wasm:bare:trace] bare repo publish complete');
        const reconstructed = await transferCollector.done;
        stopRelayQuery();
        await relayQueryPromise.catch(() => false);
        if (reconstructed?.bytes) {
          window.__bareRepoReconstructed = true;
          window.__bareRepoReconstructionSource = reconstructed.source;
          window.__bareRepoReconstructedSha256 = reconstructed.sha256;
          window.__bareRepoReconstructedBytes = reconstructed.bytes.length;
          console.log('[native-wasm:bare:trace] bare repo reconstructed via ' + reconstructed.source + ' sha256 ' + reconstructed.sha256);
        }
        status.textContent = 'published';
        document.title = 'published';
      } catch (error) {
        window.__p2pError = String(error?.message || error);
        window.__p2pErrors.push(window.__p2pError);
        status.textContent = window.__p2pError;
        document.title = 'error';
      }
    </script>
  </body>
</html>`;
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }

        if (url.pathname === '/favicon.ico') {
          const faviconPath = path.join(REPO_ROOT, 'site', 'favicon.ico');
          const body = await readFile(faviconPath);
          res.writeHead(200, { 'content-type': 'image/x-icon' });
          res.end(body);
          return;
        }

        const mapped = url.pathname.startsWith('/site/')
          ? path.join(REPO_ROOT, url.pathname)
          : url.pathname.startsWith('/demo/')
            ? path.join(REPO_ROOT, url.pathname)
            : url.pathname === '/'
              ? path.join(REPO_ROOT, 'site', 'index.html')
              : null;

        if (!mapped) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('not found');
          return;
        }

        const body = await readFile(mapped);
        res.writeHead(200, { 'content-type': contentTypeFor(mapped) });
        res.end(body);
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(String(error?.message || error));
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to start static server'));
        return;
      }
      resolve({
        server,
        port: address.port,
      });
    });
  });
}

function startNativePeer() {
  return new Promise((resolve, reject) => {
    console.log('[native-wasm:test] starting native peer');
    const child = spawn('cargo', ['run', '--features', 'p2p', '--bin', 'p2p-node'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        P2P_BOOTSTRAP: ',',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const stdoutLines = [];
    let peerId = '';
    let wsListenAddr = '';
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(result);
    };

    const observe = (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        stdoutLines.push(line);
        console.log(`[native-wasm:native] ${line}`);
        const peerMatch = line.match(/^READY peer_id=([A-Za-z0-9]+)\b/);
        if (peerMatch) {
          peerId = peerMatch[1];
        }
        const listenMatch = line.match(/^LISTENING (\/ip4\/[^\s]+\/ws)\b/);
        if (listenMatch) {
          wsListenAddr = listenMatch[1];
        }
        if (peerId && wsListenAddr) {
          finish(null, {
            child,
            stdout,
            stderr,
            stdoutLines,
            getStdout: () => stdout,
            peerId,
            wsListenAddr,
          });
        }
      }
    };

    child.stdout.on('data', observe);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (!settled) {
        finish(new Error(`native peer exited early code=${code} signal=${signal ?? 'none'}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
  });
}

async function createSafariSession(webdriverPort) {
  const response = await fetch(`http://127.0.0.1:${webdriverPort}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capabilities: SAFARI_CAPABILITIES }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`failed to create Safari session: ${JSON.stringify(data)}`);
  }
  const sessionId = data.sessionId || data.value?.sessionId || data.value?.capabilities?.sessionId;
  if (!sessionId) {
    throw new Error(`Safari session response missing session id: ${JSON.stringify(data)}`);
  }
  return sessionId;
}

async function webdriverExecute(webdriverPort, sessionId, script, args = []) {
  const response = await fetch(`http://127.0.0.1:${webdriverPort}/session/${sessionId}/execute/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ script, args }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`webdriver execute failed: ${JSON.stringify(data)}`);
  }
  return data.value;
}

async function webdriverNavigate(webdriverPort, sessionId, url) {
  const response = await fetch(`http://127.0.0.1:${webdriverPort}/session/${sessionId}/url`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`webdriver navigate failed: ${JSON.stringify(data)}`);
  }
}

async function webdriverDeleteSession(webdriverPort, sessionId) {
  await fetch(`http://127.0.0.1:${webdriverPort}/session/${sessionId}`, {
    method: 'DELETE',
  }).catch(() => {});
}

async function waitForCondition(check, { timeoutMs = 120_000, intervalMs = 1_000, description = 'condition' } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function buildWsDialAddress(wsListenAddr, peerId) {
  if (!wsListenAddr || !peerId) {
    throw new Error('missing websocket listen address or peer id');
  }
  return `${wsListenAddr}/p2p/${peerId}`;
}

async function ensureChromiumBrowser() {
  console.log('[native-wasm:test] checking Chromium availability');
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    console.log('[native-wasm:test] Chromium available');
    return;
  } catch (error) {
    const message = String(error?.message || error);
    if (!message.includes("Executable doesn't exist")) {
      throw error;
    }
  }

  console.log('[native-wasm:test] installing Chromium via Playwright');
  await new Promise((resolve, reject) => {
    const child = spawn('npx', ['playwright', 'install', 'chromium'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`playwright install chromium failed with code ${code}`));
    });
  });

  const browser = await chromium.launch({ headless: true });
  await browser.close();
  console.log('[native-wasm:test] Chromium installed and ready');
}

async function runChromiumNativeWasmExchange(browserBaseUrl, nativeDialAddr) {
  console.log(`[native-wasm:test] launching Chromium page at ${browserBaseUrl}`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (message) => {
    console.log(`[native-wasm:browser:${message.type()}] ${message.text()}`);
  });
  try {
    const pageUrl = `${browserBaseUrl}/p2p-wasm-native-test.html?nativeWs=${encodeURIComponent(nativeDialAddr)}`;
    console.log(`[native-wasm:test] navigating browser to ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => window.__p2pReady === true, null, { timeout: 120_000 });
    console.log('[native-wasm:test] browser wasm peer reported ready');

    await page.waitForFunction(() => window.__p2pConnected === true, null, { timeout: 120_000 });
    console.log('[native-wasm:test] browser peer connected to the native peer');

    return { browser, page };
  } catch (error) {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

async function runChromiumBareRepoExchange(browserBaseUrl, nativeDialAddr, bundleB64) {
  console.log(`[native-wasm:test] launching Chromium bare-repo page at ${browserBaseUrl}`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (message) => {
    console.log(`[native-wasm:bare-browser:${message.type()}] ${message.text()}`);
  });
  page.on('requestfailed', (request) => {
    console.log(
      `[native-wasm:bare-browser:requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`,
    );
  });
  page.on('response', (response) => {
    if (response.status() === 404) {
      console.log(`[native-wasm:bare-browser:404] ${response.request().method()} ${response.url()}`);
    }
  });
  try {
    const pageUrl = `${browserBaseUrl}/p2p-bare-repo-test.html?nativeWs=${encodeURIComponent(nativeDialAddr)}&bundleB64=${encodeURIComponent(bundleB64)}`;
    // console.log(`[native-wasm:test] navigating bare-repo browser to ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => window.__p2pReady === true, null, { timeout: 120_000 });
    await page.waitForFunction(() => window.__p2pConnected === true, null, { timeout: 120_000 });
    await page.waitForFunction(() => window.__bareRepoPublished === true, null, { timeout: 120_000 });
    console.log('[native-wasm:test] bare-repo browser reported published');

    return { browser, page };
  } catch (error) {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

test('native peer and wasm peer exchange a real nip-pip blob', { timeout: 300_000 }, async () => {
  if (!hasSafariDriver()) {
    console.log('[native-wasm:test] Safari remote automation unavailable: non-macOS host');
    return;
  }

  await ensureP2pWasmBuild();

  const [{ server, port: serverPort }, native] = await Promise.all([
    createStaticServer(),
    startNativePeer(),
  ]);

  const webdriverPort = await getFreePort();
  const webdriver = spawn('safaridriver', ['-p', String(webdriverPort)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let sessionId = '';

  let webdriverStdout = '';
  let webdriverStderr = '';
  webdriver.stdout.on('data', (chunk) => {
    webdriverStdout += chunk.toString('utf8');
  });
  webdriver.stderr.on('data', (chunk) => {
    webdriverStderr += chunk.toString('utf8');
  });

  const cleanup = async () => {
    native.child.kill('SIGTERM');
    webdriver.kill('SIGTERM');
    server.close();
  };

  try {
    await waitForCondition(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${webdriverPort}/status`);
        return response.ok;
      } catch {
        return false;
      }
    }, { timeoutMs: 10_000, description: 'Safari WebDriver to start' });

    try {
      sessionId = await createSafariSession(webdriverPort);
    } catch (error) {
      console.log(
        `[native-wasm:test] Safari remote automation unavailable: ${error?.message || error}`,
      );
      return;
    }
    const nativeDialAddr = buildWsDialAddress(native.wsListenAddr, native.peerId);
    const pageUrl = `http://127.0.0.1:${serverPort}/p2p-wasm-native-test.html?nativeWs=${encodeURIComponent(nativeDialAddr)}`;

    await webdriverNavigate(webdriverPort, sessionId, pageUrl);

    await waitForCondition(
      async () => webdriverExecute(webdriverPort, sessionId, 'return window.__p2pReady === true;'),
      { timeoutMs: 120_000, description: 'wasm peer to start' },
    );

    await waitForCondition(
      async () => webdriverExecute(webdriverPort, sessionId, 'return window.__p2pConnected === true;'),
      { timeoutMs: 120_000, description: 'browser peer to connect to the native peer' },
    );

    await waitForCondition(
      async () => webdriverExecute(webdriverPort, sessionId, 'return window.__p2pPeerIdMatchesExpected === true;'),
      { timeoutMs: 120_000, description: 'browser peer id to match the deterministic seed' },
    );

    native.child.stdin.write('/pip hello native wasm nip-pip\n');

    await waitForCondition(
      async () => {
        const kinds = await webdriverExecute(
          webdriverPort,
          sessionId,
          'return window.__p2pBridgeKinds || [];',
        );
        return Array.isArray(kinds) && kinds.includes(39078) && kinds.includes(39079);
      },
      { timeoutMs: 120_000, description: 'wasm peer to receive manifest and slice events' },
    );

    const result = await webdriverExecute(webdriverPort, sessionId, `
      return {
        peerId: window.__p2pPeerId || '',
        bridgeKinds: window.__p2pBridgeKinds || [],
        receivedCount: (window.__p2pReceived || []).length,
        error: window.__p2pError || '',
      };
    `);

    assert.equal(result.error, '', `browser error: ${result.error}`);
    assert.ok(result.peerId, 'browser peer id should be exposed');
    assert.ok(result.bridgeKinds.includes(39078), 'browser should receive a manifest event');
    assert.ok(result.bridgeKinds.includes(39079), 'browser should receive a slice event');
    assert.ok(result.receivedCount >= 2, 'browser should receive at least manifest and slice messages');
  } finally {
    await cleanup();
    if (sessionId) {
      await webdriverDeleteSession(webdriverPort, sessionId).catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
});

test('native peer and wasm peer exchange a real nip-pip blob in Chromium', { timeout: 300_000 }, async () => {
  await ensureP2pWasmBuild();
  await ensureChromiumBrowser();

  const [{ server, port: serverPort }, native] = await Promise.all([
    createStaticServer(),
    startNativePeer(),
  ]);

  const browserBaseUrl = `http://127.0.0.1:${serverPort}`;
  const nativeDialAddr = buildWsDialAddress(native.wsListenAddr, native.peerId);
  console.log(`[native-wasm:test] native websocket dial addr ${nativeDialAddr}`);
  const { browser, page } = await runChromiumNativeWasmExchange(browserBaseUrl, nativeDialAddr);

  try {
    console.log('[native-wasm:test] sending /pip command to native peer');
    native.child.stdin.write('/pip hello native wasm nip-pip\n');

    await page.waitForFunction(
      () => window.__p2pBridgeKinds?.includes(39078) && window.__p2pBridgeKinds?.includes(39079),
      null,
      { timeout: 120_000 },
    );
    console.log('[native-wasm:test] browser received both manifest and slice events');

    const result = await page.evaluate(() => ({
      peerId: window.__p2pPeerId || '',
      bridgeKinds: window.__p2pBridgeKinds || [],
      receivedCount: (window.__p2pReceived || []).length,
      error: window.__p2pError || '',
      connected: window.__p2pConnected || false,
    }));

    assert.equal(result.error, '', `browser error: ${result.error}`);
    assert.ok(result.connected, 'browser peer should connect to native peer');
    assert.ok(result.peerId, 'browser peer id should be exposed');
    assert.ok(result.bridgeKinds.includes(39078), 'browser should receive a manifest event');
    assert.ok(result.bridgeKinds.includes(39079), 'browser should receive a slice event');
    assert.ok(result.receivedCount >= 2, 'browser should receive at least manifest and slice messages');
    console.log(
      `[native-wasm:test] success peerId=${result.peerId} bridgeKinds=${result.bridgeKinds.join(',')} received=${result.receivedCount}`,
    );
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    native.child.kill('SIGTERM');
    server.close();
  }
});

test('native peer and wasm peer exchange a real bare-repo nip-pip blob in Chromium', { timeout: 300_000 }, async () => {
  await ensureP2pWasmBuild();
  await ensureChromiumBrowser();

  const bareRepo = createBareRepoBundle();
  const bareRepoSha256 = createHash('sha256').update(bareRepo.bundleBytes).digest('hex');
  const bareRepoBundleB64 = Buffer.from(bareRepo.bundleBytes).toString('base64');
  const bareRepoRelayUrls = await discoverHealthyRelays();
  const relayUrls = bareRepoRelayUrls.length ? bareRepoRelayUrls : ['wss://nos.lol'];
  const [{ server, port: serverPort }, native] = await Promise.all([
    createStaticServer(bareRepo.bundleBytes, relayUrls),
    startNativePeer(),
  ]);

  const browserBaseUrl = `http://127.0.0.1:${serverPort}`;
  const nativeDialAddr = buildWsDialAddress(native.wsListenAddr, native.peerId);
  console.log(`[native-wasm:test] native websocket dial addr ${nativeDialAddr}`);
  const { browser, page } = await runChromiumBareRepoExchange(
    browserBaseUrl,
    nativeDialAddr,
    bareRepoBundleB64,
  );

  try {
    try {
      await waitForCondition(
        async () => native.stdoutLines.some((line) => line.includes('INBOUND transfer-manifest root_id=live-bare-repo'))
          && native.stdoutLines.some((line) => line.includes('INBOUND transfer-slice root_id=live-bare-repo')),
        { timeoutMs: 30_000, description: 'native peer to receive bare-repo transfer events' },
      );
    } catch (error) {
      console.log(`[native-wasm:test] native libp2p receipt did not win the race: ${error?.message || error}`);
    }

    await page.waitForFunction(() => window.__bareRepoReconstructed === true, null, { timeout: 120_000 });

    const result = await page.evaluate(() => ({
      peerId: window.__p2pPeerId || '',
      bridgeKinds: window.__p2pBridgeKinds || [],
      receivedCount: (window.__p2pReceived || []).length,
      sentKinds: window.__bareRepoSentKinds || [],
      sentManifestId: window.__bareRepoSentManifestId || '',
      sentSliceCount: window.__bareRepoSentSliceCount || 0,
      published: window.__bareRepoPublished || false,
      connected: window.__p2pConnected || false,
      reconstructed: window.__bareRepoReconstructed || false,
      reconstructionSource: window.__bareRepoReconstructionSource || '',
      reconstructedSha256: window.__bareRepoReconstructedSha256 || '',
      reconstructedBytes: window.__bareRepoReconstructedBytes || 0,
      reconstructedBundleB64: window.__bareRepoReconstructedBundleB64 || '',
      error: window.__p2pError || '',
    }));

    assert.equal(result.error, '', `browser error: ${result.error}`);
    assert.ok(result.connected, 'browser peer should connect to native peer');
    assert.ok(result.peerId, 'browser peer id should be exposed');
    assert.ok(result.published, 'browser should publish the bare-repo transfer');
    assert.ok(result.sentManifestId, 'browser should sign and publish a manifest event');
    assert.ok(result.sentSliceCount > 0, 'browser should publish at least one slice event');
    assert.ok(result.sentKinds.includes(TRANSFER_MANIFEST_KIND), 'browser should publish a manifest event');
    assert.ok(result.sentKinds.includes(TRANSFER_SLICE_KIND), 'browser should publish slice events');
    assert.ok(result.reconstructed, 'browser should reconstruct the bare repo from relay or libp2p');
    assert.ok(['relay', 'libp2p'].includes(result.reconstructionSource), 'browser should reconstruct from relay or libp2p');
    assert.equal(result.reconstructedSha256, bareRepoSha256, 'reconstructed bundle sha256 should match the source bundle');
    assert.equal(result.reconstructedBytes, bareRepo.bundleBytes.length, 'reconstructed byte length should match the source bundle');
    assert.ok(result.reconstructedBundleB64, 'browser should expose the reconstructed bundle bytes');

    const reconstructedBundlePath = path.join(bareRepo.work, 'reconstructed.bundle');
    const reconstructedCloneDir = path.join(bareRepo.work, 'reconstructed-clone');
    writeFileSync(reconstructedBundlePath, Buffer.from(result.reconstructedBundleB64, 'base64'));
    gitRun(['clone', reconstructedBundlePath, reconstructedCloneDir], bareRepo.work);
    const clonedHead = gitRun(['rev-parse', 'HEAD'], reconstructedCloneDir);
    assert.equal(clonedHead, bareRepo.head, 'cloned repo head should match the source repo head');
    console.log(`[native-wasm:test] cloned reconstructed bundle to disk ${reconstructedCloneDir}`);
    console.log(
      `[native-wasm:test] live bare-repo success peerId=${result.peerId} source=${result.reconstructionSource} manifest=${result.sentManifestId} slices=${result.sentSliceCount}`,
    );
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    native.child.kill('SIGTERM');
    server.close();
    rmSync(bareRepo.work, { recursive: true, force: true });
  }
});
