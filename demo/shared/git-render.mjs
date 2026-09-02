import {
  buildSelectOptions,
  compareSemverDesc,
  emptyRepoData,
  escapeHtml,
  repoBrowseAtCommitHref,
  repoCardStatusClass,
  repoCommitHref,
  repoCommitsHref,
  repoFileHref,
  repoSelectionHref,
} from './git-viewer.mjs';
import { buildChatUrlWithContext } from './git-chat-link.mjs';

export function repoHealthClass(state) {
  if (state === 'checking') return 'health-checking';
  if (state === 'available') return 'health-available';
  if (state === 'unavailable') return 'health-unavailable';
  return 'health-idle';
}

export function findCommitSummary(data, route) {
  if (!route?.commit) return null;
  const match = data.commits.find((commit) => commit.oid === route.commit || commit.oid.startsWith(route.commit));
  return match || null;
}

export function renderRepoCard(card) {
  return `
    <div class="repo">
      <div class="row" style="justify-content:space-between;align-items:center;gap:8px;">
        <h3 class="row" style="gap:8px;align-items:center;margin:0;">
          <a href="${card.repo.url}" target="_blank" rel="noreferrer noopener" aria-label="${card.repo.name} upstream">
            <img src="${card.iconUrl}" alt="" width="16" height="16" loading="eager" fetchpriority="high" style="border-radius:3px;" />
          </a>
          <a href="${card.repo.url}" target="_blank" rel="noreferrer noopener">${card.repo.name}</a>
        </h3>
        <div class="small muted" style="text-align:right;">
          <a href="${card.repo.url}" target="_blank" rel="noreferrer noopener">${card.repo.url}</a>
        </div>
      </div>
      <div class="small" style="margin-top:8px;"><span class="muted">Status:</span> <span class="health-badge ${repoCardStatusClass(card.status)}" title="${escapeHtml(card.status)}"><span class="health-dot"></span></span>${card.ping !== null ? ` <span class="muted">ping:</span> <span class="mono">${card.ping} ms</span>` : ''}${card.p2pAvailable ? ' <span class="health-badge health-available" title="libp2p"><span class="health-dot"></span></span><span class="muted">p2p</span>' : ''}${card.source ? ` <span class="pill pill-source-${card.source}" title="${card.source === 'proxy' ? 'Fetched via CORS proxy (fallback)' : card.source === 'p2p' ? 'Fetched from libp2p peer bundle' : 'Source: ' + card.source}">${card.source}${card.proxy && card.source === 'proxy' ? ` • ${card.proxy}` : ''}</span>` : ''}</div>
      <div class="small" style="margin-top:8px;"><span class="muted">Ref:</span> <span class="mono">${card.ref}</span></div>
      <div class="small" style="margin-top:4px;"><span class="muted">Selected:</span> <span class="mono">${escapeHtml(card.selectedRef)}</span></div>
      <div class="small" style="margin-top:8px;">${card.latestHtml}</div>
      <div class="small" style="margin-top:8px;">
        <div class="muted">Branches</div>
        <select data-branch-select="${card.repo.name}" style="width:100%; margin-top:6px;">
          ${buildSelectOptions(card.branches, card.selectedBranch, 'Quick jump branch')}
        </select>
      </div>
      <div class="small" style="margin-top:8px;">
        <div class="muted">Tags</div>
        <select data-tag-select="${card.repo.name}" style="width:100%; margin-top:6px;">
          ${buildSelectOptions(card.tagsList, card.selectedTag, 'Quick jump tag')}
        </select>
      </div>
      <div class="row" style="margin-top:12px; justify-content:flex-end;">
        <button class="repo-refresh" type="button" data-refresh-repo="${card.toolbar.refreshId}">Refresh</button>
        <button class="button" type="button" data-view-repo="${card.toolbar.refreshId}">${card.toolbar.secondaryLabel}</button>
        <button class="button" type="button" data-view-commits="${card.toolbar.refreshId}">Commits</button>
        <a class="button" href="${buildChatUrlWithContext(card.selectedBranch ? { repo: card.repo.name, type: 'branch', branch: card.selectedBranch } : card.selectedTag ? { repo: card.repo.name, type: 'tag', tag: card.selectedTag } : { repo: card.repo.name, type: 'repo' })}" rel="noreferrer noopener">Chat</a>
        <a class="button" href="${card.toolbar.primaryHref}" target="_blank" rel="noreferrer noopener">${card.toolbar.primaryLabel}</a>
      </div>
    </div>
  `;
}

