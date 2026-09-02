/**
 * Headless browser test: verify chat messages propagate between two tabs.
 * Tests the BroadcastChannel fallback (same-origin) which works both locally
 * and on GitHub Pages even when libp2p mesh is not yet formed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = process.env.SERVER_URL || process.env.BASE_URL || 'http://127.0.0.1:3000';

async function serverHealthy() {
  try {
    const res = await fetch(`${BASE}/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

test('chat message propagates between two Chromium tabs', { timeout: 45_000 }, async (t) => {
  const hasServer = await serverHealthy();

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

    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    // Load chat page in both tabs
    await pageA.goto(`${BASE}/chat`, { waitUntil: 'load', timeout: 15_000 });
    await pageB.goto(`${BASE}/chat`, { waitUntil: 'load', timeout: 15_000 });

    // Wait for nodes to start (or at least for the UI to be ready)
    await pageA.waitForSelector('#chatInput:not([disabled])', { timeout: hasServer ? 15_000 : 5_000 }).catch(() => {});
    await pageB.waitForSelector('#chatInput:not([disabled])', { timeout: hasServer ? 15_000 : 5_000 }).catch(() => {});

    // If server is not running, the node won't start; but BroadcastChannel
    // still works for same-origin tabs. Trigger start button just in case.
    await pageA.evaluate(() => {
      const btn = document.getElementById('startNodeBtn');
      if (btn && !btn.disabled) btn.click();
    });
    await pageB.evaluate(() => {
      const btn = document.getElementById('startNodeBtn');
      if (btn && !btn.disabled) btn.click();
    });

    // Wait a bit for node startup (especially when server is running)
    await new Promise(r => setTimeout(r, hasServer ? 3000 : 500));

    // Send a unique message from page A
    const testMessage = `cross-tab-test-${Date.now()}`;
    await pageA.evaluate((msg) => {
      const input = document.getElementById('chatInput');
      const btn = document.getElementById('sendBtn');
      if (input) input.value = msg;
      if (btn) btn.click();
    }, testMessage);

    // Wait for the message to appear in page B
    const received = await pageB.waitForFunction(
      (expected) => {
        const container = document.getElementById('chatMessages');
        if (!container) return false;
        return container.textContent.includes(expected);
      },
      testMessage,
      { timeout: 10_000 }
    ).then(() => true).catch(() => false);

    assert.ok(received, `page B should receive the message from page A: "${testMessage}"`);

    // Also verify page A sees its own message
    const selfReceived = await pageA.evaluate((expected) => {
      const container = document.getElementById('chatMessages');
      return container ? container.textContent.includes(expected) : false;
    }, testMessage);
    assert.ok(selfReceived, `page A should display its own sent message`);
  } finally {
    if (browser) await browser.close();
  }
});
