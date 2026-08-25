import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// resolveHref is designed for browser use (defaults to window.location.href).
// We exercise it by passing an explicit baseHref in all cases.

async function loadResolveHref() {
  const source = await readFile(new URL('../demo/shared/page-path.js', import.meta.url), 'utf8');
  // Wrap in an ES module export so we can import it via data: URL.
  const { resolveHref } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);
  return resolveHref;
}

test('resolveHref returns path-only for a simple relative segment', async () => {
  const resolveHref = await loadResolveHref();
  const result = resolveHref('./pkg/nostr_dag.js', 'https://example.com/nostr-dag/');
  assert.equal(result, '/nostr-dag/pkg/nostr_dag.js');
});

test('resolveHref resolves correctly under a Pages sub-path prefix', async () => {
  const resolveHref = await loadResolveHref();
  const result = resolveHref('./shared/page.css', 'https://randymcmillan.github.io/nostr-dag/');
  assert.equal(result, '/nostr-dag/shared/page.css');
});

test('resolveHref strips query and fragment from base but keeps them from relativePath', async () => {
  const resolveHref = await loadResolveHref();
  // A relative path with a hash
  const withHash = resolveHref('./index.html#section', 'https://example.com/nostr-dag/');
  assert.equal(withHash, '/nostr-dag/index.html#section');

  // A relative path with a query string
  const withSearch = resolveHref('./api?v=2', 'https://example.com/nostr-dag/');
  assert.equal(withSearch, '/nostr-dag/api?v=2');
});

test('resolveHref navigates up with ../ correctly', async () => {
  const resolveHref = await loadResolveHref();
  const result = resolveHref('../shared/page.css', 'https://example.com/nostr-dag/git/');
  assert.equal(result, '/nostr-dag/shared/page.css');
});

test('resolveHref handles absolute-looking path segments relative to origin', async () => {
  const resolveHref = await loadResolveHref();
  // A root-relative path still resolves against the origin
  const result = resolveHref('/other/path.js', 'https://example.com/nostr-dag/');
  assert.equal(result, '/other/path.js');
});

test('resolveHref omits the origin (returns only pathname+search+hash)', async () => {
  const resolveHref = await loadResolveHref();
  const result = resolveHref('./demo.js', 'https://example.com/nostr-dag/');
  // Must not contain the scheme or host
  assert.ok(!result.startsWith('https://'), 'should not include scheme');
  assert.ok(!result.includes('example.com'), 'should not include host');
});
