function normalizeState(text, fallback = 'idle') {
  const value = String(text || '').toLowerCase();
  if (!value) return fallback;
  if (value.includes('unavailable') || value.includes('failed') || value.includes('error')) return 'unavailable';
  if (
    value.includes('loading') ||
    value.includes('starting') ||
    value.includes('cloning') ||
    value.includes('fetching') ||
    value.includes('refresh') ||
    value.includes('caching') ||
    value.includes('reading') ||
    value.includes('writing') ||
    value.includes('committing')
  ) return 'checking';
  if (value.includes('ready') || value.includes('done') || value.includes('available') || value.includes('restored')) return 'available';
  return fallback;
}

const LOG_LEVELS = ['none', 'info', 'debug', 'trace', 'warn', 'error'];
const STORAGE_PREFIX = 'nostr-dag.logger-footer';
const LOGGER_INGEST_PATH = '/logger';
const FOOTER_SPACER_VAR = '--sticky-footer-space';
const SCROLLBAR_ACTIVE_CLASS = 'scrollbars-active';
const LEVEL_PRIORITY = {
  none: -1,
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};
const LEVEL_QUOTA_WEIGHTS = {
  trace: 0.1,
  debug: 0.2,
  info: 0.35,
  warn: 0.2,
  error: 0.15,
};
const QUEUE_LEVEL_CAP_WEIGHTS = {
  trace: 0.15,
  debug: 0.35,
  info: 0.45,
  warn: 0.35,
  error: 0.35,
};

function normalizeLevel(value) {
  const level = String(value || 'info').toLowerCase();
  return LOG_LEVELS.includes(level) ? level : 'info';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseLogArgs(levelOrState = 'info', maybeState = null) {
  if (maybeState === null && !LOG_LEVELS.includes(String(levelOrState).toLowerCase())) {
    return {
      level: null,
      state: String(levelOrState || 'idle'),
    };
  }
  return {
    level: normalizeLevel(levelOrState),
    state: maybeState,
  };
}

function deriveLevelFromState(state) {
  const value = String(state || '').toLowerCase();
  if (value.includes('unavailable') || value.includes('failed') || value.includes('error')) return 'error';
  if (value.includes('checking') || value.includes('refresh') || value.includes('loading') || value.includes('cloning') || value.includes('fetching') || value.includes('caching') || value.includes('starting') || value.includes('reading') || value.includes('writing') || value.includes('committing')) return 'debug';
  return 'info';
}

function getStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function resolveStorageKey(title, storageKey) {
  if (storageKey) return storageKey;
  const path = globalThis.location?.pathname || 'unknown';
  return `${STORAGE_PREFIX}:${title}:${path}`;
}

function shouldMirrorLogs() {
  try {
    const host = globalThis.location?.hostname || '';
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function mirrorLogEntry(entry) {
  if (!shouldMirrorLogs()) return;

  const body = JSON.stringify(entry);
  try {
    if (globalThis.navigator?.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      globalThis.navigator.sendBeacon(LOGGER_INGEST_PATH, blob);
      return;
    }
  } catch {
    // best effort only
  }

  void globalThis.fetch?.(LOGGER_INGEST_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
    cache: 'no-store',
  }).catch(() => {});
}

function loadPersistedFooterState(storageKey) {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      open: typeof parsed.open === 'boolean' ? parsed.open : null,
      level: typeof parsed.level === 'string' ? normalizeLevel(parsed.level) : null,
    };
  } catch {
    return null;
  }
}

function savePersistedFooterState(storageKey, state) {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // best effort only
  }
}

function setFooterSpacer(height) {
  try {
    globalThis.document?.documentElement?.style?.setProperty(FOOTER_SPACER_VAR, `${Math.max(0, Math.ceil(height))}px`);
  } catch {
    // best effort only
  }
}

function setScrollbarsActive(active) {
  try {
    globalThis.document?.documentElement?.classList?.toggle(SCROLLBAR_ACTIVE_CLASS, !!active);
  } catch {
    // best effort only
  }
}

