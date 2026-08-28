import { bootstrapDemoPageChrome } from './page-shell.mjs';
import { resolveHref } from './page-path.js';

export const DAG_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.com',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://nostr.wine',
];

export const DAG_CACHE_KEY = 'nostr-dag-demo-cache-v1';
export const DAG_SITE_URL = 'https://randymcmillan.github.io/nostr-dag';
export const DAG_QUORUM_ID = 'nostr-dag-quorum-5';
export const DAG_PARTICIPANT_KEY_LABELS = ['nostr-dag-native', 'nostr-dag-wasm'];
export const DAG_PARTICIPANT_NAMES = ['alice', 'bob', 'carol', 'dave', 'eve'];
export const DAG_PARTICIPANT_DISPLAY_NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'];
export const DAG_FED_COUNT = 5;

export function bootstrapDagChrome({
  headerRoot,
  footerRoot,
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
        { label: 'dag', href: resolveHref('./', window.location.href), current: true },
        { label: 'Bridge', href: resolveHref('../bridge/', window.location.href) },
      ],
    },
    footerOptions: {
      title: 'Logger',
      initialState: 'idle',
      initialTitle: 'starting...',
      initialLevel: 'info',
    },
    footerMode: 'after-paint',
  });
}
