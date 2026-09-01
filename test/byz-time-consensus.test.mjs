/**
 * Tests for the Byzantine Time Consensus example.
 *
 * Covers:
 *   - Pure algorithm: Cristian's Algorithm offset calculation
 *   - Pure algorithm: median offset with Byzantine outlier resistance
 *   - Pure algorithm: RTT outlier filtering (>1000ms discarded)
 *   - Browser smoke test: example page loads without JS errors
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Pure algorithm helpers (mirrored from examples/byz-time-consensus.html)
// ---------------------------------------------------------------------------

function calculateOffset(serverTime, t0, t1) {
  const rtt = t1 - t0;
  const estimatedPeerTime = serverTime + Math.floor(rtt / 2);
  return estimatedPeerTime - t1;
}

function medianOffset(samples) {
  const sorted = [...samples].sort((a, b) => a.offset - b.offset);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid].offset
    : Math.floor((sorted[mid - 1].offset + sorted[mid].offset) / 2);
}

function filterSamples(peerSamples) {
  const valid = peerSamples.filter((s) => s.rtt < 1000);
  return valid.length > 0 ? valid : peerSamples;
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

test('Cristian algorithm: zero RTT gives zero offset', () => {
  const now = Date.now();
  const offset = calculateOffset(now, now, now);
  assert.strictEqual(offset, 0);
});

test('Cristian algorithm: symmetric delay is cancelled out', () => {
  const serverTime = 1_000_000;
  const t0 = 2_000_000;
  const delay = 200;
  const t1 = t0 + delay * 2; // RTT = 400ms, symmetric
  const offset = calculateOffset(serverTime, t0, t1);
  // serverTime + RTT/2 = 1_000_000 + 200 = 1_000_200
  // estimatedPeerTime - t1 = 1_000_200 - 2_000_400 = -1_000_200
  assert.strictEqual(offset, serverTime + delay - t1);
});

test('median offset: odd count picks middle value', () => {
  const samples = [
    { offset: -100, rtt: 100 },
    { offset: 50, rtt: 100 },
    { offset: 200, rtt: 100 },
  ];
  assert.strictEqual(medianOffset(samples), 50);
});

test('median offset: even count averages middle pair', () => {
  const samples = [
    { offset: -100, rtt: 100 },
    { offset: 100, rtt: 100 },
    { offset: 300, rtt: 100 },
    { offset: 500, rtt: 100 },
  ];
  assert.strictEqual(medianOffset(samples), 200);
});

test('median offset: Byzantine outlier at extreme is ignored', () => {
  const samples = [
    { offset: -10, rtt: 100 },
    { offset: -5, rtt: 100 },
    { offset: 0, rtt: 100 },
    { offset: 5, rtt: 100 },
    { offset: 10_000, rtt: 100 }, // malicious skew
  ];
  assert.strictEqual(medianOffset(samples), 0);
});

test('RTT outlier filter: drops >1000ms samples', () => {
  const samples = [
    { offset: 0, rtt: 100 },
    { offset: 10, rtt: 1200 },
    { offset: 20, rtt: 900 },
  ];
  const filtered = filterSamples(samples);
  assert.strictEqual(filtered.length, 2);
  assert.ok(filtered.every((s) => s.rtt < 1000));
});

test('RTT outlier filter: keeps all when none exceed threshold', () => {
  const samples = [
    { offset: 0, rtt: 100 },
    { offset: 10, rtt: 200 },
  ];
  const filtered = filterSamples(samples);
  assert.strictEqual(filtered.length, 2);
});

test('RTT outlier filter: falls back to all samples when every RTT is high', () => {
  const samples = [
    { offset: 0, rtt: 1500 },
    { offset: 10, rtt: 2000 },
  ];
  const filtered = filterSamples(samples);
  assert.strictEqual(filtered.length, 2);
});

// ---------------------------------------------------------------------------
// Browser smoke test
// ---------------------------------------------------------------------------

let chromium;
try {
  chromium = (await import('playwright-core')).chromium;
} catch {
  // playwright-core not available — skip browser tests
}

const BASE = process.env.SERVER_URL || process.env.BASE_URL || 'http://127.0.0.1:3000';

async function serverHealthy() {
  try {
    const res = await fetch(`${BASE}/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

test('byz-time-consensus page loads without JS errors', { timeout: 30_000 }, async (t) => {
  if (!chromium) {
    t.skip('playwright-core not installed');
    return;
  }
  if (!(await serverHealthy())) {
    t.skip('server not running — start nostr-dag-server to run this test');
    return;
  }

  let browser;
  try {
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
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(`${BASE}/examples/byz-time-consensus.html`, {
      waitUntil: 'load',
      timeout: 15_000,
    });

    // Wait briefly for inline script init
    await new Promise((r) => setTimeout(r, 1500));

    assert.strictEqual(pageErrors.length, 0, `page JS errors: ${pageErrors.join(', ')}`);

    const title = await page.title();
    assert.ok(title.includes('Time Consensus'), `unexpected title: ${title}`);

    const logText = await page.locator('#log').textContent().catch(() => '');
    assert.ok(logText.includes('Page loaded'), 'log should show initial load message');
  } finally {
    if (browser) await browser.close();
  }
});
