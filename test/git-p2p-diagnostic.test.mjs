import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test('diagnose P2P connection state', { timeout: 60_000 }, async (t) => {
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
  const logs = [];
  page.on('console', (msg) => {
    const text = `[${msg.type()}] ${msg.text()}`;
    logs.push(text);
    console.log(text);
  });

  await page.goto(`${BASE}/git/`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForFunction(
    () => window.__gitViewerP2pTransport != null,
    { timeout: 20_000 }
  );
  await page.waitForTimeout(10_000);

  const state = await page.evaluate(async () => {
    const transport = window.__gitViewerP2pTransport;
    const node = transport?.node;
    const connections = [];
    try {
      if (node?.getConnections) {
        for (const c of node.getConnections()) {
          connections.push({
            peer: c.remotePeer?.toString?.() || 'unknown',
            addr: c.remoteAddr?.toString?.() || 'unknown',
          });
        }
      }
    } catch (_) {}
    return {
      peerId: node?.peerId?.toString?.() || 'none',
      connections,
      transportStarted: transport?.started || false,
      pendingRequests: transport ? Array.from(transport.pendingRequests.keys()) : [],
    };
  });

  console.log('Browser P2P state:', JSON.stringify(state, null, 2));

  // Try requesting a bundle and capture the result
  const bundleResult = await page.evaluate(async () => {
    const transport = window.__gitViewerP2pTransport;
    try {
      const bundle = await transport.requestBundle('https://github.com/RandyMcMillan/nostr-dag', 15_000);
      return { ok: true, length: bundle.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  console.log('Bundle result:', bundleResult);

  await browser.close();
});
