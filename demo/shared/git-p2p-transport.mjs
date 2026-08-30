import { decodeBridgeMessage } from './bridge-protocol.mjs';
import { parseTransferEvent, reconstructPayload } from './nip34-quorum.mjs';
import { SimplePool, generateSecretKey, finalizeEvent, getPublicKey } from '../vendor/nostr-tools.mjs';

const TOPIC = 'nostr-dag-bridge';
const PIP_REQUEST_KIND = 39077;
const PIP_MANIFEST_KIND = 39078;
const PIP_SLICE_KIND = 39079;

const DEFAULT_RELAYS = [
  'wss://nos.lol',
  'wss://relay.nostr.com',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://nostr.wine',
  'wss://top.testrelay.top',
  'wss://relay.pocketnostr.com',
  'wss://basspistol.org',
  'wss://relay.ngit.dev',
];

/**
 * Browser-side git transport over libp2p gossipsub and Nostr relays.
 *
 * Listens for NIP-PIP transfer manifests (kind 39078) and slices (kind 39079)
 * on both the `nostr-dag-bridge` gossipsub topic and on public Nostr relays.
 * Indexes them by repo URL and reconstructs git bundle payloads.
 *
 * When `relays` is provided (e.g. for GH Pages where mixed-content blocks
 * direct WebSocket dial), the relay path is used for both requesting and
 * receiving bundles.
 */
export class GitP2PTransport {
  constructor({ node, relays, onLog }) {
    this.node = node;
    this.onLog = onLog || (() => {});
    /** @type {Map<string, object>} repoUrl -> manifest */
    this.manifests = new Map();
    /** @type {Map<string, object[]>} manifestEventId -> slices */
    this.slices = new Map();
    /** @type {Map<string, {resolve, reject, timer, manifest, repoUrl}>} */
    this.pendingRequests = new Map();
    this.started = false;

    // Relay support for GH Pages fallback.
    this.relayPool = null;
    this.relaySubs = [];
    this.nostrKeys = null;
    this.relays = relays;
  }

  start() {
    if (this.started) return;
    this.started = true;

    // Gossipsub listener (local mesh).
    if (this.node) {
      try {
        this.node.services.pubsub.subscribe(TOPIC);
      } catch (e) {
        this.onLog('warn', `git-p2p subscribe failed: ${e.message}`);
      }
      this.node.services.pubsub.addEventListener('message', (event) => {
        this.handleMessage(event);
      });
    }

    // Relay listener (for GH Pages mixed-content fallback).
    this.startRelayListener();

    this.onLog('info', 'git-p2p transport started');
  }

