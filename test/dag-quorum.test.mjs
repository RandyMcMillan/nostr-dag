/**
 * test/dag-quorum.test.mjs
 *
 * Unit tests for the DAG quorum orchestration module
 * (demo/shared/dag-quorum.mjs).
 *
 * These tests exercise the participant factory, metadata builder, and the
 * full NIP-34 + quorum sequence orchestrators with all WASM/browser
 * dependencies stubbed out.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createParticipantProfile,
  createParticipants,
  buildMetadataEvent,
  createNip34SequenceEvents,
  createQuorumSequenceEvents,
  njumpUrlForEvent,
  njumpProfileUrlForPubkey,
  nostrProfileUrlForPubkey,
  profileUrlsForPubkey,
  pickRandomProfileUrl,
  njumpProbeUrlForEvent,
  deterministicHex,
} from '../demo/shared/dag-quorum.mjs';

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

test('nostrProfileUrlForPubkey returns a nostr.com link', () => {
  const url = nostrProfileUrlForPubkey('a'.repeat(64));
  assert.ok(url.startsWith('https://nostr.com/'));
  assert.ok(url.includes('npub'));
});

test('njumpProfileUrlForPubkey returns an njump.me link', () => {
  const url = njumpProfileUrlForPubkey('a'.repeat(64));
  assert.ok(url.startsWith('https://njump.me/'));
  assert.ok(url.includes('npub'));
});

test('profileUrlsForPubkey returns both URLs', () => {
  const urls = profileUrlsForPubkey('a'.repeat(64));
  assert.equal(urls.length, 2);
  assert.ok(urls[0].includes('nostr.com'));
  assert.ok(urls[1].includes('njump.me'));
});

test('pickRandomProfileUrl returns one of the two URLs', () => {
  const url = pickRandomProfileUrl('a'.repeat(64));
  const urls = profileUrlsForPubkey('a'.repeat(64));
  assert.ok(urls.includes(url));
});

test('njumpUrlForEvent returns an njump.me nevent link', () => {
  const url = njumpUrlForEvent('f'.repeat(64));
  assert.ok(url.startsWith('https://njump.me/'));
  assert.ok(url.includes('nevent'));
});

test('njumpProbeUrlForEvent includes a cache-busting query param', () => {
  const url = njumpProbeUrlForEvent('f'.repeat(64));
  assert.ok(url.startsWith('https://njump.me/image/'));
  assert.ok(url.includes('?v='));
});

// ---------------------------------------------------------------------------
// Participant profile
// ---------------------------------------------------------------------------

test('createParticipantProfile builds the expected shape', () => {
  const profile = createParticipantProfile({
    name: 'alice',
    displayName: 'Alice',
    about: 'test',
    picture: 'https://example.com/a.png',
    website: 'https://example.com',
    alternateSource: 'https://njump.me/alice',
    profileUrl: 'https://nostr.com/alice',
    quorumId: 'q1',
    quorumEventId: 'e1',
  });

  assert.equal(profile.name, 'alice');
  assert.equal(profile.display_name, 'Alice');
  assert.equal(profile.quorum_id, 'q1');
  assert.equal(profile.quorum_event_id, 'e1');
  assert.equal(profile.profile_url, 'https://nostr.com/alice');
  assert.equal(profile.alternate_source, 'https://njump.me/alice');
});

test('createParticipantProfile defaults quorumEventId to quorumId', () => {
  const profile = createParticipantProfile({
    name: 'bob',
    displayName: 'Bob',
    about: 'test',
    quorumId: 'q1',
  });
  assert.equal(profile.quorum_event_id, 'q1');
});

// ---------------------------------------------------------------------------
// Deterministic hex
// ---------------------------------------------------------------------------

test('deterministicHex produces consistent output for the same input', async () => {
  const a = await deterministicHex('test-input', 10);
  const b = await deterministicHex('test-input', 10);
  assert.equal(a, b);
  assert.equal(a.length, 20); // 10 bytes = 20 hex chars
});

test('deterministicHex produces different output for different inputs', async () => {
  const a = await deterministicHex('input-a');
  const b = await deterministicHex('input-b');
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// createParticipants factory
// ---------------------------------------------------------------------------

test('createParticipants generates deterministic keys from labels', async () => {
  const participants = await createParticipants({
    fedCount: 2,
    participantNames: ['alice', 'bob'],
    participantDisplayNames: ['Alice', 'Bob'],
    participantKeyLabels: ['alice-key', 'bob-key'],
    quorumId: 'q-test',
    siteUrl: 'https://example.com',
  });

  assert.equal(participants.length, 2);
  assert.equal(participants[0].name, 'alice');
  assert.equal(participants[1].name, 'bob');
  assert.ok(participants[0].pk, 'alice should have a pubkey');
  assert.ok(participants[1].pk, 'bob should have a pubkey');
  assert.ok(participants[0].sk, 'alice should have a secret key');
  assert.equal(participants[0].quorumId, 'q-test');
});

test('createParticipants is deterministic across calls with the same labels', async () => {
  const a = await createParticipants({
    fedCount: 1,
    participantNames: ['alice'],
    participantDisplayNames: ['Alice'],
    participantKeyLabels: ['stable-label'],
    quorumId: 'q',
    siteUrl: 'https://example.com',
  });
  const b = await createParticipants({
    fedCount: 1,
    participantNames: ['alice'],
    participantDisplayNames: ['Alice'],
    participantKeyLabels: ['stable-label'],
    quorumId: 'q',
    siteUrl: 'https://example.com',
  });
  assert.equal(a[0].pk, b[0].pk);
  assert.deepEqual(a[0].sk, b[0].sk);
});

// ---------------------------------------------------------------------------
// buildMetadataEvent
// ---------------------------------------------------------------------------

test('buildMetadataEvent returns a kind-0 draft with quorum metadata', () => {
  const author = {
    name: 'alice',
    displayName: 'Alice',
    about: 'test user',
    picture: 'https://example.com/a.png',
    website: 'https://example.com',
    pk: 'a'.repeat(64),
    quorumId: 'q1',
  };

  const draft = buildMetadataEvent(author, 'event-123');

  assert.equal(draft.kind, 0);
  assert.equal(draft.pubkey, author.pk);
  assert.ok(typeof draft.created_at === 'number');
  const content = JSON.parse(draft.content);
  assert.equal(content.name, 'alice');
  assert.ok(content.about.includes('event-123'));
  assert.equal(content.quorum_event_id, 'event-123');
});

test('buildMetadataEvent falls back to author.profile fields', () => {
  const author = {
    name: 'alice',
    pk: 'a'.repeat(64),
    quorumId: 'q1',
    profile: {
      name: 'override-name',
      display_name: 'Override',
      about: 'from profile',
      picture: 'https://example.com/p.png',
      website: 'https://profile.com',
    },
  };

  const draft = buildMetadataEvent(author);
  const content = JSON.parse(draft.content);
  assert.equal(content.name, 'override-name');
  assert.equal(content.display_name, 'Override');
});

// ---------------------------------------------------------------------------
// createNip34SequenceEvents
// ---------------------------------------------------------------------------

test('createNip34SequenceEvents produces repo announcement, state, issue, and PR', async () => {
  const participants = [
    { name: 'm', pk: 'a1'.repeat(32), sk: new Uint8Array(32) },
    { name: 's', pk: 'b2'.repeat(32), sk: new Uint8Array(32) },
    { name: 'i', pk: 'c3'.repeat(32), sk: new Uint8Array(32) },
    { name: 'p', pk: 'd4'.repeat(32), sk: new Uint8Array(32) },
  ];
  const inserted = [];
  const signed = [];

  const repoSequence = await createNip34SequenceEvents({
    participants,
    relays: ['wss://nos.lol'],
    signDraftEvent(author, draft) {
      const event = { ...draft, id: `${draft.kind}:${author.pk.slice(0, 8)}`, pubkey: author.pk };
      signed.push(event);
      return event;
    },
    insertEvent(event) { inserted.push(event); },
    yieldToMainThread() { return Promise.resolve(); },
  });

  assert.ok(repoSequence);
  assert.equal(repoSequence.repoId, 'nostr-dag-demo');
  assert.equal(repoSequence.protocolEvents.length, 4);
  assert.equal(inserted.length, 4);
  assert.equal(signed.length, 4);

  const [announcement, state, issue, pr] = repoSequence.protocolEvents;
  assert.equal(announcement.kind, 30617);
  assert.equal(state.kind, 30618);
  assert.equal(issue.kind, 1621);
  assert.equal(pr.kind, 1618);
});

test('createNip34SequenceEvents passes errors through', async () => {
  await assert.rejects(
    createNip34SequenceEvents({
      participants: [
        { name: 'm', pk: 'a1'.repeat(32), sk: new Uint8Array(32) },
        { name: 's', pk: 'b2'.repeat(32), sk: new Uint8Array(32) },
        { name: 'i', pk: 'c3'.repeat(32), sk: new Uint8Array(32) },
        { name: 'p', pk: 'd4'.repeat(32), sk: new Uint8Array(32) },
      ],
      relays: [],
      signDraftEvent() { throw new Error('sign fail'); },
      insertEvent() {},
      yieldToMainThread() { return Promise.resolve(); },
    }),
    /sign fail/,
  );
});

// ---------------------------------------------------------------------------
// createQuorumSequenceEvents
// ---------------------------------------------------------------------------

test('createQuorumSequenceEvents produces manifest, slices, attestations, and seal', async () => {
  const participants = [
    { name: 'a', pk: 'a'.repeat(64), sk: new Uint8Array(32) },
    { name: 'b', pk: 'b'.repeat(64), sk: new Uint8Array(32) },
    { name: 'c', pk: 'c'.repeat(64), sk: new Uint8Array(32) },
    { name: 'd', pk: 'd'.repeat(64), sk: new Uint8Array(32) },
    { name: 'm', pk: 'm'.repeat(64), sk: new Uint8Array(32) },
  ];
  const repoSequence = {
    repoId: 'test-repo',
    repoRootCommit: 'abc123',
    repoCloneUrl: 'nostr://test',
    protocolEvents: [
      { id: 'announcement-1', kind: 30617 },
      { id: 'state-1', kind: 30618 },
      { id: 'issue-1', kind: 1621 },
      { id: 'pr-1', kind: 1618 },
    ],
  };
  const inserted = [];
  const signed = [];

  const quorum = await createQuorumSequenceEvents({
    repoSequence,
    participants,
    signDraftEvent(author, draft) {
      const event = { ...draft, id: `${draft.kind}:${author.pk.slice(0, 8)}:${draft.created_at}`, pubkey: author.pk };
      signed.push(event);
      return event;
    },
    insertEvent(event) { inserted.push(event); },
    yieldToMainThread() { return Promise.resolve(); },
  });

  assert.ok(quorum.manifestEvent);
  assert.ok(quorum.sliceEvents.length > 0);
  assert.ok(quorum.attestationEvents.length > 0);
  assert.ok(quorum.sealEvent);

  assert.equal(quorum.manifestEvent.kind, 39078);
  assert.equal(quorum.sealEvent.kind, 39081);
  assert.equal(quorum.attestationEvents[0].kind, 39080);

  const totalInserted = 1 + quorum.sliceEvents.length + quorum.attestationEvents.length + 1;
  assert.equal(inserted.length, totalInserted);
});

test('createQuorumSequenceEvents chains slice parents correctly', async () => {
  const participants = [
    { name: 'm', pk: 'a1'.repeat(32), sk: new Uint8Array(32) },
  ];
  const repoSequence = {
    repoId: 'r',
    repoRootCommit: 'abc',
    repoCloneUrl: 'nostr://r',
    protocolEvents: [
      { id: 'a1', kind: 30617 },
      { id: 's1', kind: 30618 },
      { id: 'i1', kind: 1621 },
      { id: 'p1', kind: 1618 },
    ],
  };
  const signed = [];

  const quorum = await createQuorumSequenceEvents({
    repoSequence,
    participants,
    signDraftEvent(author, draft) {
      const event = { ...draft, id: `id-${draft.kind}-${draft.created_at}`, pubkey: author.pk };
      signed.push(event);
      return event;
    },
    insertEvent() {},
    yieldToMainThread() { return Promise.resolve(); },
  });

  // Every slice references the manifest via 'e' tag.
  // The first slice has only the manifest ref; subsequent slices also chain the previous slice.
  const firstSliceETags = quorum.sliceEvents[0].tags.filter((t) => t[0] === 'e').map((t) => t[1]);
  assert.ok(firstSliceETags.includes(quorum.manifestEvent.id), 'first slice should reference manifest');

  if (quorum.sliceEvents.length > 1) {
    const secondSliceETags = quorum.sliceEvents[1].tags.filter((t) => t[0] === 'e').map((t) => t[1]);
    assert.ok(secondSliceETags.includes(quorum.sliceEvents[0].id), 'second slice should reference first slice');
    assert.ok(secondSliceETags.includes(quorum.manifestEvent.id), 'second slice should still reference manifest');
  }
});
