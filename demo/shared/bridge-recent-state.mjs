export const BRIDGE_BOOKMARKS_KEY = 'nostr-dag-bridge-bookmarks-v1';
export const BRIDGE_RECENT_LIST_STATE_KEY = 'nostr-dag-bridge-recent-list-state-v1';
export const BRIDGE_PANEL_STATE_KEY = 'nostr-dag-bridge-panel-state-v1';

export function loadRecentBookmarks(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(BRIDGE_BOOKMARKS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      if (typeof value === 'string' && value) {
        return [{ id: value, event: null, source: '', updated_at: 0 }];
      }
      if (value && typeof value === 'object' && typeof value.id === 'string' && value.id) {
        return [{
          id: value.id,
          event: value.event && typeof value.event === 'object' ? value.event : null,
          source: typeof value.source === 'string' ? value.source : '',
          updated_at: Number(value.updated_at) || 0,
        }];
      }
      return [];
    });
  } catch {
    return [];
  }
}

export function loadRecentListState(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(BRIDGE_RECENT_LIST_STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function persistRecentListState(recentListState, storage = globalThis.localStorage) {
  try {
    const snapshot = {};
    for (const [key, state] of recentListState.entries()) {
      snapshot[key] = {
        query: String(state.query || ''),
        sort: String(state.sort || 'newest'),
        open: [...(state.openIds || new Set())],
      };
    }
    storage?.setItem(BRIDGE_RECENT_LIST_STATE_KEY, JSON.stringify(snapshot));
  } catch {
    // best effort only
  }
}

export function loadPanelState(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(BRIDGE_PANEL_STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function persistPanelState({
  peerListEl,
  peerPanelEl,
  relayPanelEl,
  statPanelEls,
}, storage = globalThis.localStorage) {
  try {
    const openPeerKeys = [...peerListEl.querySelectorAll('details[open][data-peer-key]')]
      .map((el) => el.getAttribute('data-peer-key'))
      .filter(Boolean);
    const statPanels = {};
    statPanelEls.forEach((panel) => {
      const key = panel.getAttribute('data-stat-key');
      if (!key) return;
      statPanels[key] = Boolean(panel.open);
    });
    storage?.setItem(BRIDGE_PANEL_STATE_KEY, JSON.stringify({
      peersOpen: Boolean(peerPanelEl?.open),
      relaysOpen: Boolean(relayPanelEl?.open),
      openPeerKeys,
      statPanels,
    }));
  } catch {
    // best effort only
  }
}

export function restorePanelState(snapshot, peerPanelEl, relayPanelEl) {
  if (peerPanelEl) peerPanelEl.open = Boolean(snapshot.peersOpen);
  if (relayPanelEl) relayPanelEl.open = Boolean(snapshot.relaysOpen);
}

export function restoreStatPanelState(snapshot, statPanelEls) {
  const statPanels = snapshot.statPanels && typeof snapshot.statPanels === 'object' ? snapshot.statPanels : {};
  statPanelEls.forEach((panel) => {
    const key = panel.getAttribute('data-stat-key');
    if (!key) return;
    if (Object.prototype.hasOwnProperty.call(statPanels, key)) {
      panel.open = Boolean(statPanels[key]);
    }
  });
}

export function restoreRecentListUiState(recentListState, recentListStateSnapshot, documentRef = globalThis.document) {
  for (const [key, state] of recentListState.entries()) {
    const snapshot = recentListStateSnapshot[key];
    if (snapshot && typeof snapshot === 'object') {
      state.query = String(snapshot.query || '');
      state.sort = String(snapshot.sort || 'newest');
      state.openIds = new Set(Array.isArray(snapshot.open) ? snapshot.open.filter((value) => typeof value === 'string' && value) : []);
    }
    state.paused = false;
  }
  documentRef?.querySelectorAll('[data-list-search]').forEach((input) => {
    const key = input.getAttribute('data-list-search');
    if (!key || !recentListState.has(key)) return;
    input.value = recentListState.get(key).query || '';
  });
  documentRef?.querySelectorAll('[data-list-sort]').forEach((select) => {
    const key = select.getAttribute('data-list-sort');
    if (!key || !recentListState.has(key)) return;
    select.value = recentListState.get(key).sort || 'newest';
  });
}

export function syncRecentListPauseState(recentListState, containers) {
  for (const [key, state] of recentListState.entries()) {
    const container = containers.get(key) || null;
    state.paused = Boolean(container?.querySelector('details.bridge-recent-event[open]'));
  }
}

export function persistRecentBookmarks(bookmarkedRecentIds, bookmarkedRecentSnapshots, storage = globalThis.localStorage) {
  try {
    const snapshot = [...bookmarkedRecentIds].map((id) => bookmarkedRecentSnapshots.get(id) || { id, event: null, source: '', updated_at: 0 });
    storage?.setItem(BRIDGE_BOOKMARKS_KEY, JSON.stringify(snapshot));
  } catch {
    // best effort only
  }
}

export function isRecentBookmarked(id, bookmarkedRecentIds) {
  return Boolean(id && bookmarkedRecentIds.has(id));
}

export function getBookmarkedSnapshot(id, bookmarkedRecentSnapshots) {
  return id ? bookmarkedRecentSnapshots.get(id) || null : null;
}

export function bookmarkSnapshotFromItem(item) {
  if (!item?.id) return null;
  return {
    id: item.id,
    event: item.event && typeof item.event === 'object' ? item.event : null,
    source: typeof item.source === 'string' ? item.source : '',
    updated_at: Date.now(),
  };
}

export function updateBookmarkButtons(id, bookmarkedRecentIds, documentRef = globalThis.document) {
  const bookmarked = isRecentBookmarked(id, bookmarkedRecentIds);
  documentRef?.querySelectorAll('[data-bookmark-id]').forEach((button) => {
    if (button.getAttribute('data-bookmark-id') !== id) return;
    button.textContent = bookmarked ? '★' : '☆';
    button.classList.toggle('is-bookmarked', bookmarked);
    button.setAttribute('aria-label', bookmarked ? 'Remove bookmark' : 'Bookmark item');
    button.setAttribute('title', bookmarked ? 'Remove bookmark' : 'Bookmark item');
  });
}

export function toggleRecentBookmark({
  id,
  item = null,
  bookmarkedRecentIds,
  bookmarkedRecentSnapshots,
  scheduleRecentListsRender,
  storage = globalThis.localStorage,
  documentRef = globalThis.document,
}) {
  if (!id) return;
  if (bookmarkedRecentIds.has(id)) {
    bookmarkedRecentIds.delete(id);
    bookmarkedRecentSnapshots.delete(id);
  } else {
    bookmarkedRecentIds.add(id);
    const snapshot = bookmarkSnapshotFromItem(item) || bookmarkedRecentSnapshots.get(id) || { id, event: null, source: '', updated_at: Date.now() };
    bookmarkedRecentSnapshots.set(id, snapshot);
  }
  persistRecentBookmarks(bookmarkedRecentIds, bookmarkedRecentSnapshots, storage);
  updateBookmarkButtons(id, bookmarkedRecentIds, documentRef);
  scheduleRecentListsRender?.();
}
