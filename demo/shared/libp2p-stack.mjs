import { createLibp2p } from "https://esm.sh/libp2p";
import { autoNAT } from "https://esm.sh/@libp2p/autonat";
import { bootstrap } from "https://esm.sh/@libp2p/bootstrap";
import { circuitRelayTransport } from "https://esm.sh/@libp2p/circuit-relay-v2";
import { dcutr } from "https://esm.sh/@libp2p/dcutr";
import { gossipsub } from "https://esm.sh/@libp2p/gossipsub";
import { identify } from "https://esm.sh/@libp2p/identify";
import { webSockets } from "https://esm.sh/@libp2p/websockets";
import { webRTC, webRTCDirect } from "https://esm.sh/@libp2p/webrtc";
import { generateKeyPairFromSeed } from "https://esm.sh/@libp2p/crypto/keys";
import { noise } from "https://esm.sh/@chainsafe/libp2p-noise";
import { yamux } from "https://esm.sh/@chainsafe/libp2p-yamux";
import { peerIdFromPrivateKey } from "https://esm.sh/@libp2p/peer-id";

export const DEFAULT_BOOTSTRAP_PEERS = [
  "/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
  "/dns4/sv15.bootstrap.libp2p.io/tcp/443/wss/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
  "/dns4/ny5.bootstrap.libp2p.io/tcp/443/wss/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
  "/dns4/am6.bootstrap.libp2p.io/tcp/443/wss/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
  "/dns4/sg1.bootstrap.libp2p.io/tcp/443/wss/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
];

const peerLabel = (event) => event?.detail?.peerId?.toString?.() || event?.detail?.remotePeer?.toString?.() || "peer";

