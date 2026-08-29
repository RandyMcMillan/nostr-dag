import test from 'node:test';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test('manual peer store dial', { timeout: 60_000 }, async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    if (err.message && err.message.includes("Executable doesn't exist")) {
      t.skip('Playwright browsers not installed');
      return;
    }
    throw err;
  }

  const page = await browser.newPage();

  await page.goto(`${BASE}/git/`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForFunction(
    () => window.__gitViewerP2pTransport != null,
    { timeout: 20_000 }
  );
  await page.waitForTimeout(5_000);

  const result = await page.evaluate(async () => {
    const node = window.__gitViewerP2pTransport?.node;
    if (!node) return { noNode: true };

    const peerIdStr = '12D3KooWSL8rLNFrwVGVBJbHWxXQfFTfVtYnozURrqBFYBMfrniH';
    const addrStr = '/ip4/127.0.0.1/tcp/58889/ws/p2p/12D3KooWSL8rLNFrwVGVBJbHWxXQfFTfVtYnozURrqBFYBMfrniH';

    // Try different dial approaches
    const attempts = [];

    // 1. Dial by string multiaddr
    try {
      await node.dial(addrStr);
      attempts.push({ method: 'string', ok: true });
    } catch (e) {
      attempts.push({ method: 'string', ok: false, error: e?.message || String(e) });
    }

    // 2. Check peerStore methods
    attempts.push({
      method: 'peerStoreMethods',
      save: typeof node.peerStore?.save,
      patch: typeof node.peerStore?.patch,
      addressBook: typeof node.peerStore?.addressBook?.set,
    });

    // 3. Try peerStore.patch if available
    try {
      if (node.peerStore?.patch) {
        // peerId might need to be an object
        const { peerIdFromString } = await import('@libp2p/peer-id');
        const peerId = peerIdFromString(peerIdStr);
        await node.peerStore.patch(peerId, { multiaddrs: [addrStr] });
        await node.dial(peerId);
        attempts.push({ method: 'peerStore.patch', ok: true });
      } else {
        attempts.push({ method: 'peerStore.patch', ok: false, error: 'no patch method' });
      }
    } catch (e) {
      attempts.push({ method: 'peerStore.patch', ok: false, error: e?.message || String(e) });
    }

    return { attempts, peerId: node.peerId?.toString?.() };
  });

  console.log('Dial attempts:', JSON.stringify(result, null, 2));

  await browser.close();
});