  startRelayListener() {
    if (!this.relays || this.relays.length === 0) return;
    try {
      this.relayPool = new SimplePool();
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);
      this.nostrKeys = { sk, pk };
      const filter = {
        kinds: [PIP_MANIFEST_KIND, PIP_SLICE_KIND],
        limit: 0,
      };
      const sub = this.relayPool.subscribeMany(this.relays, filter, {
        onevent: (event) => {
          this.handleNostrEvent(event);
        },
        oneose: () => {
          this.onLog('trace', 'git-p2p relay EOSE');
        },
      });
      this.relaySubs = [sub];
      this.onLog('info', `git-p2p relay listener started on ${this.relays.length} relays`);
    } catch (e) {
      this.onLog('warn', `git-p2p relay listener failed: ${e.message}`);
    }
  }

  handleMessage(event) {
    const data = event?.detail?.data;
    if (!data) return;
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const envelope = decodeBridgeMessage(text);
    if (!envelope) return;
    const eventObj = envelope.event;
    if (!eventObj) return;
    this.processTransferEvent(eventObj);
  }

  handleNostrEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.kind !== PIP_MANIFEST_KIND && event.kind !== PIP_SLICE_KIND) return;
    this.processTransferEvent(event);
  }

  processTransferEvent(eventObj) {
    const parsed = parseTransferEvent(eventObj);
    if (!parsed) return;

    if (parsed.kind === 'manifest') {
      if (parsed.path) {
        this.manifests.set(parsed.path, parsed);
        if (!this.slices.has(parsed.eventId)) {
          this.slices.set(parsed.eventId, []);
        }
        this.onLog(
          'debug',
          `git-p2p manifest repo=${parsed.path} bytes=${parsed.size} packets=${parsed.packets}`,
        );
        const pending = this.pendingRequests.get(parsed.path);
        if (pending && !pending.manifest) {
          pending.manifest = parsed;
          this.checkComplete(pending);
        }
      }
    } else if (parsed.kind === 'slice') {
      const manifestId = parsed.parentIds?.[0];
      if (!manifestId) return;

      let slices = this.slices.get(manifestId);
      if (!slices) {
        slices = [];
        this.slices.set(manifestId, slices);
      }
      if (!slices.some((s) => s.eventId === parsed.eventId)) {
        slices.push(parsed);
        this.onLog(
          'trace',
          `git-p2p slice manifest=${manifestId} seq=${parsed.seqNum} total=${parsed.totalPackets}`,
        );
        for (const [, pending] of this.pendingRequests) {
          if (pending.manifest?.eventId === manifestId) {
            this.checkComplete(pending);
          }
        }
      }
    }
  }

  checkComplete(pending) {
    if (!pending.manifest) return;
    const slices = this.slices.get(pending.manifest.eventId) || [];
    if (slices.length >= pending.manifest.packets) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(pending.repoUrl);
      const payload = reconstructPayload(pending.manifest, slices);
      if (payload) {
        this.onLog('info', `git-p2p reconstructed repo=${pending.repoUrl} bytes=${payload.length}`);
        pending.resolve(payload);
      } else {
        pending.reject(new Error('git-p2p reconstruct failed'));
      }
    }
  }

  hasRepo(repoUrl) {
    return this.manifests.has(repoUrl);
  }

  /**
   * Request a git bundle for `repoUrl` from libp2p peers and/or Nostr relays.
   *
   * If the bundle is already cached locally, resolves immediately.  Otherwise
   * publishes a PIP on-demand request (kind 39077) to Nostr relays and a
   * gossipsub request envelope on the libp2p topic.  Native peers that hold
   * the bundle respond by re-publishing the manifest + slices, which this
   * transport listens for and reconstructs.
   *
   * @param {string} repoUrl
   * @param {number} timeoutMs — default 30000
   * @returns {Promise<Uint8Array>}
   */
  requestBundle(repoUrl, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const manifest = this.manifests.get(repoUrl);
      if (manifest) {
        const slices = this.slices.get(manifest.eventId) || [];
        if (slices.length >= manifest.packets) {
          const payload = reconstructPayload(manifest, slices);
          if (payload) {
            this.onLog('info', `git-p2p cache hit repo=${repoUrl}`);
            resolve(payload);
            return;
          }
        }
      }

      const timer = setTimeout(() => {
        this.pendingRequests.delete(repoUrl);
        reject(new Error(`git-p2p timeout waiting for ${repoUrl}`));
      }, timeoutMs);

      this.pendingRequests.set(repoUrl, {
        repoUrl,
        resolve,
        reject,
        timer,
        manifest: null,
      });
      this.onLog('debug', `git-p2p requesting repo=${repoUrl} timeout=${timeoutMs}ms`);

      // Publish a kind 39077 Nostr event to relays so native peers can respond
      // even when the browser cannot dial them directly (GH Pages mixed-content).
      if (this.relayPool && this.nostrKeys) {
        try {
          const eventTemplate = {
            kind: PIP_REQUEST_KIND,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['t', 'nostr-dag'], ['t', 'nip-pip']],
            content: JSON.stringify({ path: repoUrl }),
          };
          const signedEvent = finalizeEvent(eventTemplate, this.nostrKeys.sk);
          this.relayPool.publish(this.relays, signedEvent);
          this.onLog('debug', `git-p2p relay request published repo=${repoUrl}`);
        } catch (e) {
          this.onLog('trace', `git-p2p relay request failed: ${e.message}`);
        }
      }

      // Also publish a PIP on-demand request envelope on gossipsub (local mesh).
      if (this.node) {
        try {
          const req = JSON.stringify({
            protocol: 'nostr-dag-bridge',
            version: 1,
            direction: 'request',
            path: repoUrl,
          });
          const data = new TextEncoder().encode(req);
          this.node.services.pubsub.publish(TOPIC, data);
          this.onLog('debug', `git-p2p gossip request published repo=${repoUrl}`);
        } catch (e) {
          this.onLog('trace', `git-p2p gossip request failed: ${e.message}`);
        }
      }
    });
  }

  /**
   * Returns an isomorphic-git-compatible HTTP client that attempts libp2p
   * first, then falls back to the real HTTP client.
   */
  getHttpClient(realHttp) {
    const transport = this;
    return {
      async request({ url, method, headers, body, onProgress }) {
        const isGitRequest = url.includes('/info/refs') || url.includes('/git-upload-pack') || url.includes('/git-receive-pack');
        if (isGitRequest && transport.hasRepo(url)) {
          try {
            transport.onLog('info', `git-p2p intercepting ${method || 'GET'} ${url}`);
            const bundle = await transport.requestBundle(url, 15000);
            transport.onLog('warn', `git-p2p bundle received but smart-HTTP serving not yet implemented; falling back to HTTP`);
          } catch (e) {
            transport.onLog('debug', `git-p2p intercept failed: ${e.message}`);
          }
        }
        return realHttp.request({ url, method, headers, body, onProgress });
      },
    };
  }

  stop() {
    this.started = false;
    if (this.relayPool) {
      this.relaySubs.forEach((sub) => {
        try { sub.close(); } catch {}
      });
      this.relayPool.close(this.relays);
      this.relayPool = null;
    }
  }
}

export function createGitP2PTransport(options) {
  const transport = new GitP2PTransport(options);
  transport.start();
  return transport;
}

export { DEFAULT_RELAYS };