const describePeerDetail = (detail) => {
  const scalarText = (value) => {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value?.toString === "function") {
      const text = value.toString();
      if (text && text !== "[object Object]") return text;
    }
    if (value?.bytes instanceof Uint8Array) {
      return [...value.bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    if (value?.multihash?.bytes instanceof Uint8Array) {
      return [...value.multihash.bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    return "";
  };
  const parseKeyValueString = (text) => {
    const entries = [];
    for (const token of String(text).split(/\s+/)) {
      const [key, ...rest] = token.split("=");
      if (!key || !rest.length) continue;
      entries.push([key, rest.join("=")]);
    }
    return entries;
  };
  const entriesToText = (entries) => entries
    .flatMap(([key, value]) => {
      if (value == null || value === "") return [];
      if (key === "keys") {
        return ["keys:", ...String(value).split(",").filter(Boolean).map((item) => `  - ${item}`)];
      }
      return [`${key}: ${value}`];
    })
    .join("\n");
  if (!detail) return "no detail";
  if (typeof detail === "string") {
    const parsed = parseKeyValueString(detail);
    return parsed.length ? entriesToText(parsed) : detail;
  }
  if (typeof detail !== "object") return String(detail);
  const fields = [];
  if (scalarText(detail.peerId)) fields.push(["peerId", scalarText(detail.peerId)]);
  if (scalarText(detail.remotePeer)) fields.push(["remotePeer", scalarText(detail.remotePeer)]);
  if (detail.connection?.stat?.direction) fields.push(["direction", detail.connection.stat.direction]);
  if (scalarText(detail.connection?.remoteAddr)) fields.push(["remoteAddr", scalarText(detail.connection.remoteAddr)]);
  if (scalarText(detail.id)) fields.push(["id", scalarText(detail.id)]);
  if (detail.multiaddrs?.length) fields.push(["multiaddrs", detail.multiaddrs.map((addr) => scalarText(addr) || String(addr)).join(" | ")]);
  if (detail.type) fields.push(["type", detail.type]);
  if (scalarText(detail.multihash)) fields.push(["multihash", scalarText(detail.multihash)]);
  if (scalarText(detail.publicKey)) fields.push(["publicKey", scalarText(detail.publicKey)]);
  if (detail.keys && Array.isArray(detail.keys)) fields.push(["keys", detail.keys.join(",")]);
  if (detail.keys && !Array.isArray(detail.keys) && typeof detail.keys === "string") fields.push(["keys", detail.keys]);
  return fields.length ? entriesToText(fields) : JSON.stringify(detail, null, 2);
};

const emitLog = (onLog, level, text, state = "checking") => {
  onLog?.(level, text, state);
  if (level !== "debug") {
    onLog?.("debug", `[${level}] ${text}`, state);
  }
};

const peerDetailSummary = (detail) => {
  if (!detail || typeof detail !== "object") return "";
  const bits = [];
  const scalarText = (value) => {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value?.toString === "function") {
      const text = value.toString();
      if (text && text !== "[object Object]") return text;
    }
    return "";
  };
  if (scalarText(detail.connection?.remoteAddr)) bits.push(scalarText(detail.connection.remoteAddr));
  if (detail.connection?.stat?.direction) bits.push(detail.connection.stat.direction);
  if (scalarText(detail.peerId)) bits.push(scalarText(detail.peerId));
  if (scalarText(detail.remotePeer)) bits.push(scalarText(detail.remotePeer));
  if (!bits.length && detail.multiaddrs?.length) bits.push(scalarText(detail.multiaddrs[0]) || String(detail.multiaddrs[0]));
  return bits.filter(Boolean).join(" · ");
};

const passthroughFilter = (multiaddrs) => (Array.isArray(multiaddrs) ? multiaddrs.filter(Boolean) : []).filter(Boolean);

/**
 * Strip unencrypted /ws multiaddrs when running on HTTPS to avoid mixed
 * content warnings (and blocked dials) in the browser.
 */
const secureWsDialFilter = (multiaddrs) => {
  const addrs = passthroughFilter(multiaddrs);
  if (globalThis.location?.protocol !== 'https:') return addrs;
  return addrs.filter((addr) => {
    const parts = String(addr).split('/').filter(Boolean);
    // /wss is secure; /ws (without /wss) is not.
    const hasWs = parts.includes('ws');
    const hasWss = parts.includes('wss');
    if (hasWs && !hasWss) return false;
    return true;
  });
};

const ensureSeedBytes = async (seed) => {
  if (seed instanceof Uint8Array) return seed;
  if (typeof seed === "string") {
    const encoded = new TextEncoder().encode(seed);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
    return new Uint8Array(digest);
  }
  throw new TypeError("deterministic libp2p seed must be a string or Uint8Array");
};

const createDeterministicPrivateKey = async (seed) => {
  const privateKeyRaw = await ensureSeedBytes(seed);
  if (privateKeyRaw.length !== 32) {
    throw new TypeError(`deterministic libp2p seed must be 32 bytes, got ${privateKeyRaw.length}`);
  }
  return generateKeyPairFromSeed("Ed25519", privateKeyRaw);
};

export async function deterministicPeerIdFromSeed(seed) {
  const privateKey = await createDeterministicPrivateKey(seed);
  return peerIdFromPrivateKey(privateKey).toString();
}

const ensureTransportFilters = (transport, label, onLog) => {
  if (typeof transport.listenFilter !== "function") {
    transport.listenFilter = passthroughFilter;
    emitLog(onLog, "warn", `${label} transport missing listenFilter; using passthrough`, "checking");
  }
  if (typeof transport.dialFilter !== "function") {
    transport.dialFilter = passthroughFilter;
    emitLog(onLog, "warn", `${label} transport missing dialFilter; using passthrough`, "checking");
  }
  return transport;
};

// Report every peer lifecycle transition to the UI and optional local /peers registry.
const emitPeerEvent = (onPeer, onLog, kind, event, level = "debug", state = "checking") => {
  const peer = peerLabel(event);
  const detail = event?.detail || null;
  const summary = peerDetailSummary(detail);
  onPeer?.({ kind, peer, detail });
  emitLog(onLog, level, `peer ${kind}: ${peer}${summary ? ` (${summary})` : ""}`, state);
  emitLog(onLog, "trace", `peer ${kind} detail: ${describePeerDetail(detail)}`, state);
  reportPeers({
    peer_id: globalThis.__currentLibp2pPeerId || peer,
    kind: `peer:${kind}`,
    path: globalThis.location?.pathname || "/",
    detail: describePeerDetail(detail),
    source: globalThis.location?.pathname || "/",
    updated_at: Date.now(),
  });
};

const PEERS_ENDPOINT = "/peers";

function shouldReportPeers() {
  try {
    const host = globalThis.location?.hostname || "";
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function reportPeers(payload) {
  if (!shouldReportPeers()) return;
  const body = JSON.stringify(payload);
  try {
    if (globalThis.navigator?.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      globalThis.navigator.sendBeacon(PEERS_ENDPOINT, blob);
      return;
    }
  } catch {
    // best effort only
  }

  void globalThis.fetch?.(PEERS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
    cache: "no-store",
  }).catch(() => {});
}

// Create the shared browser libp2p stack used by the demo, git viewer, blame view, and bridge.
//
// Transport flags let callers trim the stack for environments that reject certain browser
// transport combinations. The default keeps hole punching paths enabled; callers may disable
// them one by one and still get a working webSockets-only node as a final fallback.
export async function createSharedLibp2pStack({
  bootstrapPeers = DEFAULT_BOOTSTRAP_PEERS,
  onLog,
  onPeer,
  onStatus,
  includeWebRTC = true,
  includeWebRTCDirect = true,
  includeCircuitRelay = true,
  preferWebSocketsOnly = false,
  deterministicKeySeed = null,
  // When the WASM P2pNode is available (loaded via pkg/nostr_dag.js) and
  // `useWasmP2p` is true (default), use it instead of the JS libp2p stack.
  // Set to false to force the pure-JS fallback.
  useWasmP2p = true,
  wasmModule = null,
} = {}) {
  // Resolve the bootstrap peer list early so both WASM and JS paths can use it.
  const peers = [...new Set(bootstrapPeers.filter(Boolean))];
  if (preferWebSocketsOnly) {
    emitLog(onLog, "info", "starting with websocket-only libp2p fallback", "checking");
  }
  // ---------------------------------------------------------------------------
  // Try the WASM P2pNode first (src/p2p.rs, p2p-wasm feature)
  // ---------------------------------------------------------------------------
  if (useWasmP2p) {
    try {
      // `wasmModule` may be passed explicitly in tests; otherwise look for the
      // P2pNode class on the already-initialised WASM module exposed as
      // `globalThis.__nostrDagWasm`.
      const mod = wasmModule || globalThis.__nostrDagWasm;
      if (mod && typeof mod.P2pNode === "function") {
        emitLog(onLog, "info", "using WASM P2pNode for libp2p", "checking");
        const p2pNode = new mod.P2pNode();
        const handlers = [];
        p2pNode.on_message((msg) => {
          for (const h of handlers) h(msg);
        });
        await p2pNode.start();
        emitLog(onLog, "info", "WASM P2pNode started", "available");
        // Dial bootstrap peers so the WASM node can join the gossipsub mesh.
        // p2pNode.dial is optional (not present in all builds); skip silently if absent.
        if (typeof p2pNode.dial === "function") {
          for (const addr of peers) {
            try {
              await p2pNode.dial(addr);
              emitLog(onLog, "debug", `WASM P2pNode dialed bootstrap peer: ${addr}`, "checking");
            } catch (dialErr) {
              emitLog(onLog, "warn", `WASM P2pNode dial failed (${addr}): ${dialErr?.message || dialErr}`, "checking");
            }
          }
        } else {
          emitLog(onLog, "debug", `WASM P2pNode has no dial method; bootstrap peers skipped (${peers.length} configured)`, "checking");
        }
        const wasmPeerId = typeof p2pNode.peer_id === "function" ? p2pNode.peer_id() : "wasm-p2p-node";
        onStatus?.("started", wasmPeerId);
        globalThis.__currentLibp2pPeerId = wasmPeerId;
        reportPeers({
          peer_id: wasmPeerId,
          kind: "started",
          path: globalThis.location?.pathname || "/",
          detail: `wasm-p2p-node bootstrap-peers=${peers.length}`,
          source: globalThis.location?.pathname || "/",
          updated_at: Date.now(),
        });
        // Return a minimal adapter that matches the JS node surface used by
        // callers (publish, subscribe, peerId string, stop).
        return {
          node: {
            _wasmNode: p2pNode,
            peerId: { toString: () => wasmPeerId },
            services: {
              pubsub: {
                publish: async (_topic, data) => {
                  const msg = typeof data === "string" ? data : new TextDecoder().decode(data);
                  await p2pNode.broadcast(msg);
                },
                subscribe: (_topic) => {},
                addEventListener: (event, cb) => {
                  if (event === "message") handlers.push((msg) => cb({ detail: { data: new TextEncoder().encode(msg) } }));
                },
              },
            },
            getMultiaddrs: () => [],
            stop: async () => {},
          },
          bootstrapPeers: peers,
        };
      }
    } catch (wasmErr) {
      emitLog(onLog, "warn", `WASM P2pNode unavailable, falling back to JS stack: ${wasmErr?.message || wasmErr}`, "checking");
    }
  }
  // ---------------------------------------------------------------------------
  // JS libp2p fallback
  // ---------------------------------------------------------------------------
  emitLog(onLog, "trace", `bootstrap peers: ${peers.join(" | ") || "none"}`, "checking");
  emitLog(onLog, "info", `bootstrapping with ${peers.length} peer${peers.length === 1 ? "" : "s"}`, "checking");
  emitLog(onLog, "debug", `bootstrap peers configured: ${peers.length}`, "checking");
  emitLog(onLog, "trace", "shared libp2p stack configuring transports and services", "checking");
  emitLog(onLog, "trace", "transports: webSockets, webRTC, webRTCDirect, circuitRelayTransport", "checking");
  emitLog(onLog, "trace", "services: identify, autoNAT, dcutr, pubsub", "checking");
  const buildTransportConfig = ({ webRTC: useWebRTC, webRTCDirect: useWebRTCDirect, circuitRelay: useCircuitRelay }) => {
    const wsTransport = ensureTransportFilters(webSockets(), "webSockets", onLog);
    wsTransport.dialFilter = secureWsDialFilter;
    return {
      transports: [
        wsTransport,
        ...(useWebRTC ? [ensureTransportFilters(webRTC(), "webRTC", onLog)] : []),
        ...(useWebRTCDirect ? [ensureTransportFilters(webRTCDirect(), "webRTCDirect", onLog)] : []),
        ...(useCircuitRelay ? [ensureTransportFilters(circuitRelayTransport(), "circuitRelayTransport", onLog)] : []),
      ],
    addresses: {
      listen: [
        ...(useCircuitRelay ? ["/p2p-circuit"] : []),
        ...((useWebRTC || useWebRTCDirect) ? ["/webrtc"] : []),
      ],
    },
  };
};

  const configs = preferWebSocketsOnly ? [
    {
      name: "webSockets only",
      ...buildTransportConfig({
        webRTC: false,
        webRTCDirect: false,
        circuitRelay: false,
      }),
    },
  ] : [
    {
      name: "full browser stack",
      ...buildTransportConfig({
        webRTC: includeWebRTC,
        webRTCDirect: includeWebRTCDirect,
        circuitRelay: includeCircuitRelay,
      }),
    },
    {
      name: "no webRTCDirect",
      ...buildTransportConfig({
        webRTC: includeWebRTC,
        webRTCDirect: false,
        circuitRelay: includeCircuitRelay,
      }),
    },
    {
      name: "webSockets only",
      ...buildTransportConfig({
        webRTC: false,
        webRTCDirect: false,
        circuitRelay: false,
      }),
    },
  ];

  let node = null;
  let lastError = null;
  const allowLocalDial = peers.some((addr) => /127\.0\.0\.1|localhost|::1/.test(addr))
    || ["localhost", "127.0.0.1", "::1"].includes(globalThis.location?.hostname || "");
  for (const config of configs) {
    try {
      emitLog(onLog, "trace", `constructing libp2p node (${config.name})`, "checking");
      const privateKey = deterministicKeySeed
        ? await createDeterministicPrivateKey(deterministicKeySeed)
        : undefined;
      node = await createLibp2p({
        transports: config.transports,
        addresses: config.addresses,
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: {
          identify: identify(),
          autoNAT: autoNAT(),
          dcutr: dcutr(),
          pubsub: gossipsub({
            allowPublishToZeroTopicPeers: true,
            emitSelf: true,
          }),
        },
        ...(allowLocalDial ? {
          connectionGater: {
            denyDialMultiaddr: async () => false,
          },
        } : {}),
        ...(privateKey ? { privateKey } : {}),
        peerDiscovery: peers.length ? [
          bootstrap({
            list: peers,
            interval: 60_000,
            timeout: 3_000,
          }),
        ] : [],
      });
      emitLog(onLog, "trace", `libp2p node constructed (${config.name})`, "checking");
      break;
    } catch (error) {
      lastError = error;
      emitLog(onLog, "warn", `libp2p config failed (${config.name}): ${error.message}`, "unavailable");
    }
  }

  if (!node) {
    throw lastError || new Error("unable to create libp2p node");
  }

  node.addEventListener("peer:discovery", (event) => {
    emitPeerEvent(onPeer, onLog, "discovered", event, "debug", "checking");
  });
  node.addEventListener("peer:connect", (event) => {
    emitPeerEvent(onPeer, onLog, "connected", event, "info", "available");
  });
  node.addEventListener("peer:disconnect", (event) => {
    emitPeerEvent(onPeer, onLog, "disconnected", event, "warn", "checking");
    reportPeers({
      peer_id: node.peerId.toString(),
      kind: "peer:disconnect",
      path: globalThis.location?.pathname || "/",
      detail: describePeerDetail(event?.detail),
      source: globalThis.location?.pathname || "/",
      updated_at: Date.now(),
    });
  });
  node.addEventListener("error", (event) => {
    const message = event?.detail?.message || event?.message || "libp2p error";
    emitLog(onLog, "error", message, "unavailable");
  });

  emitLog(onLog, "trace", "starting libp2p node", "checking");
  await node.start();
  emitLog(onLog, "trace", "shared libp2p node started", "available");
  emitLog(onLog, "trace", `listen addrs: ${node.getMultiaddrs?.().map?.((m) => m.toString()).join(" | ") || "n/a"}`, "available");
  onStatus?.("started", node.peerId.toString());
  globalThis.__currentLibp2pPeerId = node.peerId.toString();
  reportPeers({
    peer_id: node.peerId.toString(),
    kind: "started",
    path: globalThis.location?.pathname || "/",
    detail: node.getMultiaddrs?.().map?.((m) => m.toString()).join(" | ") || "n/a",
    source: globalThis.location?.pathname || "/",
    updated_at: Date.now(),
  });
  emitLog(onLog, "info", `node started: ${node.peerId.toString()}`, "available");
  emitLog(onLog, "debug", `peer id stable: ${node.peerId.toString()}`, "available");

  return {
    node,
    bootstrapPeers: peers,
  };
}
