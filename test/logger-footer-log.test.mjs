import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// ── minimal DOM fake shared by all sub-tests ──────────────────────────────────

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
    setAttribute(name, value) { this.attrs[name] = String(value); },
    addEventListener(name, handler) { this.listeners[name] = handler; },
    querySelectorAll() { return []; },
  };
}

function createFakeRoot() {
  const statusEl = createFakeNode();
  const toggleEl = createFakeNode();
  const chevronEl = createFakeNode();
  const levelEl  = createFakeNode();
  const logEl    = createFakeNode();
  const copyEl   = createFakeNode();

  const root = {
    classList: { add() {} },
    innerHTML: '',
    querySelector(selector) {
      if (selector === '[data-footer-status]') return statusEl;
      if (selector === '[data-footer-toggle]') return toggleEl;
      if (selector === '[data-footer-chevron]') return chevronEl;
      if (selector === '[data-footer-level]')  return levelEl;
      if (selector === '[data-footer-log]')    return logEl;
      if (selector === '[data-footer-copy]')   return copyEl;
      return null;
    },
    nodes: { statusEl, toggleEl, chevronEl, levelEl, logEl },
  };
  return root;
}

async function loadFooter() {
  const source = await readFile(new URL('../demo/shared/logger-footer.js', import.meta.url), 'utf8');
  const { createLoggerFooter } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);
  return createLoggerFooter;
}

// Set up globals expected by the module
function setGlobals() {
  globalThis.requestAnimationFrame = (cb) => cb();
  globalThis.localStorage = { getItem() { return null; }, setItem() {} };
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('logger footer starts at level "none" with log panel hidden', async () => {
  setGlobals();
  const createLoggerFooter = await loadFooter();
  const root = createFakeRoot();
  const footer = createLoggerFooter(root);

  assert.equal(footer.getLevel(), 'none');
  assert.equal(root.nodes.logEl.hidden, true);
});

test('logger footer only renders entries matching the current level', async () => {
  setGlobals();
  const createLoggerFooter = await loadFooter();
  const root = createFakeRoot();
  const footer = createLoggerFooter(root);

  footer.setLevel('info');
  footer.log('test', 'info message', 'info');
  footer.log('test', 'debug message', 'debug');

  // Only the info entry should appear in innerHTML
  assert.match(root.nodes.logEl.innerHTML, /info message/);
  assert.ok(!root.nodes.logEl.innerHTML.includes('debug message'),
    'debug message should not appear when level is info');
});

test('logger footer shows entries after switching level', async () => {
  setGlobals();
  const createLoggerFooter = await loadFooter();
  const root = createFakeRoot();
  const footer = createLoggerFooter(root);

  footer.setLevel('debug');
  footer.log('test', 'only-debug', 'debug');

  assert.match(root.nodes.logEl.innerHTML, /only-debug/);

  // Switch to info — the debug entry should no longer appear
  footer.setLevel('info');
  assert.ok(!root.nodes.logEl.innerHTML.includes('only-debug'),
    'debug entry should not show after switching to info level');
});

test('logger footer setLevel("none") hides the log panel', async () => {
  setGlobals();
  const createLoggerFooter = await loadFooter();
  const root = createFakeRoot();
  const footer = createLoggerFooter(root);

  footer.setLevel('warn');
  assert.equal(root.nodes.logEl.hidden, false);

  footer.setLevel('none');
  assert.equal(root.nodes.logEl.hidden, true);
});

test('logger footer setState updates statusEl className', async () => {
  setGlobals();
  const createLoggerFooter = await loadFooter();
  const root = createFakeRoot();
  const footer = createLoggerFooter(root);

  footer.setState('available', 'connected');
  assert.match(root.nodes.statusEl.className, /status-available/);
  assert.equal(root.nodes.statusEl.title, 'connected');
});

test('logger footer open() and close() toggle log panel visibility', async () => {
  setGlobals();
  const createLoggerFooter = await loadFooter();
  const root = createFakeRoot();
  const footer = createLoggerFooter(root);

  footer.setLevel('info');
  // Panel is open after setLevel to a real level
  assert.equal(root.nodes.logEl.hidden, false);

  footer.close();
  assert.equal(root.nodes.logEl.hidden, true);

  footer.open();
  assert.equal(root.nodes.logEl.hidden, false);
});

test('logger footer log() with state argument updates statusEl', async () => {
  setGlobals();
  const createLoggerFooter = await loadFooter();
  const root = createFakeRoot();
  const footer = createLoggerFooter(root);

  footer.setLevel('info');
  footer.log('relay', 'relay connected', 'info', 'available');

  assert.match(root.nodes.statusEl.className, /status-available/);
  assert.match(root.nodes.statusEl.title, /relay/);
});

test('logger footer renders "No log entries yet." when no matching entries', async () => {
  setGlobals();
  const createLoggerFooter = await loadFooter();
  const root = createFakeRoot();
  const footer = createLoggerFooter(root);

  footer.setLevel('error');
  // We only logged a debug message, so error filter should show placeholder
  footer.log('test', 'debug only', 'debug');

  assert.match(root.nodes.logEl.innerHTML, /No log entries yet/);
});
