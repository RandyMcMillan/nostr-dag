import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
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

function createStaticServer(bareRepoBundleBytes = null) {
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
        if (url.pathname === '/p2p-wasm-native-test.html') {
          const nativeWs = url.searchParams.get('nativeWs') || '';
          const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <link rel="icon" href="/site/favicon.ico">
    <title>waiting</title>
  </head>
  <body>
    <pre id="status">starting</pre>
    <script type="module">
      import initWasm, * as wasmPkg from '/site/pkg/nostr_dag.js';
      import { createSharedLibp2pStack, deterministicPeerIdFromSeed } from '/demo/shared/libp2p-stack.mjs';

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
          finish(null, { child, stdout, stderr, peerId, wsListenAddr });
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
