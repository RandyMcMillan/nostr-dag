/**
 * Server smoke test — verifies the nostr-dag-server endpoints return
 * real content, not just HTTP 200.  Run with:
 *
 *   node --test test/server-smoke.test.mjs
 *
 * In CI the server is not started, so the suite skips gracefully.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

const BASE = process.env.SERVER_URL || 'http://127.0.0.1:3000';

async function fetchText(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  return { status: res.status, text };
}

let serverUp = false;
try {
  const res = await fetch(`${BASE}/`);
  serverUp = res.status === 200;
} catch {
  serverUp = false;
}

if (!serverUp) {
  it('server smoke tests (skipped — server not running)', { skip: true });
} else {
  describe('server smoke tests', () => {
    it('git page serves HTML with expected content', async () => {
      const { status, text } = await fetchText('/git/');
      assert.strictEqual(status, 200, `expected 200, got ${status}`);
      assert(text.includes('Git Viewer'), 'page should contain "Git Viewer"');
      assert(text.includes('Refresh repos'), 'page should contain "Refresh repos"');
      assert(text.includes('isomorphic-git'), 'page should reference isomorphic-git');
    });

    it('blame page serves HTML', async () => {
      const { status, text } = await fetchText('/git/blame.html');
      assert.strictEqual(status, 200);
      assert(text.includes('Blame'), 'blame page should contain "Blame"');
    });

    it('bridge page serves HTML', async () => {
      const { status, text } = await fetchText('/bridge/');
      assert.strictEqual(status, 200);
      assert(text.includes('Bridge'), 'bridge page should contain "Bridge"');
    });

    it('dag page serves HTML', async () => {
      const { status, text } = await fetchText('/dag/');
      assert.strictEqual(status, 200);
      assert(text.includes('DAG'), 'dag page should contain "DAG"');
    });

    it('proxy forwards git smart-HTTP info/refs', async () => {
      const url = `${BASE}/proxy/https://github.com/RandyMcMillan/nostr-dag/info/refs?service=git-upload-pack`;
      const res = await fetch(url);
      const text = await res.text();
      assert.strictEqual(res.status, 200, `proxy returned ${res.status}`);
      assert(text.includes('service=git-upload-pack'), 'should contain git-upload-pack service header');
      assert(text.includes('HEAD'), 'should contain HEAD ref');
    });

    it('peers API returns JSON array', async () => {
      const { status, text } = await fetchText('/peers/');
      assert.strictEqual(status, 200);
      const data = JSON.parse(text);
      assert(Array.isArray(data), 'peers response should be an array');
      if (data.length > 0) {
        assert(data[0].peer_id, 'peer entry should have peer_id');
      }
    });

    it('proxy returns CORS headers', async () => {
      const res = await fetch(`${BASE}/proxy/https://github.com/RandyMcMillan/nostr-dag/info/refs?service=git-upload-pack`, {
        method: 'OPTIONS',
      });
      assert.strictEqual(res.status, 204, 'OPTIONS should return 204');
      assert(res.headers.get('access-control-allow-origin'), 'should have CORS allow-origin');
    });

    it('static assets exist (shared CSS)', async () => {
      const res = await fetch(`${BASE}/shared/page.css`);
      const text = await res.text();
      assert.strictEqual(res.status, 200);
      assert(text.length > 100, 'CSS should have content');
    });
  });
}
