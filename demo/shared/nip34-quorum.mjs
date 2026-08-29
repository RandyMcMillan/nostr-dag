export const NIP34_REPOSITORY_ANNOUNCEMENT_KIND = 30617;
export const NIP34_REPOSITORY_STATE_KIND = 30618;
export const NIP34_PATCH_KIND = 1617;
export const NIP34_PULL_REQUEST_KIND = 1618;
export const NIP34_ISSUE_KIND = 1621;
export const NIP34_STATUS_OPEN_KIND = 1630;
export const PIP_TRANSFER_MANIFEST_KIND = 39078;
export const PIP_TRANSFER_SLICE_KIND = 39079;
export const PIP_ATTEST_KIND = 39080;
export const PIP_SEAL_KIND = 39081;
export const PIP_JOIN_KIND = 39082;

const PIP_PROTOCOL = 'nostr-dag-transfer';
const PIP_VERSION = 1;

function withParents(tags, parents = []) {
  return [...tags, ...parents.map((id) => ['e', id])];
}

function stringifyProtocolEvent(payload) {
  return JSON.stringify(payload);
}

export function repositoryAddress(pubkey, repoId) {
  return `${NIP34_REPOSITORY_ANNOUNCEMENT_KIND}:${pubkey}:${repoId}`;
}

