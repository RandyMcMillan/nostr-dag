/**
 * Headless browser test: verify the bridge page renders the local embedded peer.
 * This proves /peers polling works and the UI displays native peers correctly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test('bridge page shows local embedded peer in Chromium', { timeout: 30_000 }, async (t) => {
  let browser;
  try {
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
    await page.goto(`${BASE}/bridge/`, { waitUntil: 'load', timeout: 15_000 });

    // Wait for peer list to be populated (polls /peers every few seconds)
    const peerFound = await page.waitForFunction(
      () => {
        const list = document.getElementById('peerList');
        if (!list) return false;
        return list.textContent.includes('12D3KooWSL8rLNFrwVGVBJbHWxXQfFTfVtYnozURrqBFYBMfrniH');
      },
      undefined,
      { timeout: 10_000 }
    ).then(() => true).catch(() => false);

    assert.ok(peerFound, 'bridge page should display the deterministic local peer');

    const count = await page.evaluate(() => document.getElementById('peerCount')?.textContent);
    assert.ok(Number(count) >= 1, `peerCount should be >= 1, got ${count}`);
  } finally {
    if (browser) await browser.close();
  }
});