export function renderFileList(repo, files, route, fileCommits = {}) {
  if (!files.length) {
    return '<div class="repo-files-empty muted">No files found for this ref.</div>';
  }
  const renderPath = (file) => {
    const parts = file.split('/').filter(Boolean);
    return `<div class="repo-files-path"><span class="repo-files-icon">📄</span>${parts.map((part, index) => {
      const isLast = index === parts.length - 1;
      const href = isLast
        ? repoFileHref(repo, {
          branch: route?.branch || null,
          tag: route?.tag || null,
          commit: route?.commit || null,
          path: file,
        })
        : repoSelectionHref(repo, {
          branch: route?.branch || null,
          tag: route?.tag || null,
          path: parts.slice(0, index + 1).join('/'),
        });
      const segment = `<a class="repo-files-path-link${isLast ? ' final' : ''}" href="${href}">${escapeHtml(part)}</a>`;
      return isLast ? segment : `${segment}<span class="repo-files-path-separator">/</span>`;
    }).join('')}</div>`;
  };
  const renderCommit = (file) => {
    const oid = fileCommits[file];
    if (!oid) return '<span class="muted">—</span>';
    const short = oid.slice(0, 12);
    const href = repoFileHref(repo, {
      branch: route?.branch || null,
      tag: route?.tag || null,
      commit: oid,
      path: file,
    });
    return `<a class="mono" href="${href}" title="Blame ${escapeHtml(file)} @ ${short}">${escapeHtml(short)}</a>`;
  };
  return `
    <div class="repo-files">
    <div class="repo-files-header">
      <div>Path</div>
      <div>Commit</div>
      <div>Type</div>
    </div>
    ${files.map((file) => {
      const parts = file.split('/');
      const name = parts[parts.length - 1] || file;
      const ext = name.includes('.') ? name.split('.').pop() : 'file';
      return `
        <div class="repo-files-row mono">
          <div>${renderPath(file)}</div>
          <div>${renderCommit(file)}</div>
          <div>${escapeHtml(ext)}</div>
        </div>
      `;
    }).join('')}
    </div>
  `;
}

export function renderCommitList(repo, commits, route) {
  if (!commits.length) {
    return '<div class="detail-empty muted">No commits found.</div>';
  }
  return `
    <div class="repo-commit-list">
      ${commits.map((commit) => {
        const href = repoCommitHref(repo, {
          branch: route?.branch || null,
          tag: route?.tag || null,
          commit: commit.oid,
        });
        const decorations = commit.decorations?.length ? ` <span class="muted small">(${escapeHtml(commit.decorations.join(', '))})</span>` : '';
        return `
          <a class="repo-commit-item" href="${href}">
            <div class="repo-commit-top">
              <div class="mono">${escapeHtml(commit.oid.slice(0, 12))}</div>
              <span class="muted small">View commit</span>
            </div>
            <div class="repo-commit-summary">${escapeHtml(commit.summary)}</div>
            ${decorations}
            <div class="repo-commit-meta">${escapeHtml(commit.author)} · ${escapeHtml(commit.date)}</div>
          </a>
        `;
      }).join('')}
    </div>`;
}

export function renderRecentCommits(repo, commits, route, forceOpen = false) {
  const body = renderCommitList(repo, commits, route);
  if (commits.length <= 5) {
    return body;
  }
  return `
    <details class="small"${forceOpen ? ' open' : ''}>
      <summary style="cursor:pointer;">Recent commits (${commits.length})</summary>
      <div style="margin-top:10px;">${body}</div>
    </details>
  `;
}

