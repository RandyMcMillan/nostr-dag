import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test('check bootstrap peers include local native', { timeout: 60_000 }, async (t) => {
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
    logs.push(`[${msg.type()}] ${msg.text()}`);
  });

  await page.goto(`${BASE}/git/`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForFunction(
    () => window.__gitViewerP2pTransport != null,
    { timeout: 20_000 }
  );
  await page.waitForTimeout(10_000);

  const state = await page.evaluate(() => {
    const stack = window.__gitP2pStack; // might not exist
    const node = window.__gitViewerP2pTransport?.node;
    return {
      stackBootstrapPeers: stack?.bootstrapPeers || [],
      conns: (() => {
        const arr = [];
        try {
          if (node?.getConnections) {
            for (const c of node.getConnections()) {
              arr.push(c.remotePeer?.toString?.() || 'unknown');
            }
          }
        } catch (_) {}
        return arr;
      })(),
    };
  });

  console.log('State:', JSON.stringify(state, null, 2));
  console.log('Logs:', logs.filter(l => l.includes('bootstrap') || l.includes('local') || l.includes('dial')).join('\n'));

  await browser.close();
});
