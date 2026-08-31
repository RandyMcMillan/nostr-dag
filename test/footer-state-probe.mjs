import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const states = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (text.includes('footer') || text.includes('status') || text.includes('loading')) {
    states.push({ t: Date.now(), type: 'console', text });
  }
});
await page.goto('http://127.0.0.1:3000/git/', { waitUntil: 'load', timeout: 15000 });
for (let i = 0; i < 20; i++) {
  const cls = await page.evaluate(() => {
    const el = document.querySelector('[data-footer-status]');
    return el ? el.className : 'missing';
  });
  const headerStatus = await page.evaluate(() => {
    const el = document.getElementById('status');
    return el ? { className: el.className, title: el.title } : 'missing';
  });
  states.push({ t: Date.now(), type: 'poll', footerClass: cls, headerStatus });
  await page.waitForTimeout(500);
}
console.log(JSON.stringify(states, null, 2));
await browser.close();
