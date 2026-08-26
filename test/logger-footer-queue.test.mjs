import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function createFakeNode() {
  return {
    className: '',
    hidden: false,
    title: '',
    attrs: {},
    innerHTML: '',
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 200,
    listeners: {},
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    addEventListener(name, handler) {
      this.listeners[name] = handler;
    },
    querySelectorAll() {
      return [];
    },
  };
}

function createFakeRoot() {
  const statusEl = createFakeNode();
  const toggleEl = createFakeNode();
  const levelEl = createFakeNode();
  const logEl = createFakeNode();
  const copyEl = createFakeNode();

  return {
    className: '',
    classList: { add() {} },
    style: {},
    innerHTML: '',
    querySelector(selector) {
      if (selector === '[data-footer-status]') return statusEl;
      if (selector === '[data-footer-toggle]') return toggleEl;
      if (selector === '[data-footer-level]') return levelEl;
      if (selector === '[data-footer-log]') return logEl;
      if (selector === '[data-footer-copy]') return copyEl;
      return null;
    },
    nodes: { statusEl, toggleEl, levelEl, logEl, copyEl },
  };
}

async function loadFooter() {
  const source = await readFile(new URL('../demo/shared/logger-footer.js', import.meta.url), 'utf8');
  const { createLoggerFooter } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);
  return createLoggerFooter;
}

function installGlobals() {
  const rafQueue = [];
  globalThis.requestAnimationFrame = (cb) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  globalThis.localStorage = {
    getItem() { return null; },
    setItem() {},
  };
  return {
    drainAllRaf() {
      while (rafQueue.length > 0) {
        const cb = rafQueue.shift();
        cb();
      }
    },
  };
}

test('logger log() enqueues first and flushes on scheduler tick', async () => {
  const createLoggerFooter = await loadFooter();
  const globals = installGlobals();
  const root = createFakeRoot();
  const footer = createLoggerFooter(root);

  footer.setLevel('info');
  globals.drainAllRaf();

  const before = root.nodes.logEl.innerHTML;
  footer.log('queue', 'hello', 'info');

  assert.equal(root.nodes.logEl.innerHTML, before);

  globals.drainAllRaf();
  assert.match(root.nodes.logEl.innerHTML, /hello/);
});

test('logger applies queue backpressure and records dropped metrics', async () => {
  const createLoggerFooter = await loadFooter();
  const globals = installGlobals();
  const root = createFakeRoot();
  const footer = createLoggerFooter(root, {
    queueCapacity: 6,
    rateLimitPerKey: 10_000,
  });

  footer.setLevel('warn');
  globals.drainAllRaf();

  for (let i = 0; i < 20; i += 1) {
    footer.log('spam', `debug-${i}`, 'debug');
  }
  footer.log('signal', 'important', 'warn');

  const metrics = footer.getMetrics();
  assert.ok(metrics.queueDepth <= 6);
  assert.ok(metrics.dropped > 0);
  assert.ok(metrics.droppedByLevel.debug > 0);

  globals.drainAllRaf();
  assert.match(root.nodes.logEl.innerHTML, /important/);
});

test('logger coalesces repeated events into one queued record', async () => {
  const createLoggerFooter = await loadFooter();
  const globals = installGlobals();
  const root = createFakeRoot();
  const footer = createLoggerFooter(root, {
    coalesceWindowMs: 10_000,
    rateLimitPerKey: 10_000,
  });

  footer.setLevel('info');
  globals.drainAllRaf();

  footer.log('same', 'payload', 'info');
  footer.log('same', 'payload', 'info');
  footer.log('same', 'payload', 'info');

  const metrics = footer.getMetrics();
  assert.equal(metrics.coalesced, 2);
  assert.equal(metrics.queueDepth, 1);

  globals.drainAllRaf();
  assert.match(root.nodes.logEl.innerHTML, /payload \(x3\)/);
});
