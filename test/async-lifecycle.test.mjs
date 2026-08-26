import assert from 'node:assert/strict';
import test from 'node:test';

import { scheduleAfterPaint, yieldToBrowser } from '../demo/shared/async-lifecycle.mjs';

test('scheduleAfterPaint prefers requestAnimationFrame before setTimeout', async () => {
  const calls = [];
  const originalRaf = globalThis.requestAnimationFrame;
  const originalSetTimeout = globalThis.setTimeout;
  try {
    globalThis.requestAnimationFrame = (callback) => {
      calls.push('raf');
      callback();
      return 1;
    };
    globalThis.setTimeout = (callback) => {
      calls.push('timeout');
      callback();
      return 1;
    };

    scheduleAfterPaint(() => {
      calls.push('task');
    });

    assert.deepEqual(calls, ['raf', 'timeout', 'task']);
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('yieldToBrowser resolves without requestAnimationFrame', async () => {
  const originalRaf = globalThis.requestAnimationFrame;
  const originalSetTimeout = globalThis.setTimeout;
  const calls = [];
  try {
    globalThis.requestAnimationFrame = undefined;
    globalThis.setTimeout = (callback) => {
      calls.push('timeout');
      callback();
      return 1;
    };

    await yieldToBrowser();

    assert.deepEqual(calls, ['timeout']);
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.setTimeout = originalSetTimeout;
  }
});