function dispatchWindowResize() {
  try {
    globalThis.window?.dispatchEvent(new globalThis.Event('resize'));
  } catch {
    // best effort only
  }
}

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function stringifyLogText(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function createFormatterWorker() {
  if (typeof globalThis.Worker !== 'function' || typeof globalThis.Blob !== 'function') return null;
  if (!globalThis.URL?.createObjectURL) return null;

  const source = `
self.onmessage = (event) => {
  const data = event?.data || {};
  const id = data.id;
  const records = Array.isArray(data.records) ? data.records : [];
  const formatted = records.map((record) => {
    let text = '';
    try {
      text = typeof record.text === 'string' ? record.text : JSON.stringify(record.text);
    } catch {
      text = String(record.text);
    }
    return {
      timestamp: Number.isFinite(record.timestamp) ? record.timestamp : Date.now(),
      label: record.label || '',
      level: record.level || 'info',
      state: record.state || 'idle',
      text,
      repeats: Number.isFinite(record.repeats) && record.repeats > 1 ? record.repeats : 1,
      source: record.source || 'browser',
    };
  });
  self.postMessage({ id, records: formatted });
};
`;

  try {
    const blob = new Blob([source], { type: 'text/javascript' });
    const url = globalThis.URL.createObjectURL(blob);
    const worker = new globalThis.Worker(url);
    globalThis.URL.revokeObjectURL(url);
    return worker;
  } catch {
    return null;
  }
}

function createLevelQuotaMap(maxEntries) {
  const minPerLevel = Math.min(20, Math.max(2, Math.floor(maxEntries * 0.02)));
  return {
    trace: Math.max(minPerLevel, Math.floor(maxEntries * LEVEL_QUOTA_WEIGHTS.trace)),
    debug: Math.max(minPerLevel, Math.floor(maxEntries * LEVEL_QUOTA_WEIGHTS.debug)),
    info: Math.max(minPerLevel, Math.floor(maxEntries * LEVEL_QUOTA_WEIGHTS.info)),
    warn: Math.max(minPerLevel, Math.floor(maxEntries * LEVEL_QUOTA_WEIGHTS.warn)),
    error: Math.max(minPerLevel, Math.floor(maxEntries * LEVEL_QUOTA_WEIGHTS.error)),
  };
}

function createQueueLevelCapMap(queueCapacity) {
  const minPerLevel = Math.min(8, Math.max(2, Math.floor(queueCapacity * 0.01)));
  return {
    trace: Math.max(minPerLevel, Math.floor(queueCapacity * QUEUE_LEVEL_CAP_WEIGHTS.trace)),
    debug: Math.max(minPerLevel, Math.floor(queueCapacity * QUEUE_LEVEL_CAP_WEIGHTS.debug)),
    info: Math.max(minPerLevel, Math.floor(queueCapacity * QUEUE_LEVEL_CAP_WEIGHTS.info)),
    warn: Math.max(minPerLevel, Math.floor(queueCapacity * QUEUE_LEVEL_CAP_WEIGHTS.warn)),
    error: Math.max(minPerLevel, Math.floor(queueCapacity * QUEUE_LEVEL_CAP_WEIGHTS.error)),
  };
}

function levelPriority(level) {
  return LEVEL_PRIORITY[level] ?? LEVEL_PRIORITY.info;
}

function renderLogEntryHtml(entry) {
  return `
    <div class="footer-log-item">
      <span class="footer-log-time mono">${escapeHtml(entry.time)}</span>
      <span>${entry.label ? `${escapeHtml(entry.label)}: ` : ''}${escapeHtml(entry.text)}</span>
    </div>
  `;
}

// Detect Safari on iOS/iPadOS (Safari mobile). The logger renders large amounts
// of DOM and uses requestAnimationFrame-based batching that can degrade or crash
// on low-memory Safari mobile environments, so we disable it entirely there.
function isSafariMobile() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // iOS/iPadOS WebKit: contains "iPhone" or "iPad" (or "iPod"), and "Safari".
  // Also catches iPadOS in desktop-mode via maxTouchPoints check.
  const isIOS = /iphone|ipad|ipod/i.test(ua);
  const isIPadOS = /macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
  return isIOS || isIPadOS;
}

