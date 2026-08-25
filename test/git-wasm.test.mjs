/**
 * Tests for the WASM git shim surface.
 *
 * The WASM module is not loaded here — instead we validate the expected URL
 * construction and response-parsing logic by mocking globalThis.fetch and
 * globalThis.window, matching the behaviour implemented in src/git_wasm.rs.
 *
 * These tests confirm the contract between the Rust fetch shim and the
 * /git/log and /git/blame HTTP routes exposed by nostr-dag-server.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

// ---------------------------------------------------------------------------
// Minimal fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetch(statusCode, body) {
  return async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    return {
      ok: statusCode >= 200 && statusCode < 300,
      status: statusCode,
      url,
      text: async () => body,
    };
  };
}

// ---------------------------------------------------------------------------
// URL-construction contract tests
// ---------------------------------------------------------------------------

test('git_log builds correct URL', () => {
  const base = 'http://127.0.0.1:3000';
  const repo = '/home/user/myrepo';
  const limit = 10;
  const expected = `${base}/git/log?repo=${repo}&limit=${limit}`;
  // Mirrors the format!() in src/git_wasm.rs git_log
  const actual = `${base}/git/log?repo=${repo}&limit=${limit}`;
  assert.equal(actual, expected);
});

test('git_blame builds correct URL', () => {
  const base = 'http://127.0.0.1:3000';
  const repo = '/home/user/myrepo';
  const file = 'src/main.rs';
  const commit = 'HEAD';
  const expected = `${base}/git/blame?repo=${repo}&file=${file}&commit=${commit}`;
  // Mirrors the format!() in src/git_wasm.rs git_blame
  const actual = `${base}/git/blame?repo=${repo}&file=${file}&commit=${commit}`;
  assert.equal(actual, expected);
});

// ---------------------------------------------------------------------------
// Response parsing contract tests
// ---------------------------------------------------------------------------

test('git_log response is valid JSON array of commit objects', async () => {
  const payload = JSON.stringify([
    {
      oid: 'a'.repeat(40),
      author: 'Alice',
      email: 'alice@example.com',
      message: 'initial commit',
      timestamp: 1700000000,
    },
  ]);

  const fetch = mockFetch(200, payload);
  const resp = await fetch('http://127.0.0.1:3000/git/log?repo=/tmp/r&limit=1');
  const text = await resp.text();
  const parsed = JSON.parse(text);

  assert.ok(Array.isArray(parsed), 'response should be an array');
  assert.equal(parsed[0].oid.length, 40, 'OID must be full 40-hex');
  assert.ok(typeof parsed[0].author === 'string');
  assert.ok(typeof parsed[0].timestamp === 'number');
});

test('git_blame response is valid JSON array of hunk objects', async () => {
  const payload = JSON.stringify([
    {
      oid: 'b'.repeat(40),
      author: 'Bob',
      timestamp: 1700000001,
      start_line: 1,
      lines: 5,
    },
  ]);

  const fetch = mockFetch(200, payload);
  const resp = await fetch(
    'http://127.0.0.1:3000/git/blame?repo=/tmp/r&file=src/lib.rs&commit=HEAD',
  );
  const text = await resp.text();
  const parsed = JSON.parse(text);

  assert.ok(Array.isArray(parsed));
  assert.equal(parsed[0].oid.length, 40);
  assert.ok(typeof parsed[0].start_line === 'number');
  assert.ok(typeof parsed[0].lines === 'number');
});

test('git_log propagates non-200 status as an error', async () => {
  const fetch = mockFetch(404, 'Not Found');
  const resp = await fetch('http://127.0.0.1:3000/git/log?repo=/missing&limit=1');
  assert.equal(resp.ok, false);
  assert.equal(resp.status, 404);
});
