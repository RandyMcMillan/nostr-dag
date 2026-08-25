import assert from 'node:assert/strict';
import test from 'node:test';

import { remoteTagNames } from '../demo/shared/git-refs.mjs';

test('remoteTagNames returns empty array for null', () => {
  assert.deepEqual(remoteTagNames(null), []);
});

test('remoteTagNames returns empty array for undefined', () => {
  assert.deepEqual(remoteTagNames(undefined), []);
});

test('remoteTagNames returns empty array for a non-array value', () => {
  assert.deepEqual(remoteTagNames('refs/tags/v1.0.0'), []);
  assert.deepEqual(remoteTagNames(42), []);
  assert.deepEqual(remoteTagNames({}), []);
});

test('remoteTagNames returns empty array when no tag refs are present', () => {
  assert.deepEqual(remoteTagNames([
    { ref: 'refs/heads/main' },
    { ref: 'refs/heads/develop' },
  ]), []);
});

test('remoteTagNames strips peeled-tag suffix (^{}) and deduplicates', () => {
  assert.deepEqual(remoteTagNames([
    { ref: 'refs/tags/v1.0.0' },
    { ref: 'refs/tags/v1.0.0^{}' },
  ]), ['v1.0.0']);
});

test('remoteTagNames sorts tag names lexicographically', () => {
  assert.deepEqual(remoteTagNames([
    { ref: 'refs/tags/v0.3.0' },
    { ref: 'refs/tags/v0.1.0' },
    { ref: 'refs/tags/v0.2.0' },
  ]), ['v0.1.0', 'v0.2.0', 'v0.3.0']);
});

test('remoteTagNames ignores entries with missing or empty ref', () => {
  assert.deepEqual(remoteTagNames([
    {},
    { ref: '' },
    { ref: null },
    { ref: 'refs/tags/v2.0.0' },
  ]), ['v2.0.0']);
});

test('remoteTagNames handles a mix of heads and tags', () => {
  assert.deepEqual(remoteTagNames([
    { ref: 'refs/heads/main' },
    { ref: 'refs/tags/v1.0.0' },
    { ref: 'refs/tags/v1.0.0^{}' },
    { ref: 'refs/heads/feature' },
    { ref: 'refs/tags/v0.9.0' },
  ]), ['v0.9.0', 'v1.0.0']);
});
