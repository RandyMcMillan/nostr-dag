export function normalizeText(value) {
  return String(value || '').toLowerCase();
}

export function recentItemSearchText(item) {
  const event = item?.event || {};
  const tags = Array.isArray(event.tags) ? event.tags.flat().join(' ') : '';
  return [
    item?.id,
    item?.source,
    event?.id,
    event?.kind,
    event?.pubkey,
    event?.content,
    tags,
  ].map(normalizeText).join(' ');
}

export function tokenizeRecentQuery(rawQuery) {
  const query = String(rawQuery || '').trim();
  if (!query) return [];
  return query.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
}

export function parseRecentQuery(rawQuery) {
  const tokens = tokenizeRecentQuery(rawQuery);
  const filters = [];
  let sort = null;
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (['asc', 'ascn', 'newest', 'down'].includes(lower)) {
      sort = 'newest';
      continue;
    }
    if (['desc', 'descn', 'oldest', 'up'].includes(lower)) {
      sort = 'oldest';
      continue;
    }
    if (['kind', 'id'].includes(lower)) {
      sort = lower;
      continue;
    }
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) {
      filters.push({ type: 'text', value: trimmed.replaceAll('"', '') });
      continue;
    }
    const field = trimmed.slice(0, colonIndex).toLowerCase();
    const value = trimmed.slice(colonIndex + 1).replaceAll('"', '').trim();
    if (!value) continue;
    if (field === 'kind') {
      filters.push({ type: 'kind', value });
      continue;
    }
    if (['id', 'pubkey', 'source', 'content', 'tag', 'relay', 'event'].includes(field)) {
      filters.push({ type: field, value });
      continue;
    }
    filters.push({ type: 'text', value: trimmed.replaceAll('"', '') });
  }
  return { filters, sort };
}

function recentItemFieldValue(item, field) {
  const event = item?.event || {};
  if (field === 'id' || field === 'event') return `${item?.id || ''} ${event?.id || ''}`;
  if (field === 'pubkey') return event?.pubkey || '';
  if (field === 'content') return event?.content || '';
  if (field === 'source') return item?.source || '';
  if (field === 'relay') return item?.relay || item?.source || '';
  if (field === 'tag') return Array.isArray(event.tags) ? event.tags.flat().join(' ') : '';
  if (field === 'kind') return String(event?.kind ?? '');
  return recentItemSearchText(item);
}

function matchesRecentItemQuery(item, filters) {
  if (!filters.length) return true;
  for (const filter of filters) {
    const haystack = normalizeText(recentItemFieldValue(item, filter.type));
    const needle = normalizeText(filter.value);
    if (!needle) continue;
    if (filter.type === 'kind') {
      if (haystack !== needle) return false;
      continue;
    }
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function compareRecentItems(a, b, sort, isRecentBookmarked) {
  const eventA = a?.event || {};
  const eventB = b?.event || {};
  const bookmarkedA = isRecentBookmarked(a?.id);
  const bookmarkedB = isRecentBookmarked(b?.id);
  if (bookmarkedA !== bookmarkedB) return bookmarkedA ? -1 : 1;
  if (sort === 'newest') return Number(eventB.created_at || 0) - Number(eventA.created_at || 0);
  if (sort === 'kind') return Number(eventA.kind || 0) - Number(eventB.kind || 0) || String(a?.id || '').localeCompare(String(b?.id || ''));
  if (sort === 'id') return String(a?.id || '').localeCompare(String(b?.id || ''));
  return Number(eventA.created_at || 0) - Number(eventB.created_at || 0) || String(a?.id || '').localeCompare(String(b?.id || ''));
}

export function getRecentItems({ key, items, recentListState, isRecentBookmarked }) {
  const state = recentListState.get(key) || { query: '', sort: 'newest' };
  const parsed = parseRecentQuery(state.query);
  const sort = parsed.sort || state.sort || 'newest';
  return [...items]
    .filter((item) => matchesRecentItemQuery(item, parsed.filters))
    .sort((a, b) => compareRecentItems(a, b, sort, isRecentBookmarked));
}
