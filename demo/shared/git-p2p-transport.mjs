import { decodeBridgeMessage } from './bridge-protocol.mjs';
import { parseTransferEvent, reconstructPayload } from './nip34-quorum.mjs';

const TOPIC = 'nostr-dag-bridge';

/**
 * Browser-side git transport over libp2p gossipsub.
 *
 * Listens for NIP-PIP transfer manifests (kind 39078) and slices (kind 39079)
 * on the `nostr-dag-bridge` topic, indexes them by repo URL, and reconstructs
 * git bundle payloads.
 */
export class GitP2PTransport {
  constructor({ node, onLog }) {
    this.node = node;
    this.onLog = onLog || (() => {});
    /** @type {Map<string, object>} repoUrl -> manifest */
    this.manifests = new Map();
    /** @type {Map<string, object[]>} manifestEventId -> slices */
    this.slices = new Map();
    /** @type {Map<string, {resolve, reject, timer, manifest, repoUrl}>} */
    this.pendingRequests = new Map();
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    try {
      this.node.services.pubsub.subscribe(TOPIC);
    } catch (e) {
      this.onLog('warn', `git-p2p subscribe failed: ${e.message}`);
    }
    this.node.services.pubsub.addEventListener('message', (event) => {
      this.handleMessage(event);
    });
    this.onLog('info', 'git-p2p transport started');
  }

  handleMessage(event) {
    const data = event?.detail?.data;
    if (!data) return;
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const envelope = decodeBridgeMessage(text);
    if (!envelope) return;
    const eventObj = envelope.event;
    if (!eventObj) return;

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
    });
  }

  /**
   * Returns an isomorphic-git-compatible HTTP client that attempts libp2p
   * first, then falls back to the real HTTP client.
   *
   * NOTE: The git viewer (`demo/git/index.html`) does not currently use this
   * method.  Instead it calls `requestBundle()` directly, writes the bundle
   * bytes to LightningFS, and clones from it via `createBundleHttpClient()`
   * (see `demo/shared/git-bundle-http.mjs`).  That path is simpler because it
   * avoids re-implementing git smart-HTTP streaming from raw bundle bytes.
   * This method is kept for future use if we want transparent interception of
   * every isomorphic-git HTTP request.
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
            // TODO: convert bundle bytes into a git smart-HTTP response.
            // For now we fall through to real HTTP so cloning still works.
            transport.onLog('warn', `git-p2p bundle received but smart-HTTP serving not yet implemented; falling back to HTTP`);
          } catch (e) {
            transport.onLog('debug', `git-p2p intercept failed: ${e.message}`);
          }
        }
        return realHttp.request({ url, method, headers, body, onProgress });
      },
    };
  }
}

export function createGitP2PTransport(options) {
  const transport = new GitP2PTransport(options);
  transport.start();
  return transport;
}
