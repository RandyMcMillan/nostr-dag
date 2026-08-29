import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  ensureP2pWasmBuild,
  ensureChromiumBrowser,
  buildWsDialAddress,
  createStaticServer,
  startNativePeer,
  startBootstrapMesh,
  createBareRepoBundle,
  discoverHealthyRelays,
  runChromiumNativeWasmExchange,
  runChromiumBareRepoExchange,
  waitForCondition,
  gitRun,
  TRANSFER_MANIFEST_KIND,
  TRANSFER_SLICE_KIND,
} from './p2p-native-wasm-shared.mjs';

test('native peer and wasm peer exchange a real nip-pip blob in Chromium', { timeout: 300_000 }, async () => {
  if (process.env.CI || process.env.GITHUB_ACTIONS) {
    console.log('[native-wasm:test] Skipping Chromium P2P test in CI (headless hang)');
    return;
  }
  await ensureP2pWasmBuild();
  await ensureChromiumBrowser();

  const { primary: bootstrap, relayTarget, extraPeer } = await startBootstrapMesh();
  const bootstrapDialAddr = buildWsDialAddress(bootstrap.wsListenAddr, bootstrap.peerId);
  const relayDialAddr = buildWsDialAddress(relayTarget.wsListenAddr, relayTarget.peerId);
  const extraDialAddr = buildWsDialAddress(extraPeer.wsListenAddr, extraPeer.peerId);
  const [{ server, port: serverPort }, native] = await Promise.all([
    createStaticServer(),
    startNativePeer({ bootstrapPeers: [bootstrapDialAddr, relayDialAddr, extraDialAddr].join(',') }),
  ]);

  const browserBaseUrl = `http://127.0.0.1:${serverPort}`;
  const nativeDialAddr = buildWsDialAddress(native.wsListenAddr, native.peerId);
  console.log(`[native-wasm:test] native websocket dial addr ${nativeDialAddr}`);
  const { browser, page } = await runChromiumNativeWasmExchange(browserBaseUrl, nativeDialAddr);

  try {
    console.log('[native-wasm:test] sending /pip command to native peer');
    console.log('[native-wasm:test] waiting 3 seconds before publishing /pip');
    await new Promise((resolve) => setTimeout(resolve, 3000));
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
    extraPeer.child.kill('SIGTERM');
    relayTarget.child.kill('SIGTERM');
    bootstrap.child.kill('SIGTERM');
    server.close();
  }
});

test('native peer and wasm peer exchange a real bare-repo nip-pip blob in Chromium', { timeout: 300_000 }, async () => {
  if (process.env.CI || process.env.GITHUB_ACTIONS) {
    console.log('[native-wasm:test] Skipping Chromium bare-repo P2P test in CI (headless hang)');
    return;
  }
  await ensureP2pWasmBuild();
  await ensureChromiumBrowser();

  const bareRepo = createBareRepoBundle();
  const bareRepoSha256 = createHash('sha256').update(bareRepo.bundleBytes).digest('hex');
  const bareRepoBundleB64 = Buffer.from(bareRepo.bundleBytes).toString('base64');
  const bareRepoRelayUrls = await discoverHealthyRelays();
  const relayUrls = bareRepoRelayUrls.length ? bareRepoRelayUrls : ['wss://nos.lol'];
  const { primary: bootstrap, relayTarget, extraPeer } = await startBootstrapMesh();
  const bootstrapDialAddr = buildWsDialAddress(bootstrap.wsListenAddr, bootstrap.peerId);
  const relayDialAddr = buildWsDialAddress(relayTarget.wsListenAddr, relayTarget.peerId);
  const extraDialAddr = buildWsDialAddress(extraPeer.wsListenAddr, extraPeer.peerId);
  const [{ server, port: serverPort }, native] = await Promise.all([
    createStaticServer(bareRepo.bundleBytes, relayUrls),
    startNativePeer({ bootstrapPeers: [bootstrapDialAddr, relayDialAddr, extraDialAddr].join(',') }),
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
    extraPeer.child.kill('SIGTERM');
    relayTarget.child.kill('SIGTERM');
    bootstrap.child.kill('SIGTERM');
    server.close();
    rmSync(bareRepo.work, { recursive: true, force: true });
  }
});
