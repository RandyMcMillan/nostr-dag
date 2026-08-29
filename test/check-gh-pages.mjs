import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://randymcmillan.github.io/nostr-dag/bridge/');
  await page.waitForTimeout(60000);
  
  const peers = await page.evaluate(() => {
    const peerList = document.getElementById('peerList');
    if (!peerList) return 'no peerList';
    return [...peerList.querySelectorAll('.bridge-peer')].map(el => {
      const key = el.getAttribute('data-peer-key') || '';
      const parts = key.split(':');
      return { key, peerId: parts[2] || '', kind: parts[3] || '' };
    });
  });
  
  console.log('Peers found:', JSON.stringify(peers, null, 2));
  
  await browser.close();
})();
