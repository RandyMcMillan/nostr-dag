#!/usr/bin/env node
/**
 * Verify that GH Pages bridge can discover the local peer's kind-0 presence
 * event through public Nostr relays.
 *
 * Connects to the same relays the bridge uses, subscribes for kind-0 from
 * the deterministic pubkey, and asserts at least one relay streams the event.
 */

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

async function checkRelay(url) {
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      resolve({ url, ok: false, error: err.message });
      return;
    }

    const timer = setTimeout(() => {
      ws.close();
      resolve({ url, ok: false, error: 'timeout' });
    }, TIMEOUT_MS);

    ws.onopen = () => {
      const subId = 'gh-check-' + Math.random().toString(36).slice(2, 8);
      // Single-filter object (NOT array) — mirrors the fix in bridge-page.mjs
      const req = JSON.stringify(['REQ', subId, {
        kinds: [0],
        authors: [DETERMINISTIC_PUBKEY],
        limit: 1,
      }]);
      ws.send(req);
    };

    ws.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }
      if (!Array.isArray(data)) return;
      const [type, subId, payload] = data;
      if (type === 'EVENT' && payload && payload.pubkey === DETERMINISTIC_PUBKEY) {
        clearTimeout(timer);
        ws.close();
        resolve({ url, ok: true, eventId: payload.id });
      }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      resolve({ url, ok: false, error: 'websocket error' });
    };

    ws.onclose = () => {
      clearTimeout(timer);
      resolve({ url, ok: false, error: 'closed without event' });
    };
  });
}

async function main() {
  console.log(`Checking for kind-0 presence from ${DETERMINISTIC_PUBKEY}`);
  console.log(`Relays: ${DEFAULT_RELAYS.length}`);

  const results = await Promise.all(DEFAULT_RELAYS.map(checkRelay));

  let found = 0;
  for (const r of results) {
    const status = r.ok ? '✅' : '❌';
    console.log(`${status} ${r.url}${r.ok ? ` → ${r.eventId}` : ` → ${r.error}`}`);
    if (r.ok) found++;
  }

  console.log(`\nFound on ${found}/${DEFAULT_RELAYS.length} relays`);

  if (found === 0) {
    console.error('FAIL: local peer kind-0 event not visible on any relay');
    process.exit(1);
  }
  console.log('PASS: GH Pages bridge should be able to discover the local peer');
  process.exit(0);
}

main();
