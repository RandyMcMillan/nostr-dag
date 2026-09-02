/**
 * Git-context link helpers for chat integration.
 *
 * Builds URLs between the chat page and the git viewer,
 * accounting for both local dev and GitHub Pages path prefixes.
 */

import { resolveHref } from './page-path.js';

function isInGitViewer(baseHref = window.location.href) {
  return new URL(baseHref).pathname.includes('/git/');
}

/**
 * Build a git-viewer URL for a given git context object.
 * @param {{repo:string,type:string,branch?:string,tag?:string,commit?:string,path?:string}} git
 * @param {string} [baseHref]
 * @returns {string}
 */
export function gitContextToHref(git, baseHref = window.location.href) {
  const inGit = isInGitViewer(baseHref);
  const { repo, type, branch, tag, commit, path } = git;
  const search = new URLSearchParams();
  search.set('repo', repo);

  if (type === 'repo') {
    return resolveHref(inGit ? `./?${search}` : `./git/?${search}`, baseHref);
  }
  if (type === 'branch') {
    search.set('branch', branch || '');
    return resolveHref(inGit ? `./?${search}` : `./git/?${search}`, baseHref);
  }
  if (type === 'tag') {
    search.set('tag', tag || '');
    return resolveHref(inGit ? `./?${search}` : `./git/?${search}`, baseHref);
  }
  if (type === 'commit') {
    search.set('view', 'commit');
    if (branch) search.set('branch', branch);
    if (tag) search.set('tag', tag);
    if (commit) search.set('commit', commit);
    return resolveHref(inGit ? `./?${search}` : `./git/?${search}`, baseHref);
  }
  if (type === 'file' || type === 'blame') {
    if (branch) search.set('branch', branch);
    if (tag) search.set('tag', tag);
    if (commit) search.set('commit', commit);
    if (path) search.set('path', path);
    return resolveHref(inGit ? `./blame.html?${search}` : `./git/blame.html?${search}`, baseHref);
  }
  return resolveHref(inGit ? `./?${search}` : `./git/?${search}`, baseHref);
}

/**
 * Human-readable label for a git context.
 * @param {{repo:string,type:string,branch?:string,tag?:string,commit?:string,path?:string}} git
 * @returns {string}
 */
export function gitContextToLabel(git) {
  const { repo, type, branch, tag, commit, path } = git;
  const parts = [repo];
  if (branch) parts.push(`@${branch}`);
  else if (tag) parts.push(`#${tag}`);
  else if (commit) parts.push(`·${commit.slice(0, 12)}`);
  if (path) parts.push(`·${path}`);
  return parts.join(' ');
}

/**
 * Build a chat-page URL pre-loaded with a git context.
 * @param {{repo:string,type:string,branch?:string,tag?:string,commit?:string,path?:string}} git
 * @param {string} [baseHref]
 * @returns {string}
 */
export function buildChatUrlWithContext(git, baseHref = window.location.href) {
  const inGit = isInGitViewer(baseHref);
  const ctx = encodeURIComponent(JSON.stringify(git));
  const search = new URLSearchParams();
  search.set('gitContext', ctx);
  return resolveHref(inGit ? `../chat?${search}` : `./chat?${search}`, baseHref);
}

/**
 * Parse a gitContext URL parameter string back into an object.
 * @param {string} raw
 * @returns {{repo:string,type:string,branch?:string,tag?:string,commit?:string,path?:string}|null}
 */
export function parseGitContextParam(raw) {
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    if (!parsed || typeof parsed !== 'object') return null;
    const repo = String(parsed.repo || '').trim();
    const type = String(parsed.type || '').trim();
    if (!repo) return null;
    const result = { repo, type };
    if (parsed.branch) result.branch = String(parsed.branch);
    if (parsed.tag) result.tag = String(parsed.tag);
    if (parsed.commit) result.commit = String(parsed.commit);
    if (parsed.path) result.path = String(parsed.path);
    return result;
  } catch {
    return null;
  }
}
