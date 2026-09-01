/**
 * dag-quorum.mjs
 *
 * Orchestration layer for the nostr-dag quorum demo.
 *
 * Builds on the raw protocol primitives in nip34-quorum.mjs and wires them
 * together into the full manifest → slice → attest → seal sequence used by
 * the /dag/ page.
 *
 * All functions are pure and receive their dependencies explicitly so they
 * can be tested in Node without a browser or WASM runtime.
 */

import { finalizeEvent, getPublicKey, neventEncode, npubEncode } from '../vendor/nostr-tools.mjs';
import { getNetworkUnixTime } from './network-time.mjs';
import { stampBridgeRoundTripTag } from './bridge-roundtrip.mjs';
import {
  utf8Bytes,
  sha256Hex,
  packetizePayload,
  repositoryAddress,
  buildRepositoryAnnouncementDraft,
  buildRepositoryStateDraft,
  buildIssueDraft,
  buildPullRequestDraft,
  buildTransferManifestDraft,
  buildTransferSliceDraft,
  buildAttestDraft,
  buildSealDraft,
} from './nip34-quorum.mjs';

// ---------------------------------------------------------------------------
// Participant profiles
// ---------------------------------------------------------------------------

export function createParticipantProfile({
  name,
  displayName,
  about,
  picture,
  website,
  alternateSource,
  profileUrl,
  quorumId,
  quorumEventId = quorumId,
}) {
  return {
    name,
    display_name: displayName,
    about,
    picture,
    website,
    profile_url: profileUrl,
    alternate_source: alternateSource,
    quorum_id: quorumId,
    quorum_event_id: quorumEventId,
  };
}

// ---------------------------------------------------------------------------
// Nostr deep-link helpers
// ---------------------------------------------------------------------------

export function njumpUrlForEvent(eventId) {
  return `https://njump.me/${neventEncode({ id: eventId })}`;
}

export function njumpProfileUrlForPubkey(pubkey) {
  return `https://njump.me/${npubEncode(pubkey)}`;
}

export function nostrProfileUrlForPubkey(pubkey) {
  return `https://nostr.com/${npubEncode(pubkey)}`;
}

export function profileUrlsForPubkey(pubkey) {
  return [nostrProfileUrlForPubkey(pubkey), njumpProfileUrlForPubkey(pubkey)];
}

export function pickRandomProfileUrl(pubkey) {
  const urls = profileUrlsForPubkey(pubkey);
  return Math.random() < 0.8 ? urls[0] : urls[1];
}

