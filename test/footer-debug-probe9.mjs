import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:3000/git/', { waitUntil: 'load', timeout: 15000 });
await page.waitForTimeout(5000);
const info = await page.evaluate(() => {
  // Find the footer iframe or worker? No, just check internal state via DOM
  const statusEl = document.querySelector('[data-footer-status]');
  return {
    statusClass: statusEl?.className,
    statusTitle: statusEl?.title,
    // Try to find any global that exposes logs
    sharedFooterKeys: Object.keys(window.__sharedFooter || {}),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
