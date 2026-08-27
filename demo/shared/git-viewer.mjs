import { resolveHref } from './page-path.js';

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

export function loadRepoCache(storageKey) {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveRepoCache(storageKey, cache) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(cache));
  } catch {
    // Best-effort only.
  }
}

export function cacheRepoData(storageKey, repoName, data) {
  const cache = loadRepoCache(storageKey);
  cache[repoName] = data;
  saveRepoCache(storageKey, cache);
}

export function emptyRepoData() {
  return {
    latest: 'n/a',
    latestCommit: null,
    files: [],
    tags: [],
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
