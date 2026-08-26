export function scheduleAfterPaint(task) {
  const run = () => globalThis.setTimeout(task, 0);
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(run);
    return;
  }
  run();
}

export function yieldToBrowser() {
  return new Promise((resolve) => {
    scheduleAfterPaint(resolve);
  });
}
