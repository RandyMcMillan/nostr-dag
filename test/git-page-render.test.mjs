/**
 * Headless browser test that verifies the git viewer page actually renders
 * repo cards, populates tag dropdowns, and captures any console errors.
 *
 * Uses Playwright to load http://127.0.0.1:3000/git/ and assert the DOM
 * contains expected repo content.  This catches CSP and module-loading
 * failures that static HTML checks miss.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test('git page renders repo cards with tags in Chromium', { timeout: 120_000 }, async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    if (err.message && err.message.includes("Executable doesn't exist")) {
      t.skip('Playwright browsers not installed — skipping headless render test');
      return;
    }
    throw err;
  }

  const page = await browser.newPage();
  const errors = [];
  const warns = [];

  page.on('pageerror', (err) => errors.push(`PAGE ERROR: ${err.message}`));
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error') errors.push(`CONSOLE ERROR: ${text}`);
    if (msg.type() === 'warning') warns.push(`CONSOLE WARN: ${text}`);
  });

  await page.goto(`${BASE}/git/`, { waitUntil: 'networkidle', timeout: 30_000 });

  // Wait for repos to finish loading (refreshList runs on boot).
  // The refresh cycle can take 10-30s depending on network.
  await page.waitForFunction(
    () => {
      const status = document.getElementById('status');
      return status && (status.title === 'ready' || status.title.startsWith('partial:'));
    },
    { timeout: 90_000 }
  );

  const reposText = await page.locator('#repos').innerText({ timeout: 5_000 }).catch(() => 'EMPTY');
  assert.ok(reposText.includes('nostr-dag'), 'repos grid should contain nostr-dag');

  // Verify at least one repo card has tags in its dropdown.
  const firstTagSelect = await page.locator('select[data-tag-select]').first();
  const tagOptions = await firstTagSelect.locator('option').count();
  assert.ok(tagOptions > 1, `expected tag dropdown to have options, got ${tagOptions}`);

  // Verify no critical console errors.
  const criticalErrors = errors.filter((e) => !e.includes('Source map') && !e.includes('.map'));
  assert.strictEqual(criticalErrors.length, 0, `no critical errors expected, got: ${criticalErrors.join('; ')}`);

  await browser.close();
});
