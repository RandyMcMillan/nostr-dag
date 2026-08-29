/**
 * Minimal git-bundle → isomorphic-git HTTP transport.
 *
 * Git bundle format (v2/v3):
 *   # v2 git bundle
 *   <oid> <ref-name>
 *   <oid> HEAD
 *
 *   PACK...
 *
 * This module parses a bundle already stored in LightningFS and exposes a
 * custom `http` client compatible with isomorphic-git's `GitHttpRequest` /
 * `GitHttpResponse` interface.
 */

/**
 * @param {object} options
 * @param {import('@isomorphic-git/lightning-fs').default} options.fs
 * @param {string} options.bundlePath - absolute LightningFS path to the bundle
 */
export function createBundleHttpClient({ fs, bundlePath }) {
  return {
    /**
     * @param {import('isomorphic-git/http/web').GitHttpRequest} args
     * @returns {Promise<import('isomorphic-git/http/web').GitHttpResponse>}
     */
    async request(args) {
      const url = new URL(args.url);
      const pathname = url.pathname;

      if (args.method === 'GET' && pathname.endsWith('/info/refs')) {
        const service = url.searchParams.get('service');
        if (service === 'git-upload-pack') {
          const { refs } = await parseBundleHeader(fs, bundlePath);
          const body = encodeRefsAdvertisement(refs);
          return {
            url: args.url,
            method: args.method,
            statusCode: 200,
            statusMessage: 'OK',
            headers: {
              'content-type': `application/x-${service}-advertisement`,
              'content-length': String(body.byteLength),
            },
            body: (async function* () { yield body; })(),
          };
        }
      }

      if (args.method === 'POST' && pathname.endsWith('/git-upload-pack')) {
        const packOffset = await findPackOffset(fs, bundlePath);
        const packData = await readFileSlice(fs, bundlePath, packOffset);
        const body = encodeUploadPackResponse(packData);
        return {
          url: args.url,
          method: args.method,
          statusCode: 200,
          statusMessage: 'OK',
          headers: {
            'content-type': 'application/x-git-upload-pack-result',
            'content-length': String(body.byteLength),
          },
          body: (async function* () { yield body; })(),
        };
      }

      return {
        url: args.url,
        method: args.method,
        statusCode: 404,
        statusMessage: 'Not Found',
        headers: {},
        body: (async function* () {})(),
      };
    },
  };
}

/**
 * Parse the bundle header and return refs + byte offset where packfile begins.
 * @param {import('@isomorphic-git/lightning-fs').default} fs
 * @param {string} bundlePath
 * @returns {Promise<{ refs: Array<{ name: string, oid: string }>, packOffset: number }>}
 */
async function parseBundleHeader(fs, bundlePath) {
  const data = await fs.promises.readFile(bundlePath);
  const text = new TextDecoder('utf-8').decode(data);
  const lines = text.split('\n');
  const refs = [];
  let packOffset = 0;
  let byteOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineBytes = new TextEncoder().encode(line + '\n').length;

    // Version header
    if (line.startsWith('# v') && line.includes('git bundle')) {
      byteOffset += lineBytes;
      continue;
    }
    // Prerequisite lines (v3) — skip them
    if (line.startsWith('- ')) {
      byteOffset += lineBytes;
      continue;
    }
    // Blank line separates header from packfile
    if (line.trim() === '') {
      byteOffset += lineBytes;
      continue;
    }
    // Ref line: <oid> <ref-name>
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx > 0) {
      const oid = line.slice(0, spaceIdx).trim();
      const name = line.slice(spaceIdx + 1).trim();
      if (oid.length === 40 && /^[0-9a-f]+$/.test(oid)) {
        refs.push({ name, oid });
        byteOffset += lineBytes;
        continue;
      }
    }
    // If we see PACK, the packfile starts here
    if (line.startsWith('PACK')) {
      packOffset = byteOffset;
      break;
    }
    // Otherwise assume packfile starts at current offset
    packOffset = byteOffset;
    break;
  }

  return { refs, packOffset };
}

async function findPackOffset(fs, bundlePath) {
  const { packOffset } = await parseBundleHeader(fs, bundlePath);
  return packOffset;
}

async function readFileSlice(fs, bundlePath, offset) {
  const data = await fs.promises.readFile(bundlePath);
  return data.slice(offset);
}

function encodeRefsAdvertisement(refs) {
  const service = 'git-upload-pack';
  let pkt = pktLine(`# service=${service}\n`);
  pkt += pktLine('');
  for (const ref of refs) {
    pkt += pktLine(`${ref.oid} ${ref.name}\n`);
  }
  pkt += pktLine('');
  return new TextEncoder().encode(pkt);
}

function encodeUploadPackResponse(packData) {
  // NAK + flush, then packfile in sideband channel 1
  let pkt = pktLine('NAK\n');
  pkt += pktLine('');
  const header = new TextEncoder().encode(pkt);
  // sideband-64k: channel 1 = data, each packet max 65520 bytes of payload
  const MAX_PAYLOAD = 65520;
  const chunks = [];
  chunks.push(header);
  let offset = 0;
  while (offset < packData.byteLength) {
    const end = Math.min(offset + MAX_PAYLOAD, packData.byteLength);
    const payload = packData.slice(offset, end);
    const packet = encodeSidebandPacket(1, payload);
    chunks.push(packet);
    offset = end;
  }
  chunks.push(pktLine('')); // flush
  const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return result;
}

function pktLine(text) {
  if (text === '') {
    return '0000';
  }
  const bytes = new TextEncoder().encode(text);
  const len = (bytes.byteLength + 4).toString(16).padStart(4, '0');
  return len + text;
}

function encodeSidebandPacket(channel, payload) {
  const header = new Uint8Array(1);
  header[0] = channel;
  const totalLen = 4 + 1 + payload.byteLength;
  const lenHex = totalLen.toString(16).padStart(4, '0');
  const lenBytes = new TextEncoder().encode(lenHex);
  const result = new Uint8Array(totalLen);
  result.set(lenBytes, 0);
  result.set(header, 4);
  result.set(payload, 5);
  return result;
}