export function renderRepoNotFound(route, repos) {
  const repoName = route.repoName || 'unknown';
  const repoList = repos.map((repo) => `<li class="list-item"><a href="${repoSelectionHref(repo)}">${escapeHtml(repo.name)}</a></li>`).join('');
  return `
    <div class="detail-shell">
      <div class="row" style="justify-content:space-between; align-items:flex-start;">
        <div>
          <div class="muted small">Repository not found</div>
          <h2 style="margin:4px 0 0;">${escapeHtml(repoName)}</h2>
        </div>
        <div class="actions">
          <a class="button" href="./">Back to all repos</a>
        </div>
      </div>
      <div class="detail-empty" style="margin-top:12px;">
        The requested repository is not in this viewer.
      </div>
    </div>
    <div class="detail-shell" style="margin-top:14px;">
      <h3 style="margin-top:0;">Available repositories</h3>
      <ul class="list">${repoList}</ul>
    </div>
  `;
}

export function renderCommitDetail(repo, data, route, options = {}) {
  const { getRepoHealth } = options;
  const healthState = getRepoHealth ? getRepoHealth(repo.name) : 'idle';
  const healthClass = repoHealthClass(healthState);
  const selectedCommit = findCommitSummary(data, route) || data.selectedCommit || data.latestCommit;
  const selectedSha = selectedCommit?.oid || route.commit || data.resolvedRef || data.selectedRef || data.ref || 'n/a';
  const commitDiff = Array.isArray(data.commitDiff) ? data.commitDiff : [];
  const listRoute = {
    branch: route.branch || '',
    tag: route.tag || '',
  };
  const parentList = (selectedCommit?.parents || []).map((parent) => `<span class="pill mono">${escapeHtml(parent.slice(0, 12))}</span>`).join(' ') || '<span class="muted">No parent data</span>';
  const diffList = commitDiff.length
    ? commitDiff.map((entry) => `
      <details class="repo-diff-file">
        <summary style="cursor:pointer;">
          <span class="repo-commit-top">
            <span class="repo-commit-summary">${entry.status === 'added' ? '+' : entry.status === 'deleted' ? '−' : '±'} ${escapeHtml(entry.path)}</span>
            <span class="muted small">${escapeHtml(entry.status)}</span>
          </span>
        </summary>
        <pre class="repo-diff-body">${escapeHtml(entry.patch.join('\n'))}</pre>
      </details>
    `).join('')
    : '<div class="detail-empty muted">No file changes found.</div>';
  return `
    <div class="repo-page">
      <div class="repo-hero">
        <div class="repo-breadcrumbs">
          <a href="./">repos</a>
          <span>/</span>
          <a href="${repoSelectionHref(repo, route)}">${escapeHtml(repo.name)}</a>
          <span>/</span>
          <span class="mono">${escapeHtml(selectedSha.slice(0, 12))}</span>
        </div>
        <div class="repo-title-row">
          <div class="repo-title">
            <div class="repo-meta">
              <h2>${escapeHtml(selectedSha.slice(0, 12))}</h2>
              <span class="health-badge ${healthClass}"><span class="health-dot"></span></span>
            </div>
            <div class="small muted">${escapeHtml(selectedCommit?.summary || 'Selected commit')}</div>
            <div class="repo-meta">
              <span class="pill">Author: ${escapeHtml(selectedCommit?.author || 'n/a')}</span>
              <span class="pill">Date: ${escapeHtml(selectedCommit?.date || 'n/a')}</span>
            </div>
          </div>
          <div class="actions">
            <a class="button" href="${repoCommitsHref(repo, route)}">Back to commits</a>
            <a class="button" href="${repoSelectionHref(repo, route)}">Back to code</a>
            <a class="button" href="${buildChatUrlWithContext({ repo: repo.name, type: 'commit', commit: selectedSha, branch: route.branch || undefined, tag: route.tag || undefined })}" rel="noreferrer noopener">Discuss in chat</a>
            <a class="button" href="${repo.url.replace(/\/$/, '')}/commit/${encodeURIComponent(selectedSha)}" target="_blank" rel="noreferrer noopener">Open upstream</a>
          </div>
        </div>
        <div class="repo-tabs" role="tablist" aria-label="Repository sections">
          <a class="repo-tab" href="${repoSelectionHref(repo, route)}">Code</a>
          <a class="repo-tab" href="${repoCommitsHref(repo, route)}">Commits</a>
          <a class="repo-tab active" href="${repoCommitHref(repo, route)}">Commit</a>
        </div>
      </div>

      <div class="repo-layout">
        <div class="repo-main">
          <div class="repo-sidebar-card">
            <div class="row" style="justify-content:space-between; align-items:center;">
              <h3 style="margin:0;">Commit message</h3>
              <span class="muted small mono">${escapeHtml(selectedSha.slice(0, 12))}</span>
            </div>
            <div style="margin-top:10px; white-space:pre-wrap;">${escapeHtml(selectedCommit?.message || 'n/a')}</div>
          </div>
          <div class="repo-sidebar-card" style="margin-top:14px;">
            <div class="row" style="justify-content:space-between; align-items:center;">
              <h3 style="margin:0;">Commit diff</h3>
              <span class="muted small">${commitDiff.length} changed</span>
            </div>
            <div style="margin-top:10px;">${diffList}</div>
          </div>
          <div class="repo-sidebar-card" style="margin-top:14px;">
            <details>
              <summary style="cursor:pointer;">
                <span class="row" style="justify-content:space-between; align-items:center; width:100%;">
                  <span class="muted small">Files at commit · ${data.files.length} entries</span>
                </span>
              </summary>
              <div style="margin-top:10px;">${renderFileList(repo, data.files, route, data.fileCommits)}</div>
            </details>
          </div>
        </div>
        <aside class="repo-sidebar">
          <div class="repo-sidebar-card">
            <div class="muted small">Parents</div>
            <div class="row" style="margin-top:8px; gap:6px; flex-wrap:wrap;">${parentList}</div>
          </div>
          <div class="repo-sidebar-card">
            <div class="muted small">Browse at commit</div>
            <div style="margin-top:10px;">
              <a class="button" href="${repoBrowseAtCommitHref(repo, { branch: route.branch || null, tag: route.tag || null, commit: selectedSha })}">Open code view</a>
            </div>
          </div>
          <div class="repo-sidebar-card">
            <div class="muted small">Recent commits</div>
            <div style="margin-top:10px;">${renderRecentCommits(repo, data.commits, listRoute)}</div>
          </div>
        </aside>
      </div>
    </div>
  `;
}

