import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test('wait for local peer connection', { timeout: 120_000 }, async (t) => {
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

  await page.goto(`${BASE}/git/`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForFunction(
    () => window.__gitViewerP2pTransport != null,
    { timeout: 20_000 }
  );

  // Wait up to 60 seconds for a local connection
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2_000);
    const state = await page.evaluate(() => {
      const node = window.__gitViewerP2pTransport?.node;
      const conns = [];
      try {
        if (node?.getConnections) {
          for (const c of node.getConnections()) {
            conns.push(c.remotePeer?.toString?.() || 'unknown');
          }
        }
      } catch (_) {}
      return { conns };
    });
    console.log(`Attempt ${i + 1}:`, state.conns);
    if (state.conns.includes('12D3KooWSL8rLNFrwVGVBJbHWxXQfFTfVtYnozURrqBFYBMfrniH')) {
      console.log('CONNECTED to local peer!');
      break;
    }
  }

  await browser.close();
});
