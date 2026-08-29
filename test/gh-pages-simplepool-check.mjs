#!/usr/bin/env node
/**
 * Faithful reproduction of the GH Pages bridge peer-discovery logic.
 * Uses nostr-tools SimplePool exactly like the browser does.
 */

import { SimplePool } from 'nostr-tools/pool';

const DEFAULT_RELAYS = [
  'wss://nos.lol',
  'wss://relay.nostr.com',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://nostr.wine',
  'wss://top.testrelay.top',
  'wss://relay.pocketnostr.com',
  'wss://basspistol.org',
  'wss://relay.ngit.dev',
];

const DETERMINISTIC_PUBKEY = '2d724a13a80b6002607737ad1a99f3c0b148843707d59ac3bff08c7fce72ecce';
const TIMEOUT_MS = 35000;

const pool = new SimplePool();

const timer = setTimeout(() => {
  console.error('FAIL: timed out waiting for kind-0 event');
  pool.close(DEFAULT_RELAYS);
  process.exit(1);
}, TIMEOUT_MS);

console.log('Subscribing via SimplePool (same API as browser)...');

const sub = pool.subscribeMany(DEFAULT_RELAYS, { limit: 500 }, {
  onevent(event) {
    if (event.kind === 0 && event.pubkey === DETERMINISTIC_PUBKEY) {
      clearTimeout(timer);
      console.log('PASS: received kind-0 presence event');
      console.log('  id:', event.id);
      console.log('  pubkey:', event.pubkey);
      try {
        const content = JSON.parse(event.content);
        console.log('  name:', content.name);
        console.log('  peer_id:', content.peer_id);
      } catch {
        console.log('  content:', event.content.slice(0, 200));
      }
      pool.close(DEFAULT_RELAYS);
      process.exit(0);
    }
  },
  onclose() {
    console.log('Subscription closed by relay(s)');
  },
  oneose() {
    console.log('End of stored events');
  },
});
