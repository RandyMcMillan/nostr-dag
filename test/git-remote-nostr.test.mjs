import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  gitRemoteHelperUrl,
  normalizeNostrCloneUrl,
  parseNostrCloneUrl,
} from '../demo/shared/git-remote-nostr.mjs';

const fixturesPath = new URL('./fixtures/nip34-interop-vectors.json', import.meta.url);
const fixtures = JSON.parse(await readFile(fixturesPath, 'utf8'));

test('NIP-34 fixtures match JS helper behavior', () => {
  for (const fixture of fixtures) {
    const parsed = parseNostrCloneUrl(fixture.input);
    assert.equal(normalizeNostrCloneUrl(fixture.input), fixture.normalized, fixture.name);
    assert.equal(gitRemoteHelperUrl(fixture.input), fixture.helper, fixture.name);

    assert.equal(parsed.kind, fixture.kind, fixture.name);
    if (fixture.kind === 'announcement') {
      assert.equal(parsed.naddr, fixture.naddr, fixture.name);
    } else {
      assert.equal(parsed.owner, fixture.owner, fixture.name);
      assert.equal(parsed.relayHint, fixture.relay_hint, fixture.name);
      assert.equal(parsed.identifier, fixture.identifier, fixture.name);
    }
  }
});

test('parseNostrCloneUrl rejects invalid URLs', () => {
  const invalid = [
    'https://github.com/nostr-protocol/nips',
    'nostr://',
    'nostr://npub1abcd/',
    'nostr://npub1abcd/relay/repo/extra',
    'nostr://npub1abcd/%ZZ',
  ];

  for (const input of invalid) {
    assert.throws(() => parseNostrCloneUrl(input), /nostr:\/\//u, input);
  }
});
