import { chromium } from 'playwright';

const PEER_ID = '12D3KooWSL8rLNFrwVGVBJbHWxXQfFTfVtYnozURrqBFYBMfrniH';
const URL = 'https://randymcmillan.github.io/nostr-dag/bridge/';
const TIMEOUT_MS = 120000;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

console.log(`Opening ${URL}...`);
await page.goto(URL, { waitUntil: 'domcontentloaded' });

const start = Date.now();
let found = false;

while (Date.now() - start < TIMEOUT_MS) {
  const html = await page.content();
  if (html.includes(PEER_ID)) {
    found = true;
    break;
  }
  await page.waitForTimeout(2000);
  process.stdout.write('.');
}

if (found) {
  console.log('\n✅ SUCCESS: Deterministic peer found on GH Pages bridge');
  const title = await page.locator('.bridge-peer-title:has-text("' + PEER_ID + '")').textContent().catch(() => 'n/a');
  console.log('Peer title:', title.trim());
} else {
  console.log('\n❌ FAILURE: Peer not found within ' + TIMEOUT_MS + 'ms');
  const peers = await page.locator('.bridge-peer-title').allTextContents().catch(() => []);
  console.log('Peers found:', peers.length ? peers : 'none');
}

await browser.close();
process.exit(found ? 0 : 1);
