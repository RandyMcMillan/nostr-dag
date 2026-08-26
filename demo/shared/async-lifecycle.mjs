/**
 * Run a task after the first paint (or closest fallback) so page chrome can
 * render before non-critical boot work starts.
 */
export function scheduleAfterPaint(task) {
  const run = () => globalThis.setTimeout(task, 0);
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(run);
    return;
  }
  run();
}

/**
 * Yield execution back to the browser once so long async boot sequences do not
 * monopolize a single task and delay visible updates.
 */
export function yieldToBrowser() {
  return new Promise((resolve) => {
    scheduleAfterPaint(resolve);
  });
}
