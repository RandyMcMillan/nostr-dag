import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test('diagnose local peer discovery', { timeout: 60_000 }, async (t) => {
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
  await page.waitForTimeout(10_000);

  // Directly evaluate peer discovery logic in the page
  const discovery = await page.evaluate(async () => {
    try {
      const res = await fetch('/peers', { cache: 'no-store' });
      if (!res.ok) return { fetchOk: false, status: res.status };
      const peers = await res.json();
      const natives = peers.filter(p => p.kind === 'native' && p.source === 'localhost');
      const addrs = [];
      for (const peer of natives) {
        const detail = peer.detail || '';
        const m = detail.match(/addrs=([^\n]+)/);
        if (m) {
          addrs.push(...m[1].split(',').map(s => s.trim()).filter(Boolean));
        }
      }
      return { fetchOk: true, peerCount: peers.length, nativeCount: natives.length, addrs };
    } catch (err) {
      return { fetchOk: false, error: err.message };
    }
  });

  console.log('Discovery result:', JSON.stringify(discovery, null, 2));

  // Check if the node attempted to dial any local addresses
  const dialState = await page.evaluate(async () => {
    const node = window.__gitViewerP2pTransport?.node;
    if (!node) return { nodeExists: false };
    const conns = [];
    try {
      if (node.getConnections) {
        for (const c of node.getConnections()) {
          conns.push({
            peer: c.remotePeer?.toString?.() || 'unknown',
            addr: c.remoteAddr?.toString?.() || 'unknown',
          });
        }
      }
    } catch (_) {}
    return { nodeExists: true, peerId: node.peerId?.toString?.(), conns };
  });

  console.log('Dial state:', JSON.stringify(dialState, null, 2));

  await browser.close();
});
