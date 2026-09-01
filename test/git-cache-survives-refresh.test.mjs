/**
 * Verifies that git repo cache (tags/branches) survives a browser refresh.
 * Injects synthetic cache data, reloads the page, and asserts the
 * dropdowns are populated immediately without waiting for network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { APP_VERSION } from '../demo/shared/app-version.generated.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const CACHE_KEY = `nostr-dag-git-repo-cache-${APP_VERSION}`;

async function serverHealthy() {
  try {
    const res = await fetch(`${BASE}/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

test('git repo cache survives browser refresh', { timeout: 30_000 }, async (t) => {
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

    // Load page and inject fake cache
    await page.goto(`${BASE}/git/`, { waitUntil: 'load', timeout: 15_000 });
    await page.evaluate((key) => {
      const cache = {
        'nostr-dag': {
          tags: ['v0.13.0', 'v0.18.3', 'v0.19.0'],
          branches: ['master', 'develop'],
          commits: [{ oid: 'abc123', summary: 'test', author: 'test', date: '2024-01-01' }],
          latest: 'test latest',
          latestCommit: { oid: 'abc123', summary: 'test', author: 'test', date: '2024-01-01' },
          files: ['Cargo.toml'],
          ref: 'master',
          selectedRef: 'master',
          serverRefs: [],
          tagMap: { 'v0.13.0': 'abc123', 'v0.18.3': 'abc123', 'v0.19.0': 'abc123' },
        },
      };
      localStorage.setItem(key, JSON.stringify(cache));
    }, CACHE_KEY);

    // Refresh and check dropdown is populated immediately
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(500);

    const tagValues = await page.evaluate(() => {
      const select = document.querySelector('select[data-tag-select="nostr-dag"]');
      return select ? Array.from(select.options).map((o) => o.value) : [];
    });

    assert.ok(tagValues.includes('v0.13.0'), `tag dropdown should contain v0.13.0, got: ${tagValues.join(',')}`);
    assert.ok(tagValues.includes('v0.18.3'), `tag dropdown should contain v0.18.3, got: ${tagValues.join(',')}`);

    const status = await page.evaluate(() => document.getElementById('status')?.title);
    assert.ok(status && (status.includes('ready') || status.includes('refreshing')), `status should indicate ready/refreshing, got: ${status}`);
  } finally {
    if (browser) await browser.close();
  }
});
