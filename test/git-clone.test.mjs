import assert from 'node:assert/strict';
import test from 'node:test';

import { cloneWithSingleBranchFallback } from '../demo/shared/git-clone.mjs';

test('cloneWithSingleBranchFallback retries once with singleBranch disabled', async () => {
  const calls = [];
  const cloneRepo = async (options) => {
    calls.push(options);
    if (calls.length === 1) {
      throw new Error('single branch clone failed');
    }
    return 'ok';
  };
  const failures = [];

  const result = await cloneWithSingleBranchFallback(
    cloneRepo,
    { url: 'https://example.com/repo.git', singleBranch: true, depth: 12 },
    (error) => failures.push(error.message),
  );

  assert.equal(result, 'ok');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].singleBranch, true);
  assert.equal(calls[1].singleBranch, false);
  assert.deepEqual(failures, ['single branch clone failed']);
});

test('cloneWithSingleBranchFallback rethrows when singleBranch fallback is not enabled', async () => {
  const cloneRepo = async () => {
    throw new Error('clone failed');
  };

  await assert.rejects(
    () => cloneWithSingleBranchFallback(cloneRepo, { url: 'https://example.com/repo.git', singleBranch: false }),
    /clone failed/u,
  );
});
