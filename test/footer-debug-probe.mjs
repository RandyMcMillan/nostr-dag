import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:3000/git/', { waitUntil: 'load', timeout: 15000 });
await page.waitForTimeout(3000);
const info = await page.evaluate(() => {
  const footer = window.__sharedFooter;
  return {
    hasFooter: !!footer,
    isReady: footer?.__demoFooterReady,
    isProxy: !footer?.getMetrics,
    metrics: footer?.getMetrics ? footer.getMetrics() : null,
    queueDepth: footer?.getMetrics ? footer.getMetrics().queueDepth : null,
    lastLog: footer?.getLogsForLevel ? footer.getLogsForLevel('debug', 1) : null,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
