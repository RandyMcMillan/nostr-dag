import test from 'node:test';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test('manual peer store dial with esm.sh imports', { timeout: 60_000 }, async (t) => {
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

    const attempts = [];

    try {
      const { peerIdFromString } = await import('https://esm.sh/@libp2p/peer-id');
      const { multiaddr } = await import('https://esm.sh/@multiformats/multiaddr');
      const peerId = peerIdFromString(peerIdStr);
      const ma = multiaddr(addrStr);

      attempts.push({ step: 'imports', ok: true, peerIdType: typeof peerId, maType: typeof ma });

      try {
        await node.peerStore.patch(peerId, { multiaddrs: [ma] });
        attempts.push({ step: 'patch', ok: true });
      } catch (e) {
        attempts.push({ step: 'patch', ok: false, error: e?.message || String(e) });
      }

      try {
        await node.dial(peerId);
        attempts.push({ step: 'dialPeerId', ok: true });
      } catch (e) {
        attempts.push({ step: 'dialPeerId', ok: false, error: e?.message || String(e) });
      }

      try {
        await node.dial(ma);
        attempts.push({ step: 'dialMultiaddr', ok: true });
      } catch (e) {
        attempts.push({ step: 'dialMultiaddr', ok: false, error: e?.message || String(e) });
      }
    } catch (e) {
      attempts.push({ step: 'imports', ok: false, error: e?.message || String(e) });
    }

    return { attempts, conns: (() => {
      const arr = [];
      try {
        if (node?.getConnections) {
          for (const c of node.getConnections()) {
            arr.push(c.remotePeer?.toString?.() || 'unknown');
          }
        }
      } catch (_) {}
      return arr;
    })() };
  });

  console.log('Dial attempts:', JSON.stringify(result, null, 2));

  await browser.close();
});
