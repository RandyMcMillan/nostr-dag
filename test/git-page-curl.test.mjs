/**
 * Content verification tests using curl/fetch (no browser needed).
 * Verifies the git viewer and proxy endpoints return actual functional content.
 *
 * In CI the server is not started, so the suite skips gracefully.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.SERVER_URL || 'http://127.0.0.1:3000';

let serverUp = false;
try {
  const res = await fetch(`${BASE}/`);
  serverUp = res.status === 200;
} catch {
  serverUp = false;
}

if (!serverUp) {
  test('git page curl tests (skipped — server not running)', { skip: true });
} else {
  async function fetchText(path) {
    const res = await fetch(`${BASE}${path}`);
    const text = await res.text();
    return { status: res.status, text };
  }

  test('git page returns HTML with repo names', async () => {
    const { status, text } = await fetchText('/git/');
    assert.strictEqual(status, 200);
    assert.ok(text.includes('Git Viewer'), 'should contain "Git Viewer"');
    assert.ok(text.includes('nostr-dag'), 'should contain repo name "nostr-dag"');
    assert.ok(text.includes('Refresh repos'), 'should contain refresh button');
  });

  test('blame page returns HTML', async () => {
    const { status, text } = await fetchText('/git/blame.html');
    assert.strictEqual(status, 200);
    assert.ok(text.includes('Blame View'), 'should contain "Blame View"');
  });

  test('proxy forwards git smart-HTTP info/refs', { timeout: 30_000 }, async () => {
    const url = `${BASE}/proxy/https://github.com/RandyMcMillan/nostr-dag/info/refs?service=git-upload-pack`;
    const res = await fetch(url);
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    const text = await res.text();
    assert.ok(text.includes('service=git-upload-pack'), 'should contain git service header');
    assert.ok(text.includes('refs/heads/master'), 'should contain master branch ref');
  });

  test('proxy returns CORS headers', async () => {
    const url = `${BASE}/proxy/https://github.com/RandyMcMillan/nostr-dag/info/refs?service=git-upload-pack`;
    const res = await fetch(url, { method: 'OPTIONS' });
    assert.ok(res.headers.get('access-control-allow-origin'), 'should have CORS allow-origin');
  });
}