export function utf8Bytes(value) {
  return new TextEncoder().encode(value);
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function packetizePayload(rootId, payload, maxSliceBytes) {
  const chunkSize = Math.max(1, maxSliceBytes);
  const totalSlices = Math.max(1, Math.ceil(payload.length / chunkSize));
  if (!payload.length) {
    return [{ rootId, seq: 0, totalSlices, data: [] }];
  }

  const slices = [];
  for (let seq = 0; seq < totalSlices; seq += 1) {
    const start = seq * chunkSize;
    const end = Math.min(start + chunkSize, payload.length);
    slices.push({
      rootId,
      seq,
      totalSlices,
      data: [...payload.slice(start, end)],
    });
  }
  return slices;
}

export function buildRepositoryAnnouncementDraft({
  pubkey,
  createdAt,
  repoId,
  name,
  description = '',
  web = [],
  clone = [],
  relays = [],
  earliestUniqueCommit,
  maintainers = [],
  hashtags = [],
  parents = [],
}) {
  const tags = withParents([
    ['d', repoId],
    ...(name ? [['name', name]] : []),
    ...(description ? [['description', description]] : []),
    ...web.map((url) => ['web', url]),
    ...clone.map((url) => ['clone', url]),
    ...(relays.length ? [['relays', ...relays]] : []),
    ...(earliestUniqueCommit ? [['r', earliestUniqueCommit, 'euc']] : []),
    ...(maintainers.length ? [['maintainers', ...maintainers]] : []),
    ...hashtags.map((tag) => ['t', tag]),
  ], parents);

  return {
    kind: NIP34_REPOSITORY_ANNOUNCEMENT_KIND,
    created_at: createdAt,
    tags,
    content: '',
    pubkey,
  };
}

export function buildRepositoryStateDraft({
  pubkey,
  createdAt,
  repoId,
  refs = [],
  head,
  parents = [],
}) {
  const tags = withParents([
    ['d', repoId],
    ...refs.map(([name, commit]) => [`refs/${name}`, commit]),
    ...(head ? [['HEAD', `ref: ${head}`]] : []),
  ], parents);

  return {
    kind: NIP34_REPOSITORY_STATE_KIND,
    created_at: createdAt,
    tags,
    content: '',
    pubkey,
  };
}

export function buildIssueDraft({
  pubkey,
  createdAt,
  repoAddress: address,
  repositoryOwner,
  subject,
  labels = [],
  content,
  parents = [],
}) {
  const tags = withParents([
    ['a', address],
    ...(repositoryOwner ? [['p', repositoryOwner]] : []),
    ...(subject ? [['subject', subject]] : []),
    ...labels.map((label) => ['t', label]),
  ], parents);

  return {
    kind: NIP34_ISSUE_KIND,
    created_at: createdAt,
    tags,
    content,
    pubkey,
  };
}

export function buildPullRequestDraft({
  pubkey,
  createdAt,
  repoAddress: address,
  repositoryOwner,
  repoRootCommit,
  subject,
  labels = [],
  headCommit,
  clone = [],
  branchName,
  mergeBase,
  content,
  parents = [],
}) {
  const tags = withParents([
    ['a', address],
    ...(repoRootCommit ? [['r', repoRootCommit]] : []),
    ...(repositoryOwner ? [['p', repositoryOwner]] : []),
    ...(subject ? [['subject', subject]] : []),
    ...labels.map((label) => ['t', label]),
    ...(headCommit ? [['c', headCommit]] : []),
    ...clone.map((url) => ['clone', url]),
    ...(branchName ? [['branch-name', branchName]] : []),
    ...(mergeBase ? [['merge-base', mergeBase]] : []),
  ], parents);

  return {
    kind: NIP34_PULL_REQUEST_KIND,
    created_at: createdAt,
    tags,
    content,
    pubkey,
  };
}

export function buildTransferManifestDraft({
  pubkey,
  createdAt,
  rootId,
  totalBytes,
  totalSlices,
  parents = [],
}) {
  return {
    kind: PIP_TRANSFER_MANIFEST_KIND,
    created_at: createdAt,
    tags: withParents([
      ['t', 'nostr-dag'],
      ['t', 'nip-pip'],
      ['t', 'transfer'],
    ], parents),
    content: stringifyProtocolEvent({
      protocol: PIP_PROTOCOL,
      version: PIP_VERSION,
      type: 'manifest',
      root_id: rootId,
      total_bytes: totalBytes,
      total_slices: totalSlices,
    }),
    pubkey,
  };
}

export function buildTransferSliceDraft({
  pubkey,
  createdAt,
  manifestId,
  rootId,
  seq,
  totalSlices,
  data,
  parents = [],
}) {
  return {
    kind: PIP_TRANSFER_SLICE_KIND,
    created_at: createdAt,
    tags: withParents([
      ['t', 'nostr-dag'],
      ['t', 'nip-pip'],
      ['t', 'transfer'],
      ['e', manifestId],
    ], parents),
    content: stringifyProtocolEvent({
      protocol: PIP_PROTOCOL,
      version: PIP_VERSION,
      type: 'slice',
      root_id: rootId,
      seq,
      total_slices: totalSlices,
      data,
    }),
    pubkey,
  };
}

export function buildAttestDraft({
  pubkey,
  createdAt,
  rootId,
  sha256,
  manifestId,
  sliceIds = [],
  parents = [],
}) {
  return {
    kind: PIP_ATTEST_KIND,
    created_at: createdAt,
    tags: withParents([
      ['t', 'nostr-dag'],
      ['t', 'nip-pip'],
      ['t', 'transfer'],
      ['e', manifestId],
      ...sliceIds.map((id) => ['e', id]),
    ], parents),
    content: stringifyProtocolEvent({
      protocol: PIP_PROTOCOL,
      version: PIP_VERSION,
      type: 'attest',
      root_id: rootId,
      sha256,
      manifest_id: manifestId,
    }),
    pubkey,
  };
}

export function buildSealDraft({
  pubkey,
  createdAt,
  rootId,
  sha256,
  attestIds = [],
  parents = [],
}) {
  return {
    kind: PIP_SEAL_KIND,
    created_at: createdAt,
    tags: withParents([
      ['t', 'nostr-dag'],
      ['t', 'nip-pip'],
      ['t', 'transfer'],
      ...attestIds.map((id) => ['e', id]),
    ], parents),
    content: stringifyProtocolEvent({
      protocol: PIP_PROTOCOL,
      version: PIP_VERSION,
      type: 'seal',
      root_id: rootId,
      sha256,
      attest_ids: attestIds,
    }),
    pubkey,
  };
}

// ---------------------------------------------------------------------------
// Parse and reconstruct transfer events
// ---------------------------------------------------------------------------

export function parseTransferEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.kind !== PIP_TRANSFER_MANIFEST_KIND && event.kind !== PIP_TRANSFER_SLICE_KIND) return null;
  try {
    const content = JSON.parse(event.content);
    if (content.protocol !== PIP_PROTOCOL || content.version !== PIP_VERSION) return null;
    if (content.type === 'manifest') {
      return {
        kind: 'manifest',
        rootId: content.root || content.root_id,
        sha256: content.sha256,
        size: content.size ?? content.total_bytes,
        packets: content.packets ?? content.total_slices,
        depth: content.depth,
        mtu: content.mtu,
        encoding: content.encoding,
        path: content.path || '',
        eventId: event.id,
        pubkey: event.pubkey,
      };
    }
    if (content.type === 'slice') {
      return {
        kind: 'slice',
        id: content.id,
        rootId: content.root_id || content.rootId,
        seqNum: content.header?.seq_num ?? content.seq,
        totalPackets: content.header?.total_packets ?? content.total_slices,
        data: content.data,
        isParity: content.is_parity,
        eventId: event.id,
        parentIds: (event.tags || [])
          .filter((t) => Array.isArray(t) && t[0] === 'e' && t[1])
          .map((t) => t[1]),
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function reconstructPayload(manifest, slices) {
  if (!manifest || !Array.isArray(slices)) return null;
  const sorted = [...slices].sort((a, b) => (a.seqNum ?? 0) - (b.seqNum ?? 0));
  const totalLength = sorted.reduce((sum, s) => sum + (s.data?.length ?? 0), 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const slice of sorted) {
    const data = new Uint8Array(slice.data);
    result.set(data, offset);
    offset += data.length;
  }
  return result;
}
