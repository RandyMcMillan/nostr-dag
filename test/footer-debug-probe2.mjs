import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:3000/git/', { waitUntil: 'load', timeout: 15000 });
await page.waitForTimeout(3000);
const info = await page.evaluate(() => {
  const footer = window.__sharedFooter;
  // Try to access internal logs via the DOM since API may not expose them
  const logItems = Array.from(document.querySelectorAll('.footer-log-item')).map(el => el.textContent);
  // Access the footer element directly to check if setState was ever called
  const statusEl = document.querySelector('[data-footer-status]');
  return {
    logItems: logItems.slice(0, 10),
    statusClass: statusEl?.className,
    statusTitle: statusEl?.title,
    // Check if there's any internal state we can access
    footerKeys: Object.keys(footer || {}),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
