import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NIP34_ISSUE_KIND,
  NIP34_PULL_REQUEST_KIND,
  NIP34_REPOSITORY_ANNOUNCEMENT_KIND,
  NIP34_REPOSITORY_STATE_KIND,
  PIP_ATTEST_KIND,
  PIP_SEAL_KIND,
  PIP_TRANSFER_MANIFEST_KIND,
  PIP_TRANSFER_SLICE_KIND,
  buildAttestDraft,
  buildIssueDraft,
  buildPullRequestDraft,
  buildRepositoryAnnouncementDraft,
  buildRepositoryStateDraft,
  buildSealDraft,
  buildTransferManifestDraft,
  buildTransferSliceDraft,
  packetizePayload,
  repositoryAddress,
  sha256Hex,
  utf8Bytes,
} from '../demo/shared/nip34-quorum.mjs';

test('buildRepositoryAnnouncementDraft emits a real NIP-34 repository announcement', () => {
  const draft = buildRepositoryAnnouncementDraft({
    pubkey: 'a'.repeat(64),
    createdAt: 1_700_000_000,
    repoId: 'nostr-dag-demo',
    name: 'nostr-dag demo',
    description: 'demo repository',
    web: ['https://github.com/RandyMcMillan/nostr-dag'],
    clone: ['nostr://npub1example/nostr-dag-demo'],
    relays: ['wss://nos.lol', 'wss://relay.primal.net'],
    earliestUniqueCommit: '1'.repeat(40),
    maintainers: ['a'.repeat(64), 'b'.repeat(64)],
    hashtags: ['nip34', 'quorum'],
  });

  assert.equal(draft.kind, NIP34_REPOSITORY_ANNOUNCEMENT_KIND);
  assert.deepEqual(draft.tags[0], ['d', 'nostr-dag-demo']);
  assert.ok(draft.tags.some((tag) => tag[0] === 'clone' && tag[1] === 'nostr://npub1example/nostr-dag-demo'));
  assert.ok(draft.tags.some((tag) => tag[0] === 'relays' && tag.includes('wss://relay.primal.net')));
  assert.ok(draft.tags.some((tag) => tag[0] === 'maintainers' && tag.includes('b'.repeat(64))));
  assert.ok(draft.tags.some((tag) => tag[0] === 'r' && tag[1] === '1'.repeat(40) && tag[2] === 'euc'));
});

test('buildRepositoryStateDraft emits refs and preserves DAG parents', () => {
  const draft = buildRepositoryStateDraft({
    pubkey: 'a'.repeat(64),
    createdAt: 1_700_000_001,
    repoId: 'nostr-dag-demo',
    refs: [['heads/main', '2'.repeat(40)], ['tags/demo-v1', '3'.repeat(40)]],
    head: 'refs/heads/main',
    parents: ['f'.repeat(64)],
  });

  assert.equal(draft.kind, NIP34_REPOSITORY_STATE_KIND);
  assert.ok(draft.tags.some((tag) => tag[0] === 'refs/heads/main' && tag[1] === '2'.repeat(40)));
  assert.ok(draft.tags.some((tag) => tag[0] === 'refs/tags/demo-v1' && tag[1] === '3'.repeat(40)));
  assert.ok(draft.tags.some((tag) => tag[0] === 'HEAD' && tag[1] === 'ref: refs/heads/main'));
  assert.ok(draft.tags.some((tag) => tag[0] === 'e' && tag[1] === 'f'.repeat(64)));
});

test('issue and pull request drafts carry their NIP-34 repository address', () => {
  const repoAddressTag = repositoryAddress('a'.repeat(64), 'nostr-dag-demo');
  const issue = buildIssueDraft({
    pubkey: 'b'.repeat(64),
    createdAt: 1_700_000_002,
    repoAddress: repoAddressTag,
    repositoryOwner: 'a'.repeat(64),
    subject: 'Demo issue',
    labels: ['demo'],
    content: 'Issue body',
    parents: ['1'.repeat(64)],
  });
  const pr = buildPullRequestDraft({
    pubkey: 'c'.repeat(64),
    createdAt: 1_700_000_003,
    repoAddress: repoAddressTag,
    repositoryOwner: 'a'.repeat(64),
    repoRootCommit: '9'.repeat(40),
    subject: 'Demo PR',
    labels: ['quorum'],
    headCommit: '2'.repeat(40),
    clone: ['nostr://npub1example/nostr-dag-demo'],
    branchName: 'quorum-demo',
    mergeBase: '3'.repeat(40),
    content: 'PR body',
    parents: ['2'.repeat(64)],
  });

  assert.equal(issue.kind, NIP34_ISSUE_KIND);
  assert.ok(issue.tags.some((tag) => tag[0] === 'a' && tag[1] === repoAddressTag));
  assert.equal(pr.kind, NIP34_PULL_REQUEST_KIND);
  assert.ok(pr.tags.some((tag) => tag[0] === 'clone' && tag[1] === 'nostr://npub1example/nostr-dag-demo'));
  assert.ok(pr.tags.some((tag) => tag[0] === 'branch-name' && tag[1] === 'quorum-demo'));
});

test('packetizePayload and quorum drafts build the manifest/slice/attest/seal sequence', async () => {
  const payload = utf8Bytes(JSON.stringify({ hello: 'world', count: 3 }));
  const digest = await sha256Hex(payload);
  const slices = packetizePayload('root-1', payload, 8);

  assert.ok(slices.length > 1);

  const manifest = buildTransferManifestDraft({
    pubkey: 'a'.repeat(64),
    createdAt: 1_700_000_010,
    rootId: 'root-1',
    totalBytes: payload.length,
    totalSlices: slices.length,
    parents: ['4'.repeat(64)],
  });
  const slice = buildTransferSliceDraft({
    pubkey: 'a'.repeat(64),
    createdAt: 1_700_000_011,
    manifestId: '5'.repeat(64),
    rootId: 'root-1',
    seq: slices[0].seq,
    totalSlices: slices[0].totalSlices,
    data: slices[0].data,
    parents: ['6'.repeat(64)],
  });
  const attest = buildAttestDraft({
    pubkey: 'b'.repeat(64),
    createdAt: 1_700_000_012,
    rootId: 'root-1',
    sha256: digest,
    manifestId: '5'.repeat(64),
    sliceIds: ['7'.repeat(64), '8'.repeat(64)],
    parents: [],
  });
  const seal = buildSealDraft({
    pubkey: 'c'.repeat(64),
    createdAt: 1_700_000_013,
    rootId: 'root-1',
    sha256: digest,
    attestIds: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)],
    parents: [],
  });

  assert.equal(manifest.kind, PIP_TRANSFER_MANIFEST_KIND);
  assert.match(manifest.content, /"type":"manifest"/);
  assert.equal(slice.kind, PIP_TRANSFER_SLICE_KIND);
  assert.ok(slice.tags.some((tag) => tag[0] === 'e' && tag[1] === '5'.repeat(64)));
  assert.equal(attest.kind, PIP_ATTEST_KIND);
  assert.match(attest.content, new RegExp(`"sha256":"${digest}"`));
  assert.equal(attest.tags.filter((tag) => tag[0] === 'e').length, 3);
  assert.equal(seal.kind, PIP_SEAL_KIND);
  assert.match(seal.content, /"type":"seal"/);
  assert.equal(seal.tags.filter((tag) => tag[0] === 'e').length, 4);
});
