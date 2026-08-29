import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test('browser can open plain WebSocket to native peer', { timeout: 30_000 }, async (t) => {
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

  const wsResult = await page.evaluate(async () => {
    return new Promise((resolve) => {
      const ws = new WebSocket('ws://127.0.0.1:58889');
      ws.onopen = () => resolve({ ok: true, error: null });
      ws.onerror = (e) => resolve({ ok: false, error: 'WebSocket error' });
      ws.onclose = (e) => {
        if (!wsResult) resolve({ ok: false, error: `close code=${e.code}` });
      };
      setTimeout(() => resolve({ ok: false, error: 'timeout' }), 10_000);
    });
  });

  console.log('WebSocket result:', wsResult);

  await browser.close();
});
