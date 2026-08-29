import { scheduleAfterPaint } from './async-lifecycle.mjs';
import { createLoggerFooter } from './logger.js';
import { createSharedHeader } from './page-header.mjs';
import { initSharedNetworkTime } from './network-time.mjs';

function createFooterProxy(buffer) {
  const pendingLevel = { value: null };
  const pendingState = { value: null, text: null };
  return {
    log(...args) {
      buffer.push({ type: 'log', args });
    },
    setState(state, text) {
      pendingState.value = state;
      pendingState.text = text;
    },
    setLevel(level) {
      pendingLevel.value = level;
    },
    close() {},
    open() {},
    __pendingLevel: pendingLevel,
    __pendingState: pendingState,
  };
}

function flushFooterBuffer(footer, buffer) {
  if (!footer || !buffer?.length) return;
  while (buffer.length) {
    const entry = buffer.shift();
    if (entry?.type === 'log') {
      footer.log(...entry.args);
    }
  }
}

function ensureSharedBuffer(bufferName) {
  if (Array.isArray(globalThis[bufferName])) return globalThis[bufferName];
  const buffer = [];
  globalThis[bufferName] = buffer;
  return buffer;
}

export function bootstrapDemoPageChrome({
  headerRoot,
  headerOptions = {},
  footerRoot = null,
  footerOptions = {},
  footerMode = 'after-paint',
  closeFooter = false,
  headerApiName = '__sharedHeaderApi',
  footerApiName = '__sharedFooter',
  bufferName = '__sharedFooterLogBuffer',
} = {}) {
  const headerApi = globalThis[headerApiName] || createSharedHeader(headerRoot, headerOptions);
  globalThis[headerApiName] = headerApi;
  const networkTime = initSharedNetworkTime({ headerApi });

  const buffer = ensureSharedBuffer(bufferName);
  const currentFooter = globalThis[footerApiName];
  if (!currentFooter || currentFooter.__demoFooterReady !== true) {
    globalThis[footerApiName] = currentFooter || createFooterProxy(buffer);
  }

  const initFooter = () => {
    if (!footerRoot) return globalThis[footerApiName];
    if (globalThis[footerApiName]?.__demoFooterReady === true) return globalThis[footerApiName];
    const proxy = globalThis[footerApiName];
    const footer = createLoggerFooter(footerRoot, footerOptions);
    footer.__demoFooterReady = true;
    footer.__demoFooterInitScheduled = true;
    globalThis[footerApiName] = footer;
    flushFooterBuffer(footer, buffer);
    if (proxy?.__pendingLevel?.value !== null) {
      footer.setLevel(proxy.__pendingLevel.value);
    }
    if (proxy?.__pendingState?.value !== null) {
      footer.setState(proxy.__pendingState.value, proxy.__pendingState.text);
    }
    if (closeFooter) footer.close();
    return footer;
  };

  if (footerRoot) {
    if (footerMode === 'none') {
      return { headerApi, footer: globalThis[footerApiName], flushFooterBuffer: () => flushFooterBuffer(globalThis[footerApiName], buffer) };
    }
    if (globalThis[footerApiName]?.__demoFooterInitScheduled) {
      const flush = () => flushFooterBuffer(globalThis[footerApiName], buffer);
      globalThis.__flushSharedFooterLogBuffer = flush;
      return { headerApi, footer: globalThis[footerApiName], flushFooterBuffer: flush };
    }
    globalThis[footerApiName].__demoFooterInitScheduled = true;
    if (footerMode === 'raf' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => window.setTimeout(initFooter, 0));
    } else if (footerMode === 'timeout') {
      window.setTimeout(initFooter, 0);
    } else {
      scheduleAfterPaint(() => {
        void initFooter();
      });
    }
  }

  const flush = () => flushFooterBuffer(globalThis[footerApiName], buffer);
  globalThis.__flushSharedFooterLogBuffer = flush;

  return {
    headerApi,
    networkTime,
    footer: globalThis[footerApiName],
    flushFooterBuffer: flush,
  };
}
