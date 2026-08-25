import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  gitRemoteTransportUrl,
  gitRemoteHelperUrl,
  normalizeNostrCloneUrl,
  normalizeP2pCloneUrl,
  nostrToP2pCloneUrl,
  p2pToNostrCloneUrl,
  parseP2pCloneUrl,
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

test('nostr:// and p2p:// conversions are reversible', () => {
  const nostr = 'nostr://npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/my%20repo';
  const p2p = 'p2p://npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/my%20repo';

  assert.equal(normalizeP2pCloneUrl(p2p), p2p);
  assert.equal(nostrToP2pCloneUrl(nostr), p2p);
  assert.equal(p2pToNostrCloneUrl(p2p), nostr);

  const parsed = parseP2pCloneUrl(p2p);
  assert.equal(parsed.kind, 'coordinate');
  assert.equal(parsed.identifier, 'my repo');
});

test('gitRemoteTransportUrl supports nostr/p2p/http/https/ssh clone remotes', () => {
  assert.equal(
    gitRemoteTransportUrl('nostr://naddr1qqx8xq'),
    'nostr::nostr://naddr1qqx8xq',
  );
  assert.equal(
    gitRemoteTransportUrl('p2p://naddr1qqx8xq'),
    'p2p::p2p://naddr1qqx8xq',
  );
  assert.equal(
    gitRemoteTransportUrl('https://github.com/RandyMcMillan/nostr-dag'),
    'https://github.com/RandyMcMillan/nostr-dag',
  );
  assert.equal(
    gitRemoteTransportUrl('http://localhost:3000/nostr-dag.git'),
    'http://localhost:3000/nostr-dag.git',
  );
  assert.equal(
    gitRemoteTransportUrl('ssh://git@github.com/RandyMcMillan/nostr-dag.git'),
    'ssh://git@github.com/RandyMcMillan/nostr-dag.git',
  );
  assert.equal(
    gitRemoteTransportUrl('git@github.com:RandyMcMillan/nostr-dag.git'),
    'git@github.com:RandyMcMillan/nostr-dag.git',
  );
  assert.throws(
    () => gitRemoteTransportUrl('ftp://example.com/repo.git'),
    /unsupported remote URL scheme/u,
  );
});
