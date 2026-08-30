import { resolveHref } from './page-path.js';
import { APP_VERSION } from './app-version.mjs';

const DEFAULT_REPO_CACHE_KEY = `nostr-dag-git-repo-cache-${APP_VERSION}`;

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildSelectOptions(items, selectedValue, placeholder) {
  const options = items.length
    ? items.map((item) => `<option value="${item}" ${item === selectedValue ? 'selected' : ''}>${item}</option>`).join('')
    : '<option value="">none</option>';
  return `<option value="">${placeholder}</option>${options}`;
}

export function loadRepoCache(storageKey = DEFAULT_REPO_CACHE_KEY) {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveRepoCache(cache, storageKey = DEFAULT_REPO_CACHE_KEY) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(cache));
  } catch {
    // Best-effort only.
  }
}

export function cacheRepoData(repoName, data, storageKey = DEFAULT_REPO_CACHE_KEY) {
  const cache = loadRepoCache(storageKey);
  const existing = cache[repoName];
  // Merge tags so newly discovered tags accumulate and survive refresh.
  // Shallow clones may not fetch every tag on each update, so we preserve
  // any tags already known rather than letting them be overwritten.
  const mergedTags = [...new Set([
    ...(data.tags || []),
    ...(existing?.tags || []),
  ])].sort((a, b) => a.localeCompare(b));
  // Merge tagMap (tag name -> commit oid) so callers can resolve tags.
  const mergedTagMap = { ...(existing?.tagMap || {}), ...(data.tagMap || {}) };
  // Merge branches so previously discovered branches survive refreshes
  // that may use singleBranch clones or shallow fetches.
  const mergedBranches = [...new Set([
    ...(data.branches || []),
    ...(existing?.branches || []),
  ])].sort((a, b) => a.localeCompare(b));
  // Merge server refs so we keep the full remote ref list (branches, tags,
  // HEAD, etc.) for other consumers such as the NIP-PIP transport.
  const mergedServerRefs = [...(existing?.serverRefs || []), ...(data.serverRefs || [])];
  const seenRef = new Set();
  const dedupedServerRefs = [];
  for (const ref of mergedServerRefs) {
    const key = `${ref?.ref || ''}|${ref?.oid || ''}`;
    if (seenRef.has(key)) continue;
    seenRef.add(key);
    dedupedServerRefs.push(ref);
  }
  data = { ...data, tags: mergedTags, tagMap: mergedTagMap, branches: mergedBranches, serverRefs: dedupedServerRefs };
  cache[repoName] = data;
  saveRepoCache(cache, storageKey);
}

export function emptyRepoData() {
  return {
    latest: 'n/a',
    latestCommit: null,
    files: [],
    tags: [],
    tagMap: {},
    serverRefs: [],
    branches: [],
    ref: 'n/a',
    defaultRef: 'n/a',
    selectedRef: 'n/a',
    commits: [],
    commitDiff: [],
  };
}

export function renderLatestSummary(text) {
  const value = text || 'n/a';
  if (value.length <= 80) {
    return `<span class="muted">Latest:</span> <span class="mono">${escapeHtml(value)}</span>`;
  }
  const preview = `${value.slice(0, 80).trimEnd()}…`;
  return `
    <details class="small">
      <summary style="cursor:pointer;"><span class="muted">Latest:</span> <span class="mono">${escapeHtml(preview)}</span></summary>
      <div class="mono" style="margin-top:8px; word-break:break-word;">${escapeHtml(value)}</div>
    </details>
  `;
}

export function repoSelectionHref(repo, { branch = null, tag = null, path = null } = {}) {
  const search = new URLSearchParams();
  search.set('repo', repo.name);
  if (branch) search.set('branch', branch);
  if (tag) search.set('tag', tag);
  if (path) search.set('path', path);
  return resolveHref(`./?${search.toString()}`);
}

export function repoCommitsHref(repo, { branch = null, tag = null } = {}) {
  const search = new URLSearchParams();
  search.set('repo', repo.name);
  search.set('view', 'commits');
  if (branch) search.set('branch', branch);
  if (tag) search.set('tag', tag);
  return resolveHref(`./?${search.toString()}`);
}

export function repoCommitHref(repo, { branch = null, tag = null, commit = null } = {}) {
  const search = new URLSearchParams();
  search.set('repo', repo.name);
  search.set('view', 'commit');
  if (branch) search.set('branch', branch);
  if (tag) search.set('tag', tag);
  if (commit) search.set('commit', commit);
  return resolveHref(`./?${search.toString()}`);
}

export function repoBrowseAtCommitHref(repo, { branch = null, tag = null, commit = null } = {}) {
  const search = new URLSearchParams();
  search.set('repo', repo.name);
  search.set('view', 'code');
  if (branch) search.set('branch', branch);
  if (tag) search.set('tag', tag);
  if (commit) search.set('commit', commit);
  return resolveHref(`./?${search.toString()}`);
}

export function repoFileHref(repo, { branch = null, tag = null, commit = null, path = null } = {}) {
  const search = new URLSearchParams();
  search.set('repo', repo.name);
  if (branch) search.set('branch', branch);
  if (tag) search.set('tag', tag);
  if (commit) search.set('commit', commit);
  if (path) search.set('path', path);
  return resolveHref(`./blame.html?${search.toString()}`);
}

export function getRouteContext(repos) {
  const params = new URLSearchParams(window.location.search);
  const repoName = params.get('repo') || '';
  const routeRepo = repos.find((entry) => entry.name === repoName) || null;
  return {
    repo: routeRepo,
    repoName: repoName || null,
    view: params.get('view') || '',
    branch: params.get('branch') || '',
    tag: params.get('tag') || '',
    path: params.get('path') || '',
    commit: params.get('commit') || '',
  };
}

export function repoCardStatusClass(status) {
  if (status === 'ready') return 'health-available';
  if (status === 'refreshing...' || status === 'cloning...' || status === 'fetching tags...' || status === 'reusing cached clone...') return 'health-checking';
  if (status.startsWith('prepare failed:') || status.startsWith('refresh failed:') || status.startsWith('unavailable:')) return 'health-unavailable';
  return 'health-idle';
}

export function defaultRefForRefs(branches, tags) {
  if (branches.includes('main')) return 'main';
  if (branches.includes('master')) return 'master';
  if (branches[0]) return branches[0];
  if (tags[0]) return tags[0];
  return 'HEAD';
}

export function resolveRefSelection(branches, tags, route) {
  if (route.branch) return route.branch;
  if (route.tag) return route.tag;
  return defaultRefForRefs(branches, tags);
}

export function createCommitSummary(commit, decorations = []) {
  const message = commit?.commit?.message || 'n/a';
  const summary = message.split('\n')[0] || 'n/a';
  const author = commit?.commit?.author?.name || 'unknown';
  const timestamp = Number(commit?.commit?.author?.timestamp);
  const date = Number.isFinite(timestamp) ? new Date(timestamp * 1000).toLocaleString() : 'n/a';
  const parents = Array.isArray(commit?.commit?.parent) ? commit.commit.parent : [];
  return {
    oid: commit?.oid || 'n/a',
    summary,
    author,
    date,
    message,
    parents,
    decorations,
  };
}

export async function pathExists(fs, path) {
  try {
    await fs.promises.stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(fs, path) {
  try {
    await fs.promises.mkdir(path, { recursive: true });
  } catch (e) {
    const message = String(e?.message || '');
    if (e?.name !== 'AlreadyExists' && e?.code !== 'EEXIST' && !message.includes('EEXIST')) {
      throw e;
    }
  }
}
