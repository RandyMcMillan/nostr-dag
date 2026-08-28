/**
 * Host reachability probe utilities.
 *
 * Works with any domain — git hosts, CDNs, APIs, relays, etc. —
 * using lightweight HTTP probes (HEAD / GET favicon) with
 * configurable timeout and abort support.
 */

const DEFAULT_TIMEOUT = 8000;

function normalizeUrl(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    if (input.url) return input.url;
    if (input.href) return input.href;
  }
  return String(input);
}

function originFromUrl(input) {
  try {
    return new URL(normalizeUrl(input)).origin;
  } catch {
    return '';
  }
}

/**
 * Low-level fetch probe.
 * @param {string|URL|{url:string}} url
 * @param {{timeout?:number,method?:string,mode?:string,signal?:AbortSignal}} [options]
 * @returns {Promise<{ok:true,status:number,type:string}|{ok:false,error:string,message:string}>>}
 */
export async function probeFetch(url, options = {}) {
  const target = normalizeUrl(url);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(target, {
      method: options.method || 'HEAD',
      mode: options.mode || 'no-cors',
      cache: 'no-store',
      signal: options.signal || controller.signal,
    });
    return { ok: true, status: response.status, type: response.type };
  } catch (error) {
    return { ok: false, error: error.name || 'fetch_failed', message: error.message };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

/**
 * Probe a host by fetching its favicon.
 * @param {string|URL|{url:string}} url
 * @param {number} [timeout]
 * @returns {Promise<{ok:true,status:number,type:string}|{ok:false,error:string,message:string}>>}
 */
export async function probeFavicon(url, timeout = DEFAULT_TIMEOUT) {
  const origin = originFromUrl(url);
  if (!origin) return { ok: false, error: 'invalid_url', message: 'Could not parse origin' };
  return probeFetch(`${origin}/favicon.ico`, { method: 'GET', mode: 'no-cors', timeout });
}

/**
 * Probe a host with a HEAD request.
 * @param {string|URL|{url:string}} url
 * @param {number} [timeout]
 * @returns {Promise<{ok:true,status:number,type:string}|{ok:false,error:string,message:string}>>}
 */
export async function probeHead(url, timeout = DEFAULT_TIMEOUT) {
  const target = normalizeUrl(url);
  if (!target) return { ok: false, error: 'invalid_url', message: 'Empty URL' };
  return probeFetch(target, { method: 'HEAD', mode: 'no-cors', timeout });
}

/**
 * Shared host-probe object.
 *
 *   import { hostProbe } from '../shared/host-probe.mjs';
 *   const up = await hostProbe.available('https://github.com');
 *   const result = await hostProbe.test('https://gitlab.com', { strategy: 'head' });
 */
export const hostProbe = {
  defaultTimeout: DEFAULT_TIMEOUT,

  url: normalizeUrl,
  origin: originFromUrl,

  /**
   * Probe a host.
   * @param {string|URL|{url:string}} input
   * @param {{strategy?:'auto'|'favicon'|'head'|'fetch',timeout?:number,method?:string,mode?:string,signal?:AbortSignal}} [options]
   */
  async test(input, options = {}) {
    const strategy = options.strategy || 'auto';
    if (strategy === 'favicon') return probeFavicon(input, options.timeout);
    if (strategy === 'head') return probeHead(input, options.timeout);
    if (strategy === 'fetch') return probeFetch(input, options);

    // auto: favicon is fastest for most git hosts / CDNs; fall back to HEAD.
    const faviconResult = await probeFavicon(input, options.timeout);
    if (faviconResult.ok) return faviconResult;
    return probeHead(input, options.timeout);
  },

  /**
   * Boolean convenience wrapper.
   * @param {string|URL|{url:string}} input
   * @param {{strategy?:'auto'|'favicon'|'head'|'fetch',timeout?:number,method?:string,mode?:string,signal?:AbortSignal}} [options]
   * @returns {Promise<boolean>}
   */
  async available(input, options = {}) {
    const result = await this.test(input, options);
    return result.ok;
  },
};

/**
 * Backward-compatible favicon URL builder for repo objects.
 * @param {{url:string}} repo
 * @returns {string}
 */
export function remoteProbeUrl(repo) {
  return `${new URL(repo.url).origin}/favicon.ico`;
}
