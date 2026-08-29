import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import {
  ensureP2pWasmBuild,
  getFreePort,
  hasSafariDriver,
  buildWsDialAddress,
  createStaticServer,
  startBootstrapPeer,
  startNativePeer,
  waitForCondition,
  createSafariSession,
  webdriverNavigate,
  webdriverExecute,
  webdriverDeleteSession,
} from './p2p-native-wasm-shared.mjs';

test('native peer and wasm peer exchange a real nip-pip blob', { timeout: 300_000 }, async () => {
  if (!hasSafariDriver()) {
    console.log('[native-wasm:test] Safari remote automation unavailable: non-macOS host');
    return;
  }

  await ensureP2pWasmBuild();

  const bootstrap = await startBootstrapPeer();
  const bootstrapDialAddr = buildWsDialAddress(bootstrap.wsListenAddr, bootstrap.peerId);
  const [{ server, port: serverPort }, native] = await Promise.all([
    createStaticServer(),
    startNativePeer({ bootstrapPeers: bootstrapDialAddr }),
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

    console.log('[native-wasm:test] waiting 3 seconds before publishing /pip');
    await new Promise((resolve) => setTimeout(resolve, 3000));
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
    bootstrap.child.kill('SIGTERM');
    if (sessionId) {
      await webdriverDeleteSession(webdriverPort, sessionId).catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
});
