import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test('bridge logger state persists across reload', { timeout: 30_000 }, async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    t.diagnostic('navigating to ' + BASE + '/bridge/');
    await page.goto(`${BASE}/bridge/`, { waitUntil: 'load', timeout: 10_000 });
    t.diagnostic('page loaded');

    await page.waitForSelector('[data-footer-toggle]', { timeout: 5_000 });
    t.diagnostic('footer toggle found');

    await page.click('[data-footer-toggle]');
    t.diagnostic('toggle clicked');
    await page.click('[data-footer-level-pill="debug"]');
    t.diagnostic('debug pill clicked');

    const beforeReload = await page.evaluate(() => {
      const keys = Object.keys(localStorage).filter(k => k.includes('logger-footer'));
      return keys.map(k => ({ key: k, value: localStorage.getItem(k) }));
    });
    t.diagnostic('localStorage: ' + JSON.stringify(beforeReload));

    await page.reload({ waitUntil: 'load' });
    t.diagnostic('reloaded');
    await page.waitForSelector('[data-footer-toggle]', { timeout: 5_000 });
    t.diagnostic('footer toggle found after reload');

    const afterReload = await page.evaluate(() => {
      const keys = Object.keys(localStorage).filter(k => k.includes('logger-footer'));
      return keys.map(k => ({ key: k, value: JSON.parse(localStorage.getItem(k)) }));
    });
    t.diagnostic('localStorage after: ' + JSON.stringify(afterReload));
    assert.ok(afterReload.length > 0, 'should have state');
    assert.strictEqual(afterReload[0].value.open, true);
    assert.strictEqual(afterReload[0].value.level, 'debug');
  } finally {
    if (browser) await browser.close();
  }
});
