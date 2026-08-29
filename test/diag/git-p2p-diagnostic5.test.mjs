import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test('direct libp2p stack creation with console logging', { timeout: 60_000 }, async (t) => {
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

  // Load the page first so modules are cached
  await page.goto(`${BASE}/git/`, { waitUntil: 'networkidle', timeout: 30_000 });

  // Create a fresh stack directly in the page with console logging
  const result = await page.evaluate(async () => {
    const { createSharedLibp2pStack } = await import('../shared/libp2p-stack.mjs');
    const logs = [];
    const { node, bootstrapPeers } = await createSharedLibp2pStack({
      onLog(level, text, state) {
        logs.push({ level, text, state });
        console.log(`[libp2p ${level}] ${text}`);
      },
      onPeer({ kind, peer, detail }) {
        logs.push({ level: 'peer', text: `${kind}: ${peer}`, detail });
        console.log(`[libp2p peer] ${kind}: ${peer}`);
      },
    });

    await new Promise(r => setTimeout(r, 10_000));

    const conns = [];
    try {
      if (node.getConnections) {
        for (const c of node.getConnections()) {
          conns.push({
            peer: c.remotePeer?.toString?.() || 'unknown',
            addr: c.remoteAddr?.toString?.() || 'unknown',
          });
        }
      }
    } catch (_) {}

    return { logs, bootstrapPeers, conns, peerId: node.peerId?.toString?.() };
  });

  console.log('Result:', JSON.stringify(result, null, 2));

  await browser.close();
});