export function renderRepoDetail(repo, data, route, options = {}) {
  const { getRepoHealth, repoState, refreshingRepos } = options;
  const branchSelected = route.branch
    ? route.branch
    : (route.tag ? (data.branchForSelection || '') : (data.branches.includes(data.selectedRef) ? data.selectedRef : ''));
  const tagSelected = route.tag && data.tags.includes(route.tag) ? route.tag : (data.tags.includes(data.selectedRef) ? data.selectedRef : '');
  const currentRef = escapeHtml(data.resolvedRef || data.selectedRef || data.ref || 'n/a');
  const healthState = getRepoHealth ? getRepoHealth(repo.name) : 'idle';
  const healthClass = repoHealthClass(healthState);
  const currentCommit = data.latestCommit || null;
  const commitCount = data.commits.length;
  const selectedView = route.view === 'commits' ? 'commits' : 'code';
  const displayedFiles = route.path ? data.files.filter((file) => file === route.path || file.startsWith(`${route.path.replace(/\/+$/, '')}/`)) : data.files;
  return `
    <div class="repo-page">
      <div class="repo-hero">
        <div class="repo-breadcrumbs">
          <a href="./">repos</a>
          <span>/</span>
          <span class="mono">${escapeHtml(repo.name)}</span>
        </div>
        <div class="repo-title-row">
          <div class="repo-title">
            <div class="repo-meta">
              <h2>${escapeHtml(repo.name)}</h2>
              <span class="health-badge ${healthClass}"><span class="health-dot"></span></span>
            </div>
            <div class="small muted"><a href="${repo.url}" target="_blank" rel="noreferrer noopener">${repo.url}</a></div>
            <div class="repo-meta">
              <span class="pill">Ref: <span class="mono">${currentRef}</span></span>
              <span class="pill">Files: ${data.files.length}</span>
              <span class="pill">Commits: ${commitCount}</span>
              <span class="pill" style="opacity:.8;">${escapeHtml((repoState && repoState.get(repo.name)) || 'idle')}</span>
            </div>
          </div>
          <div class="actions">
            <button type="button" data-refresh-repo="${repo.name}" ${refreshingRepos && refreshingRepos.has(repo.name) ? 'disabled' : ''}>${refreshingRepos && refreshingRepos.has(repo.name) ? 'Refreshing...' : 'Refresh'}</button>
            <a class="button" href="./">Back to repos</a>
            <a class="button" href="${buildChatUrlWithContext(route.branch ? { repo: repo.name, type: 'branch', branch: route.branch } : route.tag ? { repo: repo.name, type: 'tag', tag: route.tag } : { repo: repo.name, type: 'repo' })}" rel="noreferrer noopener">Discuss in chat</a>
            <a class="button" href="${repo.url}" target="_blank" rel="noreferrer noopener">Open upstream</a>
          </div>
        </div>
        <div class="repo-tabs" role="tablist" aria-label="Repository sections">
          <a class="repo-tab${selectedView === 'code' ? ' active' : ''}" href="${repoSelectionHref(repo, route)}">Code</a>
          <a class="repo-tab${selectedView === 'commits' ? ' active' : ''}" href="${repoCommitsHref(repo, route)}">Commits</a>
        </div>
      </div>

      ${data.branches.length === 0 && data.tags.length === 0 ? `
        <div class="repo-toolbar" style="background:#3a1f1f;color:#ff9999;padding:8px 12px;border-radius:6px;">
          <span class="small">No branches or tags found — local clone may be empty. Click Refresh to re-fetch.</span>
        </div>
      ` : ''}
      <div class="repo-toolbar">
        <select class="repo-select" data-branch-select="${repo.name}">
          ${buildSelectOptions(data.branches, branchSelected, 'Switch branch')}
        </select>
        <select class="repo-select" data-tag-select="${repo.name}">
          ${buildSelectOptions(data.tags, tagSelected, 'Switch tag')}
        </select>
        <div class="spacer"></div>
        ${currentCommit ? `
          <div class="muted small">Latest commit <span class="mono">${escapeHtml(currentCommit.oid ? currentCommit.oid.slice(0, 12) : 'n/a')}</span></div>
        ` : ''}
      </div>

      <div class="repo-layout">
        <div class="repo-main">
          ${selectedView === 'commits' ? `
            <div class="repo-sidebar-card">
              <div class="row" style="justify-content:space-between; align-items:center;">
                <h3 style="margin:0;">Commits</h3>
                <span class="muted small">${commitCount} loaded</span>
              </div>
              <div style="margin-top:10px;">${renderRecentCommits(repo, data.commits, route, true)}</div>
            </div>
          ` : `
            <div class="repo-sidebar-card">
              <div class="row" style="justify-content:space-between; align-items:center;">
                <h3 style="margin:0;">Files</h3>
                <span class="muted small">${displayedFiles.length} entries</span>
              </div>
              <div style="margin-top:10px;">${renderFileList(repo, displayedFiles, route, data.fileCommits)}</div>
            </div>
          `}
          <div class="repo-sidebar-card repo-bumper" aria-hidden="true"></div>
        </div>
        <aside class="repo-sidebar">
          <div class="repo-sidebar-card">
            <div class="muted small">About</div>
            <div style="margin-top:8px;">Static browser clone of <span class="mono">${escapeHtml(repo.name)}</span>.</div>
            <div class="small muted" style="margin-top:10px;">Commit: <span class="mono">${escapeHtml(currentCommit?.oid ? currentCommit.oid.slice(0, 12) : 'n/a')}</span></div>
            <div class="small muted" style="margin-top:4px;">Author: ${escapeHtml(currentCommit?.author || 'n/a')}</div>
            <div class="small muted" style="margin-top:4px;">Date: ${escapeHtml(currentCommit?.date || 'n/a')}</div>
          </div>
          <div class="repo-sidebar-card">
            <div class="muted small">Stats</div>
            <div class="small" style="margin-top:8px;"><span class="muted">Branches:</span> ${data.branches.length}</div>
            <div class="small"><span class="muted">Tags:</span> ${data.tags.length}</div>
            <div class="small"><span class="muted">Selected ref:</span> <span class="mono">${escapeHtml(data.selectedRef || 'n/a')}</span></div>
          </div>
          <div class="repo-sidebar-card">
            <div class="muted small">Recent commits</div>
            <div style="margin-top:10px;">${renderRecentCommits(repo, data.commits, route)}</div>
          </div>
          <div class="repo-sidebar-card repo-bumper" aria-hidden="true"></div>
        </aside>
      </div>
    </div>
  `;
}
