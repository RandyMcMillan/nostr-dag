export class Nip34RemoteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Nip34RemoteError';
  }
}

export function parseNostrCloneUrl(input) {
  return parseCloneUrlWithScheme(input, 'nostr://');
}

export function parseP2pCloneUrl(input) {
  return parseCloneUrlWithScheme(input, 'p2p://');
}

function parseCloneUrlWithScheme(input, scheme) {
  if (typeof input !== 'string' || !input.startsWith(scheme)) {
    throw new Nip34RemoteError('expected nostr:// URL');
  }

  const rest = input.slice(scheme.length);
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
      normalized: `${scheme}${ownerOrNaddr}`,
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
      normalized: `${scheme}${ownerOrNaddr}/${percentEncode(identifier)}`,
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
      normalized: `${scheme}${ownerOrNaddr}/${percentEncode(relayHint)}/${percentEncode(identifier)}`,
    };
  }

  throw new Nip34RemoteError('nostr:// URL has invalid path segments');
}

export function normalizeNostrCloneUrl(input) {
  return parseNostrCloneUrl(input).normalized;
}

export function normalizeP2pCloneUrl(input) {
  return parseP2pCloneUrl(input).normalized;
}

export function gitRemoteHelperUrl(input) {
  return `nostr::${normalizeNostrCloneUrl(input)}`;
}

export function nostrToP2pCloneUrl(input) {
  const parsed = parseNostrCloneUrl(input);
  return `p2p://${parsed.normalized.slice('nostr://'.length)}`;
}

export function p2pToNostrCloneUrl(input) {
  const parsed = parseP2pCloneUrl(input);
  return `nostr://${parsed.normalized.slice('p2p://'.length)}`;
}

export function gitRemoteTransportUrl(input) {
  if (typeof input !== 'string') {
    throw new Nip34RemoteError('unsupported remote URL scheme');
  }
  if (input.startsWith('nostr://')) return `nostr::${normalizeNostrCloneUrl(input)}`;
  if (input.startsWith('p2p://')) return `p2p::${normalizeP2pCloneUrl(input)}`;
  if (
    input.startsWith('https://') ||
    input.startsWith('http://') ||
    input.startsWith('ssh://') ||
    input.startsWith('git@')
  ) {
    return input;
  }
  throw new Nip34RemoteError('unsupported remote URL scheme');
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
