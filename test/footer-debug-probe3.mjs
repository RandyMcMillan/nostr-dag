import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:3000/git/', { waitUntil: 'load', timeout: 15000 });
await page.waitForTimeout(3000);
const info = await page.evaluate(() => {
  const statusEl = document.querySelector('[data-footer-status]');
  return {
    statusClass: statusEl?.className,
    statusTitle: statusEl?.title,
    currentState: window.__sharedFooter?.getState?.(),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
