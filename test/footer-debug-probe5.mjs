import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:3000/git/', { waitUntil: 'load', timeout: 15000 });
await page.waitForTimeout(1000);
await page.evaluate(() => {
  window.__stateHistory = [];
  const footer = window.__sharedFooter;
  if (footer && footer.setState) {
    const orig = footer.setState.bind(footer);
    footer.setState = function(...args) {
      window.__stateHistory.push({ t: Date.now(), args: JSON.stringify(args) });
      return orig(...args);
    };
  }
});
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
