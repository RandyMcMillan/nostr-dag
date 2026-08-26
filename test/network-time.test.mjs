import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildNetworkTimeQuery,
  buildNetworkTimeResponse,
  computeConsensusOffset,
  parseNetworkTimeMessage,
} from '../demo/shared/network-time.mjs';

test('network time query/response payloads round-trip', () => {
  const query = buildNetworkTimeQuery({
    requestId: 'req-1',
    requesterPeerId: 'peer-a',
    sentAtMs: 1000,
  });
  const response = buildNetworkTimeResponse(query, 'peer-b', 1250);
  const parsed = parseNetworkTimeMessage(JSON.stringify(response));

  assert.equal(query.protocol, 'nostr-dag-network-time');
  assert.equal(response.type, 'response');
  assert.equal(parsed.request_id, 'req-1');
  assert.equal(parsed.requester_peer_id, 'peer-a');
  assert.equal(parsed.responder_peer_id, 'peer-b');
  assert.equal(parsed.server_time_ms, 1250);
});

test('computeConsensusOffset uses the median sample offset', () => {
  const offsetMs = computeConsensusOffset([
    { offsetMs: 120 },
    { offsetMs: 1000 },
    { offsetMs: 140 },
    { offsetMs: 160 },
  ]);

  assert.equal(offsetMs, 150);
});

test('parseNetworkTimeMessage rejects unrelated payloads', () => {
  assert.equal(parseNetworkTimeMessage('{"protocol":"other","version":1,"type":"query"}'), null);
  assert.equal(parseNetworkTimeMessage('not json'), null);
});
