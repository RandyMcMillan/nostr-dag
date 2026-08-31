import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.addInitScript(() => {
  window.__stateHistory = [];
  const origSetState = Object.getOwnPropertyDescriptor(Object.prototype, 'setState');
});
await page.goto('http://127.0.0.1:3000/git/', { waitUntil: 'load', timeout: 15000 });
await page.waitForTimeout(3000);
const info = await page.evaluate(() => {
  return {
    stateHistory: window.__stateHistory || [],
    statusClass: document.querySelector('[data-footer-status]')?.className,
    statusTitle: document.querySelector('[data-footer-status]')?.title,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
