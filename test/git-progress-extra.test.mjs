import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeGitProgress, createGitProgressReporter } from '../demo/shared/git-progress.mjs';

// ── summarizeGitProgress edge cases ──────────────────────────────────────────

test('summarizeGitProgress handles zero total as count without percent', () => {
  const result = summarizeGitProgress({ phase: 'counting', loaded: 0, total: 0 });
  assert.equal(result.percent, null);
  assert.equal(result.phase, 'counting');
  assert.match(result.text, /counting/);
});

test('summarizeGitProgress handles total=0 (no division by zero)', () => {
  const result = summarizeGitProgress({ phase: 'receiving', loaded: 5, total: 0 });
  assert.equal(result.percent, null);
  assert.match(result.text, /5\/0/);
});

test('summarizeGitProgress clamps percent to 100 when loaded > total', () => {
  const result = summarizeGitProgress({ phase: 'packing', loaded: 200, total: 100 });
  assert.equal(result.percent, 100);
});

test('summarizeGitProgress uses alternate field names (completed/length)', () => {
  const result = summarizeGitProgress({ phase: 'resolving', completed: 3, length: 10 });
  assert.equal(result.percent, 30);
  assert.match(result.text, /3\/10/);
});

test('summarizeGitProgress uses message field as phase when phase is absent', () => {
  const result = summarizeGitProgress({ message: 'indexing objects', current: 7 });
  assert.equal(result.phase, 'indexing objects');
  assert.match(result.text, /indexing objects 7/);
});

test('summarizeGitProgress falls back to "progress" text for empty progress object', () => {
  const result = summarizeGitProgress({});
  assert.equal(result.text, 'progress');
  assert.equal(result.phase, '');
  assert.equal(result.percent, null);
});

test('summarizeGitProgress returns default for non-object (number)', () => {
  assert.deepEqual(summarizeGitProgress(42), { text: 'progress', phase: '', percent: null });
});

// ── createGitProgressReporter edge cases ─────────────────────────────────────

test('createGitProgressReporter emits first update immediately', () => {
  const report = createGitProgressReporter('repo', 'fetch');
  const msg = report({ phase: 'counting objects', loaded: 1, total: 100 });
  assert.match(msg, /repo fetch/);
  assert.match(msg, /counting objects/);
});

test('createGitProgressReporter deduplicates same bucket within same phase', () => {
  const report = createGitProgressReporter('repo', 'clone');
  report({ phase: 'counting', loaded: 1, total: 100 });  // bucket 0
  const second = report({ phase: 'counting', loaded: 2, total: 100 }); // still bucket 0
  assert.equal(second, null);
});

test('createGitProgressReporter emits when bucket changes within same phase', () => {
  const report = createGitProgressReporter('repo', 'clone');
  report({ phase: 'counting', loaded: 1, total: 100 });   // bucket 0 (1%)
  const msg = report({ phase: 'counting', loaded: 6, total: 100 }); // bucket 1 (6%)
  assert.ok(msg !== null);
  assert.match(msg, /counting/);
});

test('createGitProgressReporter emits when phase changes even in same bucket', () => {
  const report = createGitProgressReporter('repo', 'clone');
  report({ phase: 'phase-a', loaded: 1, total: 100 });
  const msg = report({ phase: 'phase-b', loaded: 1, total: 100 });
  assert.ok(msg !== null);
  assert.match(msg, /phase-b/);
});

test('createGitProgressReporter formats done message without progress detail', () => {
  const report = createGitProgressReporter('myrepo', 'push');
  const done = report({ phase: 'writing objects', loaded: 100, total: 100 }, true);
  assert.equal(done, 'myrepo push complete');
});

test('createGitProgressReporter includes context label in prefix', () => {
  const report = createGitProgressReporter('repo', 'fetch', 'branch main');
  const msg = report({ phase: 'counting', loaded: 10, total: 20 });
  assert.match(msg, /repo fetch \(branch main\)/);
});

test('createGitProgressReporter omits context label when empty string', () => {
  const report = createGitProgressReporter('repo', 'fetch', '');
  const msg = report({ phase: 'counting', loaded: 1, total: 20 });
  // The context-parenthesis pattern is "fetch (...)" — without context the
  // prefix is "repo fetch:" with no label in parens before the colon.
  assert.ok(!msg.includes('fetch ('), 'should not include context parentheses when context is empty');
});
