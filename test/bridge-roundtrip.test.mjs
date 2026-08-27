import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractBridgeRoundTripStartMs,
  stampBridgeRoundTripTag,
} from '../demo/shared/bridge-roundtrip.mjs';

test('stampBridgeRoundTripTag appends a round-trip marker without mutating the caller', () => {
  const tags = [['e', 'parent']];
  const stamped = stampBridgeRoundTripTag(tags, 12345);

  assert.deepEqual(tags, [['e', 'parent']]);
  assert.deepEqual(stamped, [['e', 'parent'], ['bridge-rtt', '12345']]);
});

test('extractBridgeRoundTripStartMs reads the round-trip marker from a tag list', () => {
  const event = {
    tags: [
      ['e', 'parent'],
      ['bridge-rtt', '24680'],
    ],
  };

  assert.equal(extractBridgeRoundTripStartMs(event), 24_680);
});

test('extractBridgeRoundTripStartMs accepts the nested tag shape used by older drafts', () => {
  const event = {
    tags: [
      ['x', 'bridge-rtt', '13579'],
    ],
  };

  assert.equal(extractBridgeRoundTripStartMs(event), 13_579);
});
