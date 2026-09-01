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

/**
 * Simple concurrency limiter for async tasks.
 * @param {number} concurrency - max number of tasks running in parallel
 * @returns {(fn: () => Promise<any>) => Promise<any>}
 */
export function pLimit(concurrency) {
  const queue = [];
  let active = 0;
  function next() {
    active--;
    if (queue.length) queue.shift()();
  }
  return (fn) => new Promise((resolve, reject) => {
    async function run() {
      active++;
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      } finally {
        next();
      }
    }
    if (active < concurrency) run();
    else queue.push(run);
  });
}
