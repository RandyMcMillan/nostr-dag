/**
 * Headless browser test that verifies the git viewer page actually renders
 * repo cards and captures any console errors.
 *
 * Uses Playwright to load http://127.0.0.1:3000/git/ and assert the DOM
 * contains expected repo content.  This catches CSP and module-loading
 * failures that static HTML checks miss.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test('git page renders repo cards in Chromium', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];

  page.on('pageerror', (err) => errors.push(`PAGE ERROR: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`CONSOLE ERROR: ${msg.text()}`);
  });

  await page.goto(`${BASE}/git/`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(5_000);

  const reposText = await page.locator('#repos').innerText({ timeout: 5_000 }).catch(() => 'EMPTY');
  assert.ok(reposText.includes('nostr-dag'), 'repos grid should contain nostr-dag');
  assert.strictEqual(errors.length, 0, `no console errors expected, got: ${errors.join('; ')}`);

  await browser.close();
});
