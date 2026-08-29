/**
 * End-to-end test that verifies the browser can request a git bundle from the
 * local native peer via libp2p gossipsub (NIP-PIP) and receive it back.
 *
 * Prerequisites:
 *   - nostr-dag-server running with P2P_ENABLE=1 and p2p,native features
 *   - Server has mirrored the repo (via GIT_MIRROR_REPOS)
 *
 * The test opens the git page so the libp2p stack initialises, waits for the
 * P2P transport to be ready, then directly calls requestBundle() and asserts
 * the returned payload is a non-empty Uint8Array.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const REPO_URL = 'https://github.com/RandyMcMillan/nostr-dag';

// Allow up to 90 s for libp2p discovery + bundle reconstruction.
test('browser fetches git bundle from native peer via PIP', { timeout: 90_000 }, async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    if (err.message && err.message.includes("Executable doesn't exist")) {
      t.skip('Playwright browsers not installed');
      return;
    }
    throw err;
  }

  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(`PAGE ERROR: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`CONSOLE ERROR: ${msg.text()}`);
  });

  // 1. Load the git page so libp2p + GitP2PTransport initialise.
  await page.goto(`${BASE}/git/`, { waitUntil: 'networkidle', timeout: 30_000 });

  // 2. Wait for the transport to exist.
  await page.waitForFunction(
    () => window.__gitViewerP2pTransport != null,
    { timeout: 20_000 }
  );

  // 3. Give libp2p a few seconds to dial the native peer and subscribe.
  await page.waitForTimeout(8_000);

  // 4. Request the bundle directly from the page context.
  const bundleInfo = await page.evaluate(async (url) => {
    const transport = window.__gitViewerP2pTransport;
    try {
      const bundle = await transport.requestBundle(url, 45_000);
      return { ok: true, length: bundle.length, type: Object.prototype.toString.call(bundle) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }, REPO_URL);

  if (!bundleInfo.ok) {
    // If P2P failed, log the error but do not hard-fail yet — the proxy
    // fallback keeps the page usable.  We just want visibility.
    console.log(`PIP bundle fetch result: ${bundleInfo.error}`);
  }

  // For CI we assert success once the native peer is reliably online.
  assert.ok(bundleInfo.ok, `expected bundle fetch to succeed, got: ${bundleInfo.error}`);
  assert.ok(bundleInfo.length > 0, 'bundle should be non-empty');
  assert.strictEqual(bundleInfo.type, '[object Uint8Array]', 'bundle should be Uint8Array');
  assert.strictEqual(errors.length, 0, `no console errors expected, got: ${errors.join('; ')}`);

  await browser.close();
});
