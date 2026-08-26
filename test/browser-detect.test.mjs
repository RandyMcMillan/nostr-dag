import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('../demo/shared/browser-detect.mjs', import.meta.url),
  'utf8',
);
const {
  getBrowserInfo,
  isSafari,
  isFirefox,
  isChrome,
  isEdge,
  isMobile,
  supportsWebAssembly,
  supportsIndexedDB,
  supportsWebCrypto,
  supportsWebSockets,
} = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);

// --- UA fixtures ---
const UA_CHROME =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const UA_FIREFOX =
  'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';
const UA_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const UA_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
const UA_SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const UA_CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36';
const UA_UNKNOWN = 'curl/8.7.1';

// --- getBrowserInfo ---

test('getBrowserInfo detects Chrome', () => {
  const info = getBrowserInfo(UA_CHROME);
  assert.equal(info.name, 'Chrome');
  assert.match(info.version, /^\d+\./);
  assert.equal(info.engine, 'Blink');
  assert.equal(info.mobile, false);
  assert.equal(info.platform, 'Linux');
});

test('getBrowserInfo detects Firefox', () => {
  const info = getBrowserInfo(UA_FIREFOX);
  assert.equal(info.name, 'Firefox');
  assert.match(info.version, /^\d+\./);
  assert.equal(info.engine, 'Gecko');
  assert.equal(info.mobile, false);
  assert.equal(info.platform, 'Linux');
});

test('getBrowserInfo detects Safari on macOS', () => {
  const info = getBrowserInfo(UA_SAFARI);
  assert.equal(info.name, 'Safari');
  assert.match(info.version, /^\d+\./);
  assert.equal(info.engine, 'WebKit');
  assert.equal(info.mobile, false);
  assert.equal(info.platform, 'macOS');
});

test('getBrowserInfo detects Edge', () => {
  const info = getBrowserInfo(UA_EDGE);
  assert.equal(info.name, 'Edge');
  assert.match(info.version, /^\d+\./);
  assert.equal(info.engine, 'Blink');
  assert.equal(info.mobile, false);
  assert.equal(info.platform, 'Windows');
});

test('getBrowserInfo detects Safari on iOS as mobile', () => {
  const info = getBrowserInfo(UA_SAFARI_IOS);
  assert.equal(info.name, 'Safari');
  assert.equal(info.mobile, true);
  assert.equal(info.platform, 'iOS');
});

test('getBrowserInfo detects Chrome on Android as mobile', () => {
  const info = getBrowserInfo(UA_CHROME_ANDROID);
  assert.equal(info.name, 'Chrome');
  assert.equal(info.mobile, true);
  assert.equal(info.platform, 'Android');
});

test('getBrowserInfo returns unknown for unrecognised UA', () => {
  const info = getBrowserInfo(UA_UNKNOWN);
  assert.equal(info.name, 'unknown');
  assert.equal(info.version, '');
  assert.equal(info.raw, UA_UNKNOWN);
});

test('getBrowserInfo raw field equals input UA', () => {
  const info = getBrowserInfo(UA_CHROME);
  assert.equal(info.raw, UA_CHROME);
});

// --- convenience predicates ---

test('isChrome is true for Chrome UA', () => {
  assert.equal(isChrome(UA_CHROME), true);
  assert.equal(isChrome(UA_FIREFOX), false);
  assert.equal(isChrome(UA_EDGE), false);
});

test('isFirefox is true for Firefox UA', () => {
  assert.equal(isFirefox(UA_FIREFOX), true);
  assert.equal(isFirefox(UA_CHROME), false);
});

test('isSafari is true for Safari UA', () => {
  assert.equal(isSafari(UA_SAFARI), true);
  assert.equal(isSafari(UA_SAFARI_IOS), true);
  assert.equal(isSafari(UA_CHROME), false);
});

test('isEdge is true for Edge UA', () => {
  assert.equal(isEdge(UA_EDGE), true);
  assert.equal(isEdge(UA_CHROME), false);
});

test('isMobile is true for mobile UAs', () => {
  assert.equal(isMobile(UA_SAFARI_IOS), true);
  assert.equal(isMobile(UA_CHROME_ANDROID), true);
  assert.equal(isMobile(UA_SAFARI), false);
  assert.equal(isMobile(UA_CHROME), false);
});

// --- feature detection (Node.js globals) ---

test('supportsWebAssembly returns boolean', () => {
  const result = supportsWebAssembly();
  // Node.js has WebAssembly
  assert.equal(typeof result, 'boolean');
  assert.equal(result, true);
});

test('supportsWebCrypto returns boolean', () => {
  const result = supportsWebCrypto();
  // Node.js 19+ has crypto.subtle
  assert.equal(typeof result, 'boolean');
});

test('supportsIndexedDB returns false in Node.js', () => {
  // IndexedDB is browser-only; Node test runner won't have it
  assert.equal(supportsIndexedDB(), false);
});

test('supportsWebSockets returns a boolean', () => {
  const result = supportsWebSockets();
  assert.equal(typeof result, 'boolean');
});
