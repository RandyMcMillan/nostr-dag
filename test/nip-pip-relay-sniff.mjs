/**
 * NIP-PIP relay sniffer — subscribes to default relays for manifest/slice
 * events (kind 39078/39079) and logs them in real time.
 *
 * Usage:
 *   node test/nip-pip-relay-sniff.mjs
 *
 * Keep this running while you start the native peer with:
 *   GIT_MIRROR_REPOS="https://github.com/RandyMcMillan/nostr-dag" \
 *     P2P_ENABLE=1 cargo run --bin p2p-node --features p2p
 *
 * If the relay path works, you should see manifest + slice events within
 * a few minutes of the peer finishing its mirror cycle.
 */

import { SimplePool } from '../demo/vendor/nostr-tools.mjs';

const RELAYS = [
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

const MANIFEST_KIND = 39078;
const SLICE_KIND = 39079;
const REQUEST_KIND = 39077;

const pool = new SimplePool();

console.log('Subscribing to relays for NIP-PIP events...');
console.log('Relays:', RELAYS.length);

const sub = pool.subscribeMany(RELAYS, [
  { kinds: [MANIFEST_KIND, SLICE_KIND, REQUEST_KIND], limit: 0 },
], {
  onevent(event) {
    const time = new Date().toISOString();
    if (event.kind === MANIFEST_KIND) {
      try {
        const content = JSON.parse(event.content);
        console.log(`[${time}] MANIFEST id=${event.id.slice(0, 16)}… path=${content.path} size=${content.size} packets=${content.packets}`);
      } catch {
        console.log(`[${time}] MANIFEST id=${event.id.slice(0, 16)}… (raw)`);
      }
    } else if (event.kind === SLICE_KIND) {
      try {
        const content = JSON.parse(event.content);
        const parent = event.tags.find((t) => t[0] === 'e')?.[1] || '?';
        console.log(`[${time}] SLICE   id=${event.id.slice(0, 16)}… seq=${content.header?.seq_num}/${content.header?.total_packets} parent=${parent.slice(0, 16)}…`);
      } catch {
        console.log(`[${time}] SLICE   id=${event.id.slice(0, 16)}… (raw)`);
      }
    } else if (event.kind === REQUEST_KIND) {
      try {
        const content = JSON.parse(event.content);
        console.log(`[${time}] REQUEST id=${event.id.slice(0, 16)}… path=${content.path}`);
      } catch {
        console.log(`[${time}] REQUEST id=${event.id.slice(0, 16)}… (raw)`);
      }
    }
  },
  oneose() {
    console.log('EOSE received — now listening for new events');
  },
});

function shutdown() {
  console.log('\nClosing relay subscriptions...');
  sub.close();
  pool.close(RELAYS);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

setTimeout(() => {
  console.log('60s elapsed — still listening (Ctrl+C to stop)');
}, 60_000);
