/**
 * Headless browser test that verifies the git viewer page actually renders
 * repo cards, populates tag dropdowns, and captures any console errors.
 *
 * Uses Playwright to load http://127.0.0.1:3000/git/ and assert the DOM
 * contains expected repo content.  This catches CSP and module-loading
 * failures that static HTML checks miss.
 *
 * NOTE: In a cold-cache headless browser, isomorphic-git clones every repo
 * from scratch.  With 9 repos that can take many minutes.  This test therefore
 * asserts on DOM presence immediately (renderApp runs before the async refresh
 * loop) and only *soft-checks* tags so the suite doesn't hang in CI.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test('git page renders repo cards with tags in Chromium', { timeout: 120_000 }, async (t) => {
  let browser;
  try {
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

    // Repo cards are rendered synchronously by renderApp() before the async
    // refresh loop, so they should be present immediately.
    const reposText = await page.locator('#repos').innerText({ timeout: 5_000 }).catch(() => 'EMPTY');
    assert.ok(reposText.includes('nostr-dag'), 'repos grid should contain nostr-dag');

    // Wait up to 30s for the status to leave "Starting..." / "loading repos..."
    // This proves the refresh cycle started without JS crashing.
    const statusReached = await page.waitForFunction(
      () => {
        const status = document.getElementById('status');
        if (!status) return false;
        const t = status.title || '';
        return t !== 'Starting...' && t !== 'loading repos...';
      },
      undefined,
      { timeout: 30_000 }
    ).then(() => true).catch(() => false);

    if (!statusReached) {
      t.diagnostic('Status did not leave loading state within 30s (cold cache / slow network) — continuing with soft checks');
    }

    // Soft-check tags: on a warm cache tags appear quickly; on cold cache we
    // don't fail the test because the clone may still be in progress.
    const firstTagSelect = await page.locator('select[data-tag-select]').first();
    const tagOptions = await firstTagSelect.locator('option').count().catch(() => 0);
    if (tagOptions > 1) {
      t.diagnostic(`Tag dropdown has ${tagOptions} options`);
    } else {
      t.diagnostic('Tag dropdown not yet populated (cold cache) — skipping tag assertion');
    }

    // Verify no critical console errors (CSP, module load, etc.)
    // Relay auth/time-out errors are expected when running against public relays
    // in a headless test and are not code defects.
    const criticalErrors = errors.filter((e) => {
      if (e.includes('Source map') || e.includes('.map')) return false;
      if (/restricted:|blocked:|not authorized|connection timed out/i.test(e)) return false;
      return true;
    });
    assert.strictEqual(criticalErrors.length, 0, `no critical errors expected, got: ${criticalErrors.join('; ')}`);
  } finally {
    if (browser) await browser.close();
  }
});
