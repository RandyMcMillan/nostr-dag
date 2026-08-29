# nostr-dag Demo

Browser-based demo suite for the nostr-dag project. It runs as a static site on
GitHub Pages and can also be served locally for development.

## Quick Start

```bash
# Serve the demo directory on http://127.0.0.1:3000
cargo run --bin nostr-dag-server --features p2p,native
```

Or with any static file server:

```bash
npx serve demo -l 3000
```

Open http://127.0.0.1:3000/git/ for the git viewer.

## Directory Layout

| Path | Purpose |
|------|---------|
| `bridge/` | Nostr ↔ libp2p bridge page. Shows live relay traffic, peer list, and cross-protocol message flow. |
| `dag/` | DAG visualiser for Nostr events. Creates and publishes events, renders ancestor graphs. |
| `git/` | Browser git viewer built on `isomorphic-git`. Clones repos, renders trees, blame, refs, and tags. |
| `shared/` | Reusable modules used by all three apps: libp2p stack, logger, page chrome, protocol codecs, etc. |
| `vendor/` | Vendored third-party libraries (isomorphic-git, lightning-fs) so the demo works offline and on GH Pages without CDN dependencies. |
| `index.html` | Root redirect → `./git/`. |
| `run.sh` / `setup.sh` | Legacy federation demo scripts. |
| `federation.toml` | Example federation configuration. |

## The Three Apps

### Git Viewer (`git/`)

A single-page git browser that clones public repositories into an in-browser
LightningFS filesystem using `isomorphic-git`. Because browsers enforce CORS,
the viewer normally relies on a proxy (`cors.isomorphic-git.org`) to reach
GitHub. When that proxy is blocked or down the viewer shows red status lights
and cloning fails.

**Decentralisation path:** We are replacing the CORS-proxy dependency with
libp2p-based git transport (see `git/GIT_PROXY.md`). The native
`nostr-dag-server` peer maintains local repo mirrors, advertises them as PIP
bundles over gossipsub, and browsers can request slices directly from peers.

### DAG Visualiser (`dag/`)

Creates Nostr events, signs them with ephemeral or persisted keys, publishes
them to configured relays, and renders the resulting DAG. Supports real-time
updates via relay WebSocket subscriptions.

### Bridge (`bridge/`)

The protocol bridge sits between Nostr relays and the libp2p mesh. It:

- Subscribes to a set of Nostr relays via WebSocket.
- Runs a libp2p node (JS or WASM) connected to bootstrap peers.
- Forwards Nostr events into the libp2p topic `nostr-dag-bridge`.
- Forwards libp2p messages back out to Nostr relays as kind-30078 events.
- Displays a live peer list, relay health, and recent message logs.

## Shared Modules (`shared/`)

| Module | Role |
|--------|------|
| `libp2p-stack.mjs` | Browser libp2p node factory. Handles WebSocket, WebRTC, circuit-relay and dcutr transports, noise/yamux encryption, identify, autoNAT, gossipsub. Falls back through full-stack → no-WebRTC → WebSocket-only configs until one boots. |
| `bridge-page.mjs` | Main bridge UI logic: peer list, relay list, message routing, presence handling, circuit dialing. |
| `bridge-protocol.mjs` | Envelope format for messages crossing the Nostr/libp2p boundary. |
| `peers-list.mjs` | Pure renderer for the peer list panel. |
| `git-viewer.mjs` / `git-page.mjs` | Git UI chrome, repo selection, ref resolution, status lights. |
| `host-probe.mjs` | Shared reachability probe for git hosts (used by status lights). |
| `logger.js` / `logger-footer.js` | Footer log panel used by every app. |
| `page-shell.mjs` | Common header, footer, and layout bootstrap. |

## Peer List & Pruning Policy

The bridge peer list intentionally **never prunes libp2p-discovered peers**.
Only `localhost` or `http`-sourced peers (reported by the local
`/peers` endpoint) are removed when they stop reporting. This ensures that:

- A browser on GitHub Pages can still see a native peer that was discovered
  once, even if the presence broadcast interval is long.
- Relay-circuit peers remain visible because their source is `libp2p`, not
  `localhost`.

See `pollPeers()` in `bridge-page.mjs` for the implementation.

## GitHub Pages vs Local Differences

| Feature | Local (`127.0.0.1:3000`) | GitHub Pages |
|---------|--------------------------|--------------|
| `/peers` endpoint | Available (local server reports peer state) | 404 — peers are discovered purely via libp2p |
| Native peer visibility | Direct WebSocket + relay circuit | Only via relay circuit through bootstrap mesh |
| CORS proxy fallback | Works if proxy is up | Same — still subject to proxy availability |
| Bootstrap peers | DNS + IP + WSS | WSS only (browser cannot dial raw TCP) |

Because GH Pages cannot dial local TCP addresses, the only path for a GH
Pages browser to reach a developer's laptop is:

```
Browser (WSS) → IPFS bootstrap node → relay reservation →
Native peer circuit address → presence broadcast →
Browser receives circuit addr → dials circuit
```

This path works but can take 30–120 s for gossipsub mesh formation and
presence propagation. The peer list is kept intentionally persistent so that
once a peer is discovered it remains visible.

## Vendored Dependencies

All runtime dependencies are copied into `vendor/` so the demo loads reliably
on GH Pages even if CDNs are blocked or rate-limited:

- `isomorphic-git.mjs`
- `isomorphic-git-http-web.mjs`
- `lightning-fs.mjs`

Source-map files (`.map`) are **not** vendored; browsers will log 404s for
them. This is harmless and avoids shipping hundreds of extra files.

## Development Tips

- The deterministic native peer ID is derived from the seed
  `nostr-dag-native` and is stable across restarts:
  `12D3KooWSL8rLNFrwVGVBJbHWxXQfFTfVtYnozURrqBFYBMfrniH`.
- Start the server with `P2P_ENABLE=1` to activate the embedded libp2p peer.
- Use the browser dev-tools network tab to watch WebSocket connections to
  bootstrap nodes and Nostr relays.
- The test suite contains `test/verify-bridge-peer.mjs` (local) and
  `test/verify-gh-pages-peer.mjs` (GH Pages) for automated peer-visibility
  checks.
