import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test('diagnose local peer dial errors', { timeout: 60_000 }, async (t) => {
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
  await page.waitForTimeout(5_000);

  const dialResults = await page.evaluate(async () => {
    const node = window.__gitViewerP2pTransport?.node;
    if (!node) return { nodeMissing: true };
    const addrs = [
      '/ip4/127.0.0.1/tcp/56880/ws',
      '/ip4/127.0.0.1/tcp/56881/tls/ws',
    ];
    const results = [];
    for (const addr of addrs) {
      try {
        await node.dial(addr);
        results.push({ addr, ok: true });
      } catch (err) {
        results.push({ addr, ok: false, error: err?.message || String(err) });
      }
    }
    return { nodeMissing: false, results };
  });

  console.log('Dial results:', JSON.stringify(dialResults, null, 2));

  await browser.close();
});
