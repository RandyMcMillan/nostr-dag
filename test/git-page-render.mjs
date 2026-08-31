/**
 * Verify the /git/ page renders repo cards when the server is running.
 *
 * Usage:
 *   node --test test/git-page-render.mjs
 *
 * Expects nostr-dag-server on http://127.0.0.1:3000 (or PORT env var).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

const BASE = `http://127.0.0.1:${process.env.PORT || 3000}`;

describe('git page render', () => {
  it('returns the git viewer HTML', async () => {
    const res = await fetch(`${BASE}/git/`);
    assert.strictEqual(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('id="repos"'), 'should have repos container');
    assert.ok(body.includes('id="refreshBtn"'), 'should have refresh button');
  });

  it('CORS proxy responds for git smart-HTTP', async () => {
    const url = `${BASE}/proxy/https://github.com/RandyMcMillan/nostr-dag/info/refs?service=git-upload-pack`;
    const res = await fetch(url, { method: 'GET' });
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('git-upload-pack'), 'should have git content-type');
  });

  it('CORS proxy handles OPTIONS preflight', async () => {
    const url = `${BASE}/proxy/https://github.com/RandyMcMillan/nostr-dag/info/refs?service=git-upload-pack`;
    const res = await fetch(url, { method: 'OPTIONS' });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
  });
});
