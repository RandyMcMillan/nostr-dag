export function createListContainerController({
  items,
  state,
  scheduleRender,
  persistState,
  renderFn = () => {},
}) {
  const pending = [];

  function flush() {
    if (state.paused) return;
    while (pending.length) {
      const value = pending.shift();
      if (!value?.id) continue;
      const index = items.findIndex((entry) => entry?.id === value.id);
      if (index !== -1) items.splice(index, 1);
      items.push(value);
    }
  }

  return {
    queue(value) {
      if (!value?.id) return;
      if (state.paused) {
        pending.push(value);
        return;
      }
      const index = items.findIndex((entry) => entry?.id === value.id);
      if (index !== -1) items.splice(index, 1);
      items.push(value);
      scheduleRender();
    },
    pause() {
      if (state.paused) return;
      state.paused = true;
      persistState();
    },
    resume() {
      if (!state.paused) return;
      state.paused = false;
      persistState();
      flush();
      scheduleRender();
    },
    render() {
      if (state.paused) return;
      renderFn();
    },
    flush,
    syncPauseFromOpenState() {
      state.paused = state.openIds.size > 0;
    },
  };
}
