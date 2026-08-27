import { bootstrapDemoPageChrome } from './page-shell.mjs';
import { resolveHref } from './page-path.js';

export const GIT_REPOS = [
  {
    name: 'nostr-dag',
    url: 'https://github.com/RandyMcMillan/nostr-dag',
    dir: '/repos/nostr-dag',
  },
  {
    name: 'isomorphic-git',
    url: 'https://github.com/isomorphic-git/isomorphic-git',
    dir: '/repos/isomorphic-git',
  },
  {
    name: 'nostr-tools',
    url: 'https://github.com/nbd-wtf/nostr-tools',
    dir: '/repos/nostr-tools',
  },
  {
    name: 'js-libp2p',
    url: 'https://github.com/libp2p/js-libp2p',
    dir: '/repos/js-libp2p',
  },
  {
    name: 'js-libp2p-noise',
    url: 'https://github.com/ChainSafe/js-libp2p-noise',
    dir: '/repos/js-libp2p-noise',
  },
  {
    name: 'js-libp2p-yamux',
    url: 'https://github.com/ChainSafe/js-libp2p-yamux',
    dir: '/repos/js-libp2p-yamux',
  },
  {
    name: 'discv5',
    url: 'https://github.com/ChainSafe/discv5',
    dir: '/repos/discv5',
  },
  {
    name: 'lightning-fs',
    url: 'https://github.com/isomorphic-git/lightning-fs',
    dir: '/repos/lightning-fs',
  },
];

export function isSafariMobile() {
  const ua = globalThis.navigator?.userAgent || '';
  return /iPhone|iPad|iPod/i.test(ua) && /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua);
}

export function bootstrapGitChrome({
  headerRoot,
  footerRoot = null,
  footerTitle = 'Logger',
  footerInitialTitle = 'starting...',
  footerInitialLevel = 'none',
  footerMode = 'after-paint',
} = {}) {
  return bootstrapDemoPageChrome({
    headerRoot,
    footerRoot,
    headerOptions: {
      title: 'nostr-dag',
      logoHref: resolveHref('../git/', window.location.href),
      iconHref: resolveHref('../shared/favicon.ico', window.location.href),
      subtitleHtml: '',
      navItems: [
        { label: 'dag', href: resolveHref('../dag/', window.location.href) },
        { label: 'Bridge', href: resolveHref('../bridge/', window.location.href) },
      ],
    },
    footerOptions: {
      title: footerTitle,
      initialState: 'idle',
      initialTitle: footerInitialTitle,
      initialLevel: footerInitialLevel,
    },
    footerMode,
  });
}

export function remoteProbeUrl(repo) {
  return `${new URL(repo.url).origin}/favicon.ico`;
}

export async function probeRemoteHost(repo) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    await fetch(remoteProbeUrl(repo), {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeout);
  }
}
