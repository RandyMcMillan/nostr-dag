import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const workerLogs = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (text.includes('[commitBatch]') || text.includes('[setState]') || text.includes('[setStatus]')) {
    workerLogs.push({ type: 'page', text });
  }
});
page.on('pageerror', (err) => {
  workerLogs.push({ type: 'error', text: err.message });
});
page.on('worker', (worker) => {
  worker.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[commitBatch]') || text.includes('[setState]') || text.includes('[setStatus]')) {
      workerLogs.push({ type: 'worker', text });
    }
  });
});
await page.goto('http://127.0.0.1:3000/git/', { waitUntil: 'load', timeout: 15000 });
await page.waitForTimeout(5000);
console.log(JSON.stringify(workerLogs, null, 2));
await browser.close();
