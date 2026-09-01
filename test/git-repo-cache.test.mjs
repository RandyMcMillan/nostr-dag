import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// Mock localStorage in Node
global.window = {
  localStorage: {
    store: new Map(),
    getItem(k) { return this.store.get(k) || null; },
    setItem(k, v) { this.store.set(k, v); },
    removeItem(k) { this.store.delete(k); },
  },
};

const { GitRepo, createGitRepos } = await import('../demo/shared/git-repo.mjs');

describe('GitRepo cache persistence', () => {
  beforeEach(() => {
    window.localStorage.store.clear();
  });

  it('survives save/load cycle with tags and branches', () => {
    const repo = new GitRepo({ name: 'nostr-dag', url: 'https://github.com/RandyMcMillan/nostr-dag', dir: '/repos/nostr-dag' });
    repo.data.tags = ['v0.20.0', 'v0.2.0', 'v0.1.0'];
    repo.data.branches = ['master', 'main'];
    repo.data.selectedRef = 'master';
    repo.saveCache();

    const repo2 = new GitRepo({ name: 'nostr-dag', url: 'https://github.com/RandyMcMillan/nostr-dag', dir: '/repos/nostr-dag' });
    repo2.loadCache();

    assert.deepStrictEqual(repo2.data.tags, ['v0.20.0', 'v0.2.0', 'v0.1.0']);
    assert.deepStrictEqual(repo2.data.branches, ['main', 'master']); // sorted alphabetically
    assert.strictEqual(repo2.data.selectedRef, 'master');
  });

  it('merges new tags into existing ref cache', () => {
    const repo = new GitRepo({ name: 'nostr-dag', url: 'https://github.com/RandyMcMillan/nostr-dag', dir: '/repos/nostr-dag' });
    repo.data.tags = ['v0.1.0'];
    repo.saveCache();

    const repo2 = new GitRepo({ name: 'nostr-dag', url: 'https://github.com/RandyMcMillan/nostr-dag', dir: '/repos/nostr-dag' });
    repo2.loadCache();
    repo2.data.tags = ['v0.2.0'];
    repo2.saveCache();

    const repo3 = new GitRepo({ name: 'nostr-dag', url: 'https://github.com/RandyMcMillan/nostr-dag', dir: '/repos/nostr-dag' });
    repo3.loadCache();

    assert.ok(repo3.data.tags.includes('v0.1.0'), 'should keep old tag v0.1.0');
    assert.ok(repo3.data.tags.includes('v0.2.0'), 'should keep new tag v0.2.0');
  });

  it('createGitRepos hydrates from cache', () => {
    const repo = new GitRepo({ name: 'nostr-dag', url: 'https://github.com/RandyMcMillan/nostr-dag', dir: '/repos/nostr-dag' });
    repo.data.tags = ['v0.1.0'];
    repo.data.branches = ['master'];
    repo.saveCache();

    const repos = createGitRepos([{ name: 'nostr-dag', url: 'https://github.com/RandyMcMillan/nostr-dag', dir: '/repos/nostr-dag' }]);
    assert.strictEqual(repos.length, 1);
    assert.ok(repos[0].hasCachedRefs, 'should have cached refs');
    assert.ok(repos[0].data.tags.includes('v0.1.0'));
    assert.ok(repos[0].data.branches.includes('master'));
  });

  it('survives version bump because ref cache key is constant', async () => {
    const repo = new GitRepo({ name: 'nostr-dag', url: 'https://github.com/RandyMcMillan/nostr-dag', dir: '/repos/nostr-dag' });
    repo.data.tags = ['v0.1.0'];
    repo.saveCache();

    // Simulate clearing the versioned repo cache (as if APP_VERSION bumped)
    const { loadRepoCache, saveRepoCache } = await import('../demo/shared/git-viewer.mjs');
    saveRepoCache({}); // wipe versioned cache

    const repo2 = new GitRepo({ name: 'nostr-dag', url: 'https://github.com/RandyMcMillan/nostr-dag', dir: '/repos/nostr-dag' });
    repo2.loadCache();

    assert.ok(repo2.data.tags.includes('v0.1.0'), 'tag should survive from unversioned ref cache');
    assert.ok(repo2.data.branches.length === 0, 'branches were never saved');
  });
});
