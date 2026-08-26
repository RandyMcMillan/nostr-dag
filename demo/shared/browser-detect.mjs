/**
 * browser-detect.mjs
 *
 * Lightweight browser-environment detection helpers.
 *
 * All functions are pure and side-effect-free so they can be imported safely
 * from Node.js test runners as well as browser pages.
 *
 * Exported API
 * ------------
 * getBrowserInfo(ua?)   → { name, version, engine, mobile, platform, raw }
 * isSafari(ua?)         → boolean
 * isFirefox(ua?)        → boolean
 * isChrome(ua?)         → boolean
 * isEdge(ua?)           → boolean
 * isMobile(ua?)         → boolean
 * supportsWebAssembly() → boolean
 * supportsIndexedDB()   → boolean
 * supportsWebCrypto()   → boolean
 * supportsWebSockets()  → boolean
 */

/**
 * Return the navigator.userAgent string when running in a browser, or an
 * empty string in non-browser environments (Node.js, workers without UA).
 *
 * @returns {string}
 */
function getUA() {
  if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string') {
    return navigator.userAgent;
  }
  return '';
}

/**
 * Detect basic browser identity from a user-agent string.
 *
 * Detection order matters – more-specific brands are checked before broader ones:
 *   1. Edge (Chromium-based) – reports both "Chrome" and "Edg" tokens
 *   2. Chrome / Chromium – reports "Chrome" but not "Edg"
 *   3. Firefox
 *   4. Safari – reports "Safari" but not "Chrome"
 *   5. Everything else → "unknown"
 *
 * @param {string} [ua] - UA string; defaults to navigator.userAgent.
 * @returns {{ name: string, version: string, engine: string, mobile: boolean, platform: string, raw: string }}
 */
export function getBrowserInfo(ua) {
  const raw = typeof ua === 'string' ? ua : getUA();
  const mobile = /Mobi|Android|iPhone|iPad|iPod/i.test(raw);
  let name = 'unknown';
  let version = '';
  let engine = 'unknown';
  let platform = 'unknown';

  // --- platform (most-specific first) ---
  if (/iPhone|iPad|iPod/i.test(raw)) platform = 'iOS';
  else if (/Android/i.test(raw)) platform = 'Android';
  else if (/Win/i.test(raw)) platform = 'Windows';
  else if (/Mac/i.test(raw)) platform = 'macOS';
  else if (/Linux/i.test(raw)) platform = 'Linux';

  // --- browser + engine ---
  let m;

  // Edge (Chromium) – "Edg/NNN"
  m = raw.match(/Edg\/(\d[\d.]*)/);
  if (m) {
    name = 'Edge';
    version = m[1];
    engine = 'Blink';
    return { name, version, engine, mobile, platform, raw };
  }

  // Chrome / Chromium – "Chrome/NNN" without Edg token
  m = raw.match(/Chrome\/(\d[\d.]*)/);
  if (m && !/Edg\//.test(raw)) {
    name = 'Chrome';
    version = m[1];
    engine = 'Blink';
    return { name, version, engine, mobile, platform, raw };
  }

  // Firefox – "Firefox/NNN"
  m = raw.match(/Firefox\/(\d[\d.]*)/);
  if (m) {
    name = 'Firefox';
    version = m[1];
    engine = 'Gecko';
    return { name, version, engine, mobile, platform, raw };
  }

  // Safari – "Version/NNN Safari/NNN" (no Chrome token)
  m = raw.match(/Version\/(\d[\d.]*)\s+(?:Mobile\/\S+\s+)?Safari\//);
  if (m && /Safari\//.test(raw) && !/Chrome\//.test(raw)) {
    name = 'Safari';
    version = m[1];
    engine = 'WebKit';
    return { name, version, engine, mobile, platform, raw };
  }

  return { name, version, engine, mobile, platform, raw };
}

/**
 * @param {string} [ua]
 * @returns {boolean}
 */
export function isSafari(ua) {
  return getBrowserInfo(ua).name === 'Safari';
}

/**
 * @param {string} [ua]
 * @returns {boolean}
 */
export function isFirefox(ua) {
  return getBrowserInfo(ua).name === 'Firefox';
}

/**
 * @param {string} [ua]
 * @returns {boolean}
 */
export function isChrome(ua) {
  return getBrowserInfo(ua).name === 'Chrome';
}

/**
 * @param {string} [ua]
 * @returns {boolean}
 */
export function isEdge(ua) {
  return getBrowserInfo(ua).name === 'Edge';
}

/**
 * @param {string} [ua]
 * @returns {boolean}
 */
export function isMobile(ua) {
  return getBrowserInfo(ua).mobile;
}

/**
 * Returns true when WebAssembly is available in the current global scope.
 *
 * @returns {boolean}
 */
export function supportsWebAssembly() {
  return typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
}

/**
 * Returns true when the IndexedDB API is available.
 *
 * @returns {boolean}
 */
export function supportsIndexedDB() {
  return typeof indexedDB !== 'undefined';
}

/**
 * Returns true when the Web Crypto API (subtle) is available.
 *
 * @returns {boolean}
 */
export function supportsWebCrypto() {
  return (
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined' &&
    typeof crypto.subtle.digest === 'function'
  );
}

/**
 * Returns true when the WebSocket constructor is available.
 *
 * @returns {boolean}
 */
export function supportsWebSockets() {
  return typeof WebSocket === 'function';
}
