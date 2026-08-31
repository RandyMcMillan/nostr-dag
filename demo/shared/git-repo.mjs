import { loadRepoCache, saveRepoCache, emptyRepoData, cacheRepoData, loadRefCache, saveRefCache } from './git-viewer.mjs';

/**
 * Unified in-memory + localStorage state for a single git repository.
 * Replaces the scattered repoHealth/repoPing/repoSource/repoState Maps.
 */
export class GitRepo {
  constructor(config) {
    this.name = config.name;
    this.url = config.url;
    this.dir = config.dir;

    // Runtime mutable state (not persisted)
    this.status = 'idle';
    this.health = 'idle';
    this.ping = null;
    this.source = null;
    this.proxy = null;
    this.progress = null;

    // Git data (persisted to localStorage via cacheRepoData)
    this.data = emptyRepoData();
  }

  /** Load persisted git data from localStorage. */
  loadCache() {
    const cache = loadRepoCache();
    const cached = cache[this.name];
    const refCache = loadRefCache();
    const refs = refCache[this.name];
    if (cached || refs) {
      this.data = { ...emptyRepoData(), ...cached, ...refs };
    }
    return this;
  }

  /** Save current git data to localStorage with tag/branch merge logic.
   *  Tags/branches/serverRefs are stored in an unversioned cache so they
   *  survive APP_VERSION bumps; everything else goes to the versioned cache.
   */
  saveCache() {
    // Persist refs to unversioned cache so they survive app version bumps.
    const refCache = loadRefCache();
    const existingRefs = refCache[this.name] || {};
    const mergedTags = [...new Set([
      ...(this.data.tags || []),
      ...(existingRefs.tags || []),
    ])].sort((a, b) => a.localeCompare(b));
    const mergedTagMap = { ...(existingRefs.tagMap || {}), ...(this.data.tagMap || {}) };
    const mergedBranches = [...new Set([
      ...(this.data.branches || []),
      ...(existingRefs.branches || []),
    ])].sort((a, b) => a.localeCompare(b));
    const mergedServerRefs = [...(existingRefs.serverRefs || []), ...(this.data.serverRefs || [])];
    const seenRef = new Set();
    const dedupedServerRefs = [];
    for (const ref of mergedServerRefs) {
      const key = `${ref?.ref || ''}|${ref?.oid || ''}`;
      if (seenRef.has(key)) continue;
      seenRef.add(key);
      dedupedServerRefs.push(ref);
    }
    refCache[this.name] = {
      tags: mergedTags,
      tagMap: mergedTagMap,
      branches: mergedBranches,
      serverRefs: dedupedServerRefs,
    };
    saveRefCache(refCache);

    // Persist non-ref data to the versioned cache.
    const dataOnly = { ...this.data };
    delete dataOnly.tags;
    delete dataOnly.tagMap;
    delete dataOnly.branches;
    delete dataOnly.serverRefs;
    cacheRepoData(this.name, dataOnly);
  }

  /** True if the repo has cached tags or branches. */
  get hasCachedRefs() {
    return this.data.tags.length > 0 || this.data.branches.length > 0;
  }

  /** True if the repo has cached commits (a prior successful read). */
  get hasCachedCommits() {
    return this.data.commits && this.data.commits.length > 0;
  }

  /** Return an object suitable for renderRepoCard / createRepoCardModel. */
  toCardModel() {
    const data = this.data;
    const selectedBranch = data.branches.includes(data.selectedRef)
      ? data.selectedRef
      : (data.branches[0] || '');
    const selectedTag = data.tags.includes(data.selectedRef) ? data.selectedRef : '';
    return {
      repo: { name: this.name, url: this.url, dir: this.dir },
      iconUrl: `${new URL(this.url).origin}/favicon.ico`,
      status: this.status,
      ping: this.ping,
      p2pAvailable: false, // set by caller if needed
      source: this.source,
      proxy: this.proxy,
      ref: data.ref || 'n/a',
      latest: data.latest || 'n/a',
      latestHtml: this.renderLatestSummary(data.latest || 'n/a'),
      selectedRef: data.selectedRef || data.ref || 'n/a',
      branches: data.branches || [],
      tagsList: data.tags || [],
      selectedBranch,
      selectedTag,
      toolbar: {
        refreshId: this.name,
        primaryHref: this.url,
        primaryLabel: 'Open upstream',
      },
    };
  }

  renderLatestSummary(text) {
    const value = text || 'n/a';
    if (value.length <= 80) {
      return `<span class="muted">Latest:</span> <span class="mono">${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>`;
    }
    const preview = `${value.slice(0, 80).trimEnd()}…`;
    return `<details class="small"><summary style="cursor:pointer;"><span class="muted">Latest:</span> <span class="mono">${preview.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span></summary><div class="mono" style="margin-top:8px; word-break:break-word;">${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div></details>`;
  }
}

/**
 * Create GitRepo instances from a config array and hydrate from cache.
 */
export function createGitRepos(configs) {
  return configs.map((cfg) => new GitRepo(cfg).loadCache());
}