export function createLoggerFooter(root, options = {}) {
  // Disable logger on Safari mobile to avoid memory/rendering issues.
  if (!root || isSafariMobile()) {
    // Keep API parity with the full footer implementation.
    // Git viewer pages call footer.setLevel('none') unconditionally at startup,
    // so the Safari/no-root stub must expose setLevel/getLevel to avoid crashes.
    let level = normalizeLevel(options.initialLevel || 'none');
    return {
      log() {},
      setState() {},
      setLevel(nextLevel) {
        level = normalizeLevel(nextLevel);
      },
      getLevel() {
        return level;
      },
      open() {},
      close() {},
      toggle() {},
      destroy() {},
      getMetrics() {
        return {
          queueDepth: 0,
          queuePeakDepth: 0,
          dropped: 0,
          droppedByLevel: {},
          coalesced: 0,
          rateLimited: 0,
          flushedEntries: 0,
          flushCount: 0,
          avgFlushMs: 0,
        };
      },
    };
  }

  const title = options.title || 'Logger';
  const initialState = options.initialState || 'idle';
  const initialTitle = options.initialTitle || 'starting...';
  const maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : 1000;
  const maxVisibleEntries = Number.isFinite(options.maxVisibleEntries) && options.maxVisibleEntries > 0
    ? options.maxVisibleEntries
    : 300;
  const queueCapacity = Number.isFinite(options.queueCapacity) && options.queueCapacity > 0
    ? options.queueCapacity
    : Math.max(256, maxEntries * 2);
  const flushBatchLimit = Number.isFinite(options.flushBatchLimit) && options.flushBatchLimit > 0
    ? options.flushBatchLimit
    : 64;
  const flushBudgetMs = Number.isFinite(options.flushBudgetMs) && options.flushBudgetMs > 0
    ? options.flushBudgetMs
    : 4;
  const coalesceWindowMs = Number.isFinite(options.coalesceWindowMs) && options.coalesceWindowMs >= 0
    ? options.coalesceWindowMs
    : 180;
  const rateLimitWindowMs = Number.isFinite(options.rateLimitWindowMs) && options.rateLimitWindowMs > 0
    ? options.rateLimitWindowMs
    : 1000;
  const rateLimitPerKey = Number.isFinite(options.rateLimitPerKey) && options.rateLimitPerKey > 0
    ? options.rateLimitPerKey
    : 30;

  const levelQuotas = createLevelQuotaMap(maxEntries);
  const queueLevelCaps = createQueueLevelCapMap(queueCapacity);
  const storageKey = resolveStorageKey(title, options.storageKey);
  const persisted = loadPersistedFooterState(storageKey);

  const rootStyle = root.style || (root.style = {});
  root.classList.add('sticky-footer');
  rootStyle.resize = 'vertical';
  rootStyle.overflow = 'hidden';
  rootStyle.minHeight = '84px';
  rootStyle.maxHeight = '70vh';
  root.innerHTML = `
    <div class="sticky-footer-inner small muted">
      <div class="footer-header">
        <div class="footer-log-wrap">
          <div class="footer-controls">
            <button data-footer-toggle class="footer-toggle" type="button" aria-expanded="false" aria-controls="footerLogPanel">
              <span class="footer-toggle-label">
                <span>${title}</span>
                <span data-footer-status class="status status-idle" title="" aria-hidden="true">
                  <span class="status-dot" aria-hidden="true"></span>
                </span>
              </span>
            </button>
            <div class="footer-actions">
              <button data-footer-copy class="footer-copy" type="button">Save</button>
              <div class="footer-level-pills" data-footer-level></div>
            </div>
          </div>
        </div>
      </div>
      <div data-footer-log class="footer-log" hidden></div>
    </div>
  `;
  const statusEl = root.querySelector('[data-footer-status]');
  const toggleEl = root.querySelector('[data-footer-toggle]');
  const copyEl = root.querySelector('[data-footer-copy]');
  const levelEl = root.querySelector('[data-footer-level]');
  const logEl = root.querySelector('[data-footer-log]');

  const logs = [];
  const logLevelCounts = {
    info: 0,
    debug: 0,
    trace: 0,
    warn: 0,
    error: 0,
  };
  const queue = [];
  const queueLevelCounts = {
    info: 0,
    debug: 0,
    trace: 0,
    warn: 0,
    error: 0,
  };
  const droppedByLevel = {
    info: 0,
    debug: 0,
    trace: 0,
    warn: 0,
    error: 0,
  };
  const metrics = {
    queuePeakDepth: 0,
    dropped: 0,
    coalesced: 0,
    rateLimited: 0,
    flushedEntries: 0,
    flushCount: 0,
    totalFlushMs: 0,
  };
  const rateLimitState = new Map();

  let open = persisted?.open ?? false;
  let level = persisted?.level ?? normalizeLevel(options.initialLevel || 'none');
  let autoScroll = true;
  let hoverPaused = false;
  let interactionPaused = false;
  let interactionResumeTimer = null;
  let scrollListenerBound = false;
  let footerObserver = null;
  let scrollbarTimer = null;
  let scrollbarListenersBound = false;
  let renderScheduled = false;
  let flushScheduled = false;
  let flushing = false;
  let renderedLevel = null;
  let renderedItemCount = 0;
  let placeholderShown = false;
  let formatterWorker = options.enableWorkerFormatting === false ? null : createFormatterWorker();
  let formatterWorkerBusy = false;
  let formatterWorkerJobId = 0;
  let currentState = normalizeState(initialState);

  function persistState() {
    savePersistedFooterState(storageKey, { open, level });
  }

  function isNearBottom() {
    return (logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight) < 24;
  }

  function setAutoScroll(nextValue) {
    autoScroll = !!nextValue;
  }

  function clearInteractionResumeTimer() {
    if (interactionResumeTimer) {
      clearTimeout(interactionResumeTimer);
      interactionResumeTimer = null;
    }
  }

  function updateAutoScrollFromInteraction() {
    setAutoScroll(!(hoverPaused || interactionPaused));
  }

  function pauseForHover() {
    hoverPaused = true;
    clearInteractionResumeTimer();
    updateAutoScrollFromInteraction();
  }

  function resumeForHover() {
    hoverPaused = false;
    updateAutoScrollFromInteraction();
    scheduleInteractionResume();
  }

  function pauseForInteraction() {
    interactionPaused = true;
    clearInteractionResumeTimer();
    updateAutoScrollFromInteraction();
  }

  function scheduleInteractionResume() {
    clearInteractionResumeTimer();
    if (hoverPaused) return;
    interactionResumeTimer = setTimeout(() => {
      interactionPaused = false;
      interactionResumeTimer = null;
      updateAutoScrollFromInteraction();
      if (open && autoScroll) scheduleScrollBottom();
    }, 900);
  }

  function handleUserInteraction() {
    pauseForInteraction();
    scheduleInteractionResume();
    showScrollbars();
  }

  function scheduleScrollBottom() {
    if (!open || !autoScroll) return;
    const run = () => {
      logEl.scrollTop = logEl.scrollHeight;
    };
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }

  function bindScrollLock() {
    if (scrollListenerBound) return;
    scrollListenerBound = true;
    logEl.addEventListener('scroll', () => {
      if (!hoverPaused && !interactionPaused) {
        autoScroll = isNearBottom();
      }
      showScrollbars();
    });
    logEl.addEventListener('pointerdown', () => {
      handleUserInteraction();
    });
    logEl.addEventListener('wheel', () => {
      handleUserInteraction();
    }, { passive: true });
    logEl.addEventListener('touchstart', () => {
      handleUserInteraction();
    }, { passive: true });
    logEl.addEventListener('pointerenter', () => {
      pauseForHover();
      showScrollbars();
    });
    logEl.addEventListener('mouseenter', () => {
      pauseForHover();
      showScrollbars();
    });
    logEl.addEventListener('mousemove', handleUserInteraction);
    logEl.addEventListener('pointermove', handleUserInteraction);
    logEl.addEventListener('keydown', handleUserInteraction);
    logEl.addEventListener('focusin', handleUserInteraction);
    logEl.addEventListener('pointerleave', () => {
      hoverPaused = false;
      updateAutoScrollFromInteraction();
      scheduleInteractionResume();
      showScrollbars();
    });
    logEl.addEventListener('mouseleave', () => {
      hoverPaused = false;
      updateAutoScrollFromInteraction();
      scheduleInteractionResume();
      showScrollbars();
    });
  }

  function bindScrollbarActivity() {
    if (scrollbarListenersBound) return;
    scrollbarListenersBound = true;
    const activity = () => showScrollbars();
    globalThis.window?.addEventListener('scroll', activity, { passive: true, capture: true });
    globalThis.window?.addEventListener('wheel', activity, { passive: true, capture: true });
    globalThis.window?.addEventListener('pointerdown', activity, { passive: true, capture: true });
    globalThis.window?.addEventListener('pointermove', activity, { passive: true, capture: true });
    globalThis.window?.addEventListener('touchstart', activity, { passive: true, capture: true });
    globalThis.window?.addEventListener('keydown', activity, { passive: true, capture: true });
  }

  function syncFooterSpacer() {
    setFooterSpacer(root.getBoundingClientRect?.().height || root.offsetHeight || 0);
  }

  function hideScrollbarsLater() {
    if (scrollbarTimer) clearTimeout(scrollbarTimer);
    scrollbarTimer = setTimeout(() => {
      setScrollbarsActive(false);
    }, 2000);
  }

  function showScrollbars() {
    setScrollbarsActive(true);
    hideScrollbarsLater();
  }

  function renderLevelPills() {
    levelEl.innerHTML = LOG_LEVELS.map((entryLevel) => `
      <button type="button" class="footer-pill${entryLevel === level ? ' active' : ''}" data-level-pill="${entryLevel}">
        ${entryLevel}
      </button>
    `).join('');
    levelEl.querySelectorAll('[data-level-pill]').forEach((button) => {
      button.addEventListener('click', () => {
        level = normalizeLevel(button.getAttribute('data-level-pill'));
        open = level !== 'none';
        persistState();
        render();
      });
    });
  }

  function computeQueuePressure() {
    return queueCapacity > 0 ? queue.length / queueCapacity : 0;
  }

  function getDynamicFlushBudgetMs() {
    const pressure = computeQueuePressure();
    if (pressure >= 0.9) return Math.max(1, Math.floor(flushBudgetMs * 0.35));
    if (pressure >= 0.75) return Math.max(1, Math.floor(flushBudgetMs * 0.5));
    if (pressure >= 0.5) return Math.max(1, Math.floor(flushBudgetMs * 0.75));
    return flushBudgetMs;
  }

  function getDynamicFlushBatchLimit() {
    const pressure = computeQueuePressure();
    if (pressure >= 0.9) return Math.max(12, Math.floor(flushBatchLimit * 0.35));
    if (pressure >= 0.75) return Math.max(16, Math.floor(flushBatchLimit * 0.5));
    if (pressure >= 0.5) return Math.max(24, Math.floor(flushBatchLimit * 0.75));
    return flushBatchLimit;
  }

  function normalizeWorkerOrRawRecord(record) {
    const repeats = Number.isFinite(record.repeats) && record.repeats > 1 ? record.repeats : 1;
    const baseText = stringifyLogText(record.text);
    const text = repeats > 1 ? `${baseText} (x${repeats})` : baseText;
    return {
      time: new Date(Number.isFinite(record.timestamp) ? record.timestamp : Date.now()).toLocaleTimeString(),
      label: record.label || '',
      text,
      level: normalizeLevel(record.level),
      state: normalizeState(record.state || text),
      source: record.source || 'browser',
    };
  }

  function removeOldestLogByLevel(targetLevel) {
    const index = logs.findIndex((entry) => entry.level === targetLevel);
    if (index < 0) return false;
    const [removed] = logs.splice(index, 1);
    if (removed?.level && logLevelCounts[removed.level] > 0) {
      logLevelCounts[removed.level] -= 1;
    }
    return true;
  }

  function appendAcceptedLog(entry) {
    logs.push(entry);
    if (logLevelCounts[entry.level] !== undefined) {
      logLevelCounts[entry.level] += 1;
    }

    while (logs.length > maxEntries) {
      const removed = logs.shift();
      if (removed?.level && logLevelCounts[removed.level] > 0) {
        logLevelCounts[removed.level] -= 1;
      }
    }

    const quota = levelQuotas[entry.level] ?? maxEntries;
    while (logLevelCounts[entry.level] > quota) {
      if (!removeOldestLogByLevel(entry.level)) break;
    }
  }

  function getLogsForLevel(nextLevel, limit = maxVisibleEntries) {
    if (nextLevel === 'none') return [];
    const out = [];
    for (let i = logs.length - 1; i >= 0; i -= 1) {
      const entry = logs[i];
      if (entry.level !== nextLevel) continue;
      out.push(entry);
      if (out.length >= limit) break;
    }
    out.reverse();
    return out;
  }

  function renderPlaceholder() {
    logEl.innerHTML = '<div class="muted">No log entries yet.</div>';
    placeholderShown = true;
    renderedItemCount = 0;
  }

  function rebuildVisibleLogView() {
    renderedLevel = level;
    if (!open || level === 'none') {
      logEl.innerHTML = '';
      placeholderShown = false;
      renderedItemCount = 0;
      return;
    }

    const visibleLogs = getLogsForLevel(level, maxVisibleEntries);
    if (!visibleLogs.length) {
      renderPlaceholder();
      return;
    }

    logEl.innerHTML = visibleLogs.map((entry) => renderLogEntryHtml(entry)).join('');
    placeholderShown = false;
    renderedItemCount = visibleLogs.length;
    scheduleScrollBottom();
  }

  function maybeTrimVisibleHead() {
    if (renderedItemCount <= maxVisibleEntries) return;
    let toTrim = renderedItemCount - maxVisibleEntries;

    if (typeof logEl.removeChild === 'function' && logEl.firstElementChild) {
      while (toTrim > 0 && logEl.firstElementChild) {
        logEl.removeChild(logEl.firstElementChild);
        toTrim -= 1;
        renderedItemCount -= 1;
      }
      if (toTrim <= 0) return;
    }

    rebuildVisibleLogView();
  }

  function appendEntriesToVisibleLog(entries) {
    if (!open || level === 'none' || !entries.length) return;
    if (renderedLevel !== level) {
      rebuildVisibleLogView();
      return;
    }

    const matches = entries.filter((entry) => entry.level === level);
    if (!matches.length) return;

    if (placeholderShown) {
      logEl.innerHTML = '';
      placeholderShown = false;
      renderedItemCount = 0;
    }

    const html = matches.map((entry) => renderLogEntryHtml(entry)).join('');
    if (typeof logEl.insertAdjacentHTML === 'function') {
      logEl.insertAdjacentHTML('beforeend', html);
    } else {
      logEl.innerHTML += html;
    }

    renderedItemCount += matches.length;
    maybeTrimVisibleHead();
    scheduleScrollBottom();
    syncFooterSpacer();
    if (open) showScrollbars();
  }

  function render() {
    renderScheduled = false;
    toggleEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    renderLevelPills();
    logEl.hidden = !open;
    rebuildVisibleLogView();
    syncFooterSpacer();
    if (open) showScrollbars();
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    const run = () => render();
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }

  function saveVisibleLogs() {
    const visibleLogs = level === 'none' ? [] : logs.filter((entry) => entry.level === level);
    const text = visibleLogs.map((entry) => `[${entry.time}] ${entry.label ? `${entry.label}: ` : ''}${entry.text}`).join('\n');
    const filename = `nostr-dag-${Math.floor(Date.now() / 1000)}.log`;
    const blob = new Blob([text ? `${text}\n` : ''], { type: 'text/plain;charset=utf-8' });
    const url = globalThis.URL?.createObjectURL?.(blob);

    try {
      if (!url) throw new Error('object-url-unavailable');
      const anchor = globalThis.document?.createElement('a');
      if (!anchor) throw new Error('download-anchor-unavailable');
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      globalThis.document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => globalThis.URL?.revokeObjectURL?.(url), 0);
      log('logger', `saved ${visibleLogs.length} log lines to ${filename}`, 'debug', 'available');
    } catch {
      if (url) globalThis.URL?.revokeObjectURL?.(url);
      log('logger', 'save logs failed', 'warn', 'unavailable');
    }
  }

  function setState(state, text) {
    const nextState = state || normalizeState(text);
    if (currentState === 'available' && (nextState === 'checking' || nextState === 'idle')) {
      return;
    }
    currentState = nextState;
    statusEl.className = `status status-${nextState}`;
    statusEl.title = text || initialTitle;
  }

  function incrementDropped(levelName) {
    metrics.dropped += 1;
    if (droppedByLevel[levelName] !== undefined) {
      droppedByLevel[levelName] += 1;
    }
  }

  function dequeueRecordAt(index) {
    const [record] = queue.splice(index, 1);
    if (!record) return null;
    if (queueLevelCounts[record.level] > 0) queueLevelCounts[record.level] -= 1;
    return record;
  }

  function tryEvictForIncoming(incomingLevel) {
    const incomingPriority = levelPriority(incomingLevel);

    for (let i = 0; i < queue.length; i += 1) {
      const candidate = queue[i];
      if (levelPriority(candidate.level) < incomingPriority) {
        const removed = dequeueRecordAt(i);
        if (removed) incrementDropped(removed.level);
        return true;
      }
    }

    if (incomingPriority <= LEVEL_PRIORITY.debug) {
      incrementDropped(incomingLevel);
      return false;
    }

    const removed = dequeueRecordAt(0);
    if (removed) incrementDropped(removed.level);
    return !!removed;
  }

  function isRateLimited(raw) {
    if (raw.level !== 'trace' && raw.level !== 'debug') return false;
    const key = `${raw.level}:${raw.label}`;
    const ts = raw.timestamp;
    const slot = rateLimitState.get(key);
    if (!slot || (ts - slot.windowStart) >= rateLimitWindowMs) {
      rateLimitState.set(key, { windowStart: ts, count: 1 });
      return false;
    }
    slot.count += 1;
    if (slot.count <= rateLimitPerKey) return false;
    metrics.rateLimited += 1;
    incrementDropped(raw.level);
    return true;
  }

  function enqueueRawRecord(raw) {
    if (isRateLimited(raw)) return false;

    const capForLevel = queueLevelCaps[raw.level] ?? queueCapacity;
    if ((queueLevelCounts[raw.level] ?? 0) >= capForLevel) {
      if (!tryEvictForIncoming(raw.level)) return false;
    }

    while (queue.length >= queueCapacity) {
      if (!tryEvictForIncoming(raw.level)) return false;
    }

    const last = queue[queue.length - 1];
    if (
      last &&
      last.level === raw.level &&
      last.label === raw.label &&
      last.text === raw.text &&
      (raw.timestamp - last.timestamp) <= coalesceWindowMs
    ) {
      last.repeats += 1;
      last.timestamp = raw.timestamp;
      metrics.coalesced += 1;
      return true;
    }

    queue.push(raw);
    queueLevelCounts[raw.level] += 1;
    if (queue.length > metrics.queuePeakDepth) {
      metrics.queuePeakDepth = queue.length;
    }
    return true;
  }

  function takeBatch(limit) {
    const batch = [];
    while (batch.length < limit && queue.length > 0) {
      const record = dequeueRecordAt(0);
      if (record) batch.push(record);
    }
    return batch;
  }

  function commitBatch(entries) {
    if (!entries.length) return;

    let lastState = null;
    let lastTitle = null;

    for (const entry of entries) {
      appendAcceptedLog(entry);
      mirrorLogEntry(entry);
      lastState = entry.state;
      lastTitle = entry.label ? `${entry.label}: ${entry.text}` : String(entry.text);
    }

    metrics.flushedEntries += entries.length;
    if (lastState !== null) {
      setState(lastState, lastTitle);
    }

    appendEntriesToVisibleLog(entries);
  }

  function handleWorkerMessage(event) {
    const data = event?.data || {};
    if (data.id !== formatterWorkerJobId) return;
    formatterWorkerBusy = false;

    const records = Array.isArray(data.records)
      ? data.records.map((record) => normalizeWorkerOrRawRecord(record))
      : [];

    const start = nowMs();
    commitBatch(records);
    const elapsed = Math.max(0, nowMs() - start);
    metrics.flushCount += 1;
    metrics.totalFlushMs += elapsed;

    if (queue.length > 0) scheduleFlush();
  }

  function handleWorkerError() {
    formatterWorkerBusy = false;
    formatterWorker?.terminate?.();
    formatterWorker = null;
    if (queue.length > 0) scheduleFlush();
  }

  if (formatterWorker) {
    formatterWorker.addEventListener('message', handleWorkerMessage);
    formatterWorker.addEventListener('error', handleWorkerError);
  }

  function flushQueue() {
    flushScheduled = false;
    if (flushing || formatterWorkerBusy) return;
    flushing = true;

    const start = nowMs();
    const budgetMs = getDynamicFlushBudgetMs();
    const batchLimit = getDynamicFlushBatchLimit();

    if (formatterWorker && queue.length >= Math.max(24, batchLimit) && !formatterWorkerBusy) {
      const batch = takeBatch(Math.min(Math.max(batchLimit, 24), 256));
      formatterWorkerBusy = true;
      formatterWorkerJobId += 1;
      formatterWorker.postMessage({ id: formatterWorkerJobId, records: batch });
      flushing = false;
      return;
    }

    const staged = [];
    while (queue.length > 0 && staged.length < batchLimit) {
      if ((nowMs() - start) >= budgetMs) break;
      const raw = dequeueRecordAt(0);
      if (!raw) continue;
      staged.push(normalizeWorkerOrRawRecord(raw));
    }

    commitBatch(staged);

    const elapsed = Math.max(0, nowMs() - start);
    metrics.flushCount += 1;
    metrics.totalFlushMs += elapsed;

    flushing = false;
    if (queue.length > 0) scheduleFlush();
  }

  function scheduleFlush() {
    if (flushScheduled || formatterWorkerBusy) return;
    flushScheduled = true;
    const run = () => flushQueue();
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }

  function log(label, text, levelOrState = 'info', maybeState = null) {
    const { level: providedLevel, state } = parseLogArgs(levelOrState, maybeState);
    const nextLevel = providedLevel || deriveLevelFromState(state);
    const stateValue = normalizeState(state || text);

    const accepted = enqueueRawRecord({
      timestamp: Date.now(),
      label: label || '',
      text,
      level: nextLevel,
      state: stateValue,
      source: 'browser',
      repeats: 1,
    });

    if (accepted) scheduleFlush();
  }

  toggleEl.addEventListener('click', () => {
    open = !open;
    persistState();
    render();
    dispatchWindowResize();
  });

  copyEl?.addEventListener('click', saveVisibleLogs);

  setState(initialState, initialTitle);
  bindScrollLock();
  bindScrollbarActivity();
  if (typeof globalThis.ResizeObserver === 'function') {
    footerObserver = new globalThis.ResizeObserver(() => syncFooterSpacer());
    footerObserver.observe(root);
  }
  render();

  return {
    log,
    setState,
    setLevel(nextLevel) {
      level = normalizeLevel(nextLevel);
      open = level !== 'none';
      persistState();
      render();
    },
    getLevel() {
      return level;
    },
    getMetrics() {
      return {
        queueDepth: queue.length,
        queuePeakDepth: metrics.queuePeakDepth,
        dropped: metrics.dropped,
        droppedByLevel: { ...droppedByLevel },
        coalesced: metrics.coalesced,
        rateLimited: metrics.rateLimited,
        flushedEntries: metrics.flushedEntries,
        flushCount: metrics.flushCount,
        avgFlushMs: metrics.flushCount > 0 ? (metrics.totalFlushMs / metrics.flushCount) : 0,
      };
    },
    open() {
      open = true;
      persistState();
      render();
    },
    close() {
      open = false;
      persistState();
      render();
    },
    toggle() {
      open = !open;
      persistState();
      render();
    },
    destroy() {
      footerObserver?.disconnect?.();
      footerObserver = null;
      if (scrollbarTimer) clearTimeout(scrollbarTimer);
      scrollbarTimer = null;
      clearInteractionResumeTimer();
      formatterWorker?.terminate?.();
      formatterWorker = null;
      setScrollbarsActive(false);
    },
  };
}