export function njumpProbeUrlForEvent(eventId) {
  return `https://njump.me/image/${neventEncode({ id: eventId })}?v=${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Metadata event builder
// ---------------------------------------------------------------------------

export function buildMetadataEvent(author, quorumEventId = author.quorumId, { log = null } = {}) {
  const baseProfile = author.profile || {};
  const profile = createParticipantProfile({
    name: baseProfile.name || author.name,
    displayName: baseProfile.display_name || author.displayName,
    about: `${baseProfile.about || author.about} quorum_event_id: ${quorumEventId}.`,
    picture: baseProfile.picture || author.picture,
    website: baseProfile.website || author.website,
    alternateSource:
      baseProfile.alternate_source ||
      author.profile?.alternate_source ||
      njumpProfileUrlForPubkey(author.pk),
    profileUrl:
      baseProfile.profile_url ||
      author.profile?.profile_url ||
      nostrProfileUrlForPubkey(author.pk),
    quorumId: baseProfile.quorum_id || author.quorumId,
    quorumEventId,
  });

  log?.log(
    'demo',
    `build metadata event for ${author.name} (${author.pk}) quorum_event_id ${quorumEventId}`,
    'info',
    'checking',
  );
  log?.log('demo', `metadata profile:\n${JSON.stringify(profile, null, 2)}`, 'info', 'checking');

  return {
    kind: 0,
    created_at: getNetworkUnixTime(),
    tags: [],
    content: JSON.stringify(profile),
    pubkey: author.pk,
  };
}

// ---------------------------------------------------------------------------
// Deterministic key derivation
// ---------------------------------------------------------------------------

async function sha256Bytes(value) {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return new Uint8Array(digest);
}

export async function deterministicHex(value, bytes = 20) {
  const digest = await sha256Bytes(value);
  return [...digest.slice(0, bytes)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Participant factory
// ---------------------------------------------------------------------------

export async function createParticipants({
  fedCount,
  participantNames,
  participantDisplayNames,
  participantKeyLabels,
  quorumId,
  siteUrl,
  log = null,
}) {
  const participants = await Promise.all(
    Array.from({ length: fedCount }, async (_, i) => {
      const name = participantNames[i] || `participant${i + 1}`;
      const keyLabel = participantKeyLabels[i] || name;
      const sk = await sha256Bytes(keyLabel);
      const pk = getPublicKey(sk);
      const displayName = participantDisplayNames[i] || `Participant ${i + 1}`;
      const profile = createParticipantProfile({
        name,
        displayName,
        about: `Member ${i + 1} of the nostr-dag quorum`,
        picture: `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(name)}`,
        website: siteUrl,
        alternateSource: njumpProfileUrlForPubkey(pk),
        profileUrl: nostrProfileUrlForPubkey(pk),
        quorumId,
      });
      return {
        name,
        displayName,
        profile,
        sk,
        pk,
        quorumId,
        picture: profile.picture,
      };
    }),
  );

  log?.log('demo', `initialized ${participants.length} participants`, 'info', 'available');
  return participants;
}

// ---------------------------------------------------------------------------
// NIP-34 demo sequence: repo announcement → state → issue → pull request
// ---------------------------------------------------------------------------

export async function createNip34SequenceEvents({
  participants,
  relays,
  signDraftEvent,
  insertEvent,
  yieldToMainThread,
  log = null,
}) {
  log?.log('demo', 'create NIP-34 sequence events', 'info', 'checking');
  const [maintainer, stateAuthor, issueAuthor, prAuthor] = participants;
  const createdAt = getNetworkUnixTime();
  const repoId = 'nostr-dag-demo';
  const repoRootCommit = await deterministicHex(`${repoId}:root`);
  const mainCommit = await deterministicHex(`${repoId}:main`);
  const featureCommit = await deterministicHex(`${repoId}:feature`);
  const repoCloneUrl = `nostr://${npubEncode(maintainer.pk)}/${encodeURIComponent(repoId)}`;
  const repoAddressTag = repositoryAddress(maintainer.pk, repoId);

  const repoAnnouncement = signDraftEvent(
    maintainer,
    buildRepositoryAnnouncementDraft({
      pubkey: maintainer.pk,
      createdAt,
      repoId,
      name: 'nostr-dag demo repository',
      description: 'Real NIP-34 repository announcement broadcast by the DAG demo.',
      web: ['https://github.com/RandyMcMillan/nostr-dag'],
      clone: [repoCloneUrl, 'https://github.com/RandyMcMillan/nostr-dag.git'],
      relays: [...relays],
      earliestUniqueCommit: repoRootCommit,
      maintainers: participants.map((p) => p.pk),
      hashtags: ['nostr-dag', 'nip34', 'quorum'],
    }),
  );
  log?.log('demo', `repo announcement event:\n${JSON.stringify(repoAnnouncement, null, 2)}`, 'info', 'checking');
  insertEvent(repoAnnouncement);
  await yieldToMainThread();

  const repoState = signDraftEvent(
    stateAuthor,
    buildRepositoryStateDraft({
      pubkey: stateAuthor.pk,
      createdAt: createdAt + 1,
      repoId,
      refs: [
        ['heads/main', mainCommit],
        ['heads/quorum-demo', featureCommit],
        ['tags/demo-v1', mainCommit],
      ],
      head: 'refs/heads/main',
      parents: [repoAnnouncement.id],
    }),
  );
  log?.log('demo', `repo state event:\n${JSON.stringify(repoState, null, 2)}`, 'info', 'checking');
  insertEvent(repoState);
  await yieldToMainThread();

  const issue = signDraftEvent(
    issueAuthor,
    buildIssueDraft({
      pubkey: issueAuthor.pk,
      createdAt: createdAt + 2,
      repoAddress: repoAddressTag,
      repositoryOwner: maintainer.pk,
      subject: 'Broadcast quorum-attested NIP-34 events',
      labels: ['demo', 'quorum'],
      content: 'Replace fake demo events with a real NIP-34 repository sequence and quorum attestations.',
      parents: [repoState.id],
    }),
  );
  log?.log('demo', `issue event:\n${JSON.stringify(issue, null, 2)}`, 'info', 'checking');
  insertEvent(issue);
  await yieldToMainThread();

  const pullRequest = signDraftEvent(
    prAuthor,
    buildPullRequestDraft({
      pubkey: prAuthor.pk,
      createdAt: createdAt + 3,
      repoAddress: repoAddressTag,
      repositoryOwner: maintainer.pk,
      repoRootCommit,
      subject: 'Wire the demo to real NIP-34 quorum events',
      labels: ['demo', 'quorum', 'nip34'],
      headCommit: featureCommit,
      clone: [repoCloneUrl],
      branchName: 'quorum-demo',
      mergeBase: mainCommit,
      content: 'This PR event advertises the demo branch carrying the quorum-attested NIP-34 flow.',
      parents: [issue.id],
    }),
  );
  log?.log('demo', `pull request event:\n${JSON.stringify(pullRequest, null, 2)}`, 'info', 'checking');
  insertEvent(pullRequest);

  const protocolEvents = [repoAnnouncement, repoState, issue, pullRequest];
  log?.log(
    'demo',
    `NIP-34 sequence ids: ${protocolEvents.map((event) => `${event.kind}:${event.id}`).join(', ')}`,
    'info',
    'available',
  );

  return {
    repoId,
    repoRootCommit,
    repoCloneUrl,
    repoAddressTag,
    protocolEvents,
  };
}

