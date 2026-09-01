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
