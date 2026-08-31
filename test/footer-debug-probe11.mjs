import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const logs = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (text.includes('[commitBatch]')) logs.push(text);
});
await page.goto('http://127.0.0.1:3000/git/', { waitUntil: 'load', timeout: 15000 });
await page.waitForTimeout(5000);
console.log(logs.join('\n'));
await browser.close();