// ---------------------------------------------------------------------------
// Quorum sequence: manifest → slice → attest → seal
// ---------------------------------------------------------------------------

export async function createQuorumSequenceEvents({
  repoSequence,
  participants,
  signDraftEvent,
  insertEvent,
  yieldToMainThread,
  log = null,
}) {
  log?.log('demo', 'create quorum sequence events', 'info', 'checking');
  const [repoAnnouncement, repoState, issue, pullRequest] = repoSequence.protocolEvents;
  const manifestAuthor = participants[participants.length - 1];
  const createdAt = getNetworkUnixTime();
  const payloadJson = JSON.stringify({
    repository: {
      repo_id: repoSequence.repoId,
      clone_url: repoSequence.repoCloneUrl,
      earliest_unique_commit: repoSequence.repoRootCommit,
    },
    events: [repoAnnouncement, repoState, issue, pullRequest],
  });
  const payloadBytes = utf8Bytes(payloadJson);
  log?.log('demo', `quorum payload json:\n${payloadJson}`, 'info', 'checking');
  const rootId = `nip34-quorum-${repoAnnouncement.id}`;
  const digest = await sha256Hex(payloadBytes);
  const sliceSize = Math.max(96, Math.ceil(payloadBytes.length / 3));
  const slices = packetizePayload(rootId, payloadBytes, sliceSize);

  const manifestEvent = signDraftEvent(
    manifestAuthor,
    buildTransferManifestDraft({
      pubkey: manifestAuthor.pk,
      createdAt,
      rootId,
      totalBytes: payloadBytes.length,
      totalSlices: slices.length,
      parents: [pullRequest.id],
    }),
  );
  log?.log('demo', `manifest event:\n${JSON.stringify(manifestEvent, null, 2)}`, 'info', 'checking');
  insertEvent(manifestEvent);
  await yieldToMainThread();
  log?.log('demo', `quorum manifest ${manifestEvent.id} with ${slices.length} slices pending`, 'info', 'checking');

  const sliceEvents = [];
  for (let i = 0; i < slices.length; i += 1) {
    const sliceEvent = signDraftEvent(
      manifestAuthor,
      buildTransferSliceDraft({
        pubkey: manifestAuthor.pk,
        createdAt: createdAt + 1 + i,
        manifestId: manifestEvent.id,
        rootId,
        seq: slices[i].seq,
        totalSlices: slices[i].totalSlices,
        data: slices[i].data,
        parents: i === 0 ? [] : [sliceEvents[i - 1].id],
      }),
    );
    sliceEvents.push(sliceEvent);
    log?.log('demo', `slice event ${i + 1}/${slices.length}:\n${JSON.stringify(sliceEvent, null, 2)}`, 'info', 'checking');
    insertEvent(sliceEvent);
    log?.log('demo', `quorum slice ${i + 1}/${slices.length} ${sliceEvent.id}`, 'info', 'checking');
    if (i % 2 === 1) await yieldToMainThread();
  }

  const attesters = participants.slice(0, 4);
  const attestationEvents = [];
  for (let i = 0; i < attesters.length; i += 1) {
    const attestation = signDraftEvent(
      attesters[i],
      buildAttestDraft({
        pubkey: attesters[i].pk,
        createdAt: createdAt + slices.length + 1 + i,
        rootId,
        sha256: digest,
        manifestId: manifestEvent.id,
        sliceIds: sliceEvents.map((event) => event.id),
        parents: [],
      }),
    );
    attestationEvents.push(attestation);
    log?.log('demo', `attestation event ${i + 1}/${attesters.length}:\n${JSON.stringify(attestation, null, 2)}`, 'info', 'checking');
    insertEvent(attestation);
    log?.log('demo', `quorum attest ${i + 1}/${attesters.length} ${attestation.id} by ${attesters[i].name}`, 'info', 'checking');
    if (i % 2 === 1) await yieldToMainThread();
  }

  const sealEvent = signDraftEvent(
    manifestAuthor,
    buildSealDraft({
      pubkey: manifestAuthor.pk,
      createdAt: createdAt + slices.length + attestationEvents.length + 2,
      rootId,
      sha256: digest,
      attestIds: attestationEvents.map((event) => event.id),
      parents: [],
    }),
  );
  log?.log('demo', `seal event:\n${JSON.stringify(sealEvent, null, 2)}`, 'info', 'checking');
  insertEvent(sealEvent);
  log?.log('demo', `quorum seal ${sealEvent.id} digest ${digest}`, 'info', 'available');

  return {
    manifestEvent,
    sliceEvents,
    attestationEvents,
    sealEvent,
  };
}
