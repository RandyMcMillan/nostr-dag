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

  async function fetchSize(path) {
    const res = await fetch(`${BASE}${path}`);
    const blob = await res.blob();
    return { status: res.status, size: blob.size };
  }

  test('git page returns HTML with repo names', async () => {
    const { status, text } = await fetchText('/git/');
    assert.strictEqual(status, 200);
    assert.ok(text.includes('Git Viewer'), 'should contain "Git Viewer"');
    assert.ok(text.includes('nostr-dag'), 'should contain repo name "nostr-dag"');
    assert.ok(text.includes('Refresh repos'), 'should contain refresh button');
  });

  test('git page uses hosted vendor imports, not CDN', async () => {
    const { text } = await fetchText('/git/');
    assert.ok(text.includes("import git from '../vendor/isomorphic-git.mjs'"), 'should import isomorphic-git from vendor');
    assert.ok(text.includes("import http from '../vendor/isomorphic-git-http-web.mjs'"), 'should import http from vendor');
    assert.ok(text.includes("import LightningFS from '../vendor/lightning-fs.mjs'"), 'should import lightning-fs from vendor');
    assert.ok(!text.includes('cdn.jsdelivr.net/npm/isomorphic-git'), 'should not reference isomorphic-git CDN');
  });

  test('blame page returns HTML and uses vendor imports', async () => {
    const { status, text } = await fetchText('/git/blame.html');
    assert.strictEqual(status, 200);
    assert.ok(text.includes('Blame View'), 'should contain "Blame View"');
    assert.ok(text.includes("import git from '../vendor/isomorphic-git.mjs'"), 'should import from vendor');
  });

  test('vendor files are accessible and non-empty', async () => {
    const vendors = [
      { path: '/vendor/isomorphic-git.mjs', minSize: 100_000 },
      { path: '/vendor/isomorphic-git-http-web.mjs', minSize: 1_000 },
      { path: '/vendor/lightning-fs.mjs', minSize: 10_000 },
    ];
    for (const v of vendors) {
      const { status, size } = await fetchSize(v.path);
      assert.strictEqual(status, 200, `${v.path} should be accessible`);
      assert.ok(Number(size) >= v.minSize, `${v.path} should be at least ${v.minSize} bytes (got ${size})`);
    }
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
