import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const logs = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (text.includes('[flushFooterBuffer]') || text.includes('[commitBatch]') || text.includes('[setState]') || text.includes('[setStatus]')) {
    logs.push(text);
  }
});
await page.goto('http://127.0.0.1:3000/git/', { waitUntil: 'load', timeout: 15000 });
await page.waitForTimeout(3000);
console.log(logs.join('\n'));
await browser.close();
