import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://test-ipv6.com/');
  await page.waitForTimeout(10000);
  const text = await page.evaluate(() => document.body.innerText);
  console.log(text.includes('IPv6') ? 'page loaded' : 'failed');
  console.log(text.substring(0, 500));
  await browser.close();
})();
