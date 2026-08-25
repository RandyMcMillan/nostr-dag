export class Nip34RemoteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Nip34RemoteError';
  }
}

export function parseNostrCloneUrl(input) {
  if (typeof input !== 'string' || !input.startsWith('nostr://')) {
    throw new Nip34RemoteError('expected nostr:// URL');
  }

  const rest = input.slice('nostr://'.length);
  if (!rest) {
    throw new Nip34RemoteError('nostr:// URL is missing authority');
  }
  if (rest.includes('?') || rest.includes('#')) {
    throw new Nip34RemoteError('nostr:// URL has invalid path segments');
  }

  const parts = rest.split('/');
  const ownerOrNaddr = parts.shift();
  if (!ownerOrNaddr) {
    throw new Nip34RemoteError('nostr:// URL is missing authority');
  }

  if (parts.length === 0) {
    return {
      kind: 'announcement',
      naddr: ownerOrNaddr,
      normalized: `nostr://${ownerOrNaddr}`,
    };
  }

  if (parts.length === 1) {
    const [identifierEnc] = parts;
    if (!identifierEnc) {
      throw new Nip34RemoteError('nostr:// coordinate is missing identifier');
    }
    const identifier = percentDecode(identifierEnc);
    return {
      kind: 'coordinate',
      owner: ownerOrNaddr,
      relayHint: null,
      identifier,
      normalized: `nostr://${ownerOrNaddr}/${percentEncode(identifier)}`,
    };
  }

  if (parts.length === 2) {
    const [relayEnc, identifierEnc] = parts;
    if (!relayEnc || !identifierEnc) {
      throw new Nip34RemoteError('nostr:// coordinate is missing identifier');
    }
    const relayHint = percentDecode(relayEnc);
    const identifier = percentDecode(identifierEnc);
    return {
      kind: 'coordinate',
      owner: ownerOrNaddr,
      relayHint,
      identifier,
      normalized: `nostr://${ownerOrNaddr}/${percentEncode(relayHint)}/${percentEncode(identifier)}`,
    };
  }

  throw new Nip34RemoteError('nostr:// URL has invalid path segments');
}

export function normalizeNostrCloneUrl(input) {
  return parseNostrCloneUrl(input).normalized;
}

export function gitRemoteHelperUrl(input) {
  return `nostr::${normalizeNostrCloneUrl(input)}`;
}

function percentDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Nip34RemoteError('nostr:// URL has invalid percent encoding');
  }
}

function percentEncode(value) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
