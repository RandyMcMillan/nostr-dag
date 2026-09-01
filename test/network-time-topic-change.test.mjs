/**
 * Headless browser test: verify the network time page topic can be changed
 * and the UI reflects the new topic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = process.env.SERVER_URL || process.env.BASE_URL || 'http://127.0.0.1:3000';

async function serverHealthy() {
  try {
    const res = await fetch(`${BASE}/network_time.html`, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
    return res.ok || res.status === 302 || res.status === 304;
  } catch {
    return false;
  }
}

test('network time topic change updates the UI', { timeout: 30_000 }, async (t) => {
  if (!(await serverHealthy())) {
    t.skip('server not running — start nostr-dag-server to run this test');
    return;
  }

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
    await page.goto(`${BASE}/network_time.html`, { waitUntil: 'load', timeout: 15_000 });

    // Default topic should be nostr-dag-bridge
    const defaultTopic = await page.evaluate(() => document.getElementById('topicInput')?.value);
    assert.strictEqual(defaultTopic, 'nostr-dag-bridge', 'default topic input should be nostr-dag-bridge');

    const defaultLabel = await page.evaluate(() => document.getElementById('topicLogLabel')?.textContent);
    assert.strictEqual(defaultLabel, 'nostr-dag-bridge', 'default topic label should be nostr-dag-bridge');

    // Change topic
    await page.fill('#topicInput', 'test-topic-42');
    await page.click('#applyTopicBtn');

    // Wait for label to update
    const labelUpdated = await page.waitForFunction(
      () => document.getElementById('topicLogLabel')?.textContent === 'test-topic-42',
      undefined,
      { timeout: 5_000 }
    ).then(() => true).catch(() => false);

    assert.ok(labelUpdated, 'topic label should update to test-topic-42 after clicking Apply');

    // Verify input still holds the new value
    const newTopic = await page.evaluate(() => document.getElementById('topicInput')?.value);
    assert.strictEqual(newTopic, 'test-topic-42', 'topic input should retain test-topic-42');
  } finally {
    if (browser) await browser.close();
  }
});
