import test from 'node:test';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test('monitor network for WebSocket attempts', { timeout: 60_000 }, async (t) => {
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
  const wsUrls = [];

  page.on('websocket', ws => {
    wsUrls.push(ws.url());
    console.log('WebSocket created:', ws.url());
  });

  page.on('request', req => {
    if (req.url().startsWith('ws')) {
      console.log('WS request:', req.url(), req.method());
    }
  });

  page.on('requestfailed', req => {
    if (req.url().startsWith('ws')) {
      console.log('WS failed:', req.url(), req.failure()?.errorText);
    }
  });

  await page.goto(`${BASE}/git/`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForFunction(
    () => window.__gitViewerP2pTransport != null,
    { timeout: 20_000 }
  );
  await page.waitForTimeout(15_000);

  console.log('All WebSocket URLs:', wsUrls);

  await browser.close();
});
