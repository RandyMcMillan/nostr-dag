# Test Suite

This directory contains all automated tests for `nostr-dag`.  Tests are run with
`node --test` (JS) and `cargo test` (Rust).  The Makefile target `make test-all`
runs both.

## Running tests

```bash
# Fast unit tests (no server required)
node --test test/async-lifecycle.test.mjs
node --test test/bridge-protocol.test.mjs

# Server-dependent tests (start nostr-dag-server first)
make test-js          # Makefile starts server, runs JS suite, stops server
make test-native      # Rust unit + integration tests
make test-all         # Everything
```

## JS / Browser tests

| File | Objective |
|------|-----------|
| `async-lifecycle.test.mjs` | `scheduleAfterPaint` and `yieldToBrowser` defer work correctly (raf → timeout fallback). |
| `bridge-page-peer-visible.test.mjs` | Headless-Chromium: bridge page renders the deterministic local peer. Skips when server is not running. |
| `bridge-peer-visible.test.mjs` | **Core functionality**: `/peers` endpoint returns the embedded native peer (`source: localhost`). Polls defensively because the P2P stack initializes asynchronously. **Skips when server is not running.** |
| `bridge-protocol.test.mjs` | Bridge envelope encoding, decoding, relay-hint collection, and protocol-version gating. |
| `bridge-roundtrip.test.mjs` | RTT tag stamping and extraction for bridge traffic telemetry. |
| `browser-detect.test.mjs` | UA-string parsing for Chrome, Firefox, Safari, Edge, mobile variants. |
| `cross-protocol-broadcast.test.mjs` | Nostr ↔ libp2p message relay does not leak events across protocol boundaries. |
| `dag-actions.test.mjs` | DAG action buttons (create, link, broadcast) trigger the correct event kinds. |
| `dag-button-ui.test.mjs` | Button state transitions (enabled / disabled / loading) match the async lifecycle. |
| `git-cache-survives-refresh.test.mjs` | LocalStorage / IndexedDB repo cache is preserved across page reloads. |
| `git-clone.test.mjs` | isomorphic-git clone through the local CORS proxy produces a valid repo. |
| `git-page-curl.test.mjs` | `curl`-level verification that `/git/` and `/git/blame.html` serve real HTML. |
| `git-page-render.test.mjs` | Repo cards, branch/tag dropdowns, and file trees render with expected text. |
| `git-p2p-relay.test.mjs` | Git data can be fetched via NIP-PIP manifest/slice events relayed over Nostr. |
| `git-p2p-transport.test.mjs` | Git bundle transport over libp2p gossipsub (mocked WASM peer). |
| `git-progress.test.mjs` | Clone progress callbacks fire in expected sequence (receive-pack, index-pack, checkout). |
| `git-refs.test.mjs` | `listServerRefs` through the proxy returns branches and tags. |
| `git-repo-cache.test.mjs` | `GitRepo` class persists tags, branches, and selected ref across reloads. |
| `git-wasm.test.mjs` | isomorphic-git + LightningFS work in the WASM/browser environment. |
| `logger-footer-autoscroll.test.mjs` | Footer logger scrolls to bottom on new entries unless user has manually scrolled up. |
| `logger-footer-log.test.mjs` | Logger `log()` API inserts entries with correct level, source, and timestamp. |
| `logger-footer-queue.test.mjs` | Log queue drains correctly when the footer is attached after a burst of early messages. |
| `logger-footer.test.mjs` | Footer visibility toggles and state survives page refresh. |
| `network-time.test.mjs` | `networkTime` estimates clock skew against the server `/time` endpoint. |
| `nip34-quorum.test.mjs` | NIP-34 repository-address events build a deterministic quorum; attestation and seal sequence is correct. |
| `nip-pip-relay-sniff.mjs` | **Manual / diagnostic**: subscribes to default relays and prints NIP-PIP manifest/slice events. Not run in CI. |
| `nip-pip-wasm.test.mjs` | WASM-side NIP-PIP payload chunking, manifest creation, and slice reconstruction. |
| `page-header.test.mjs` | Shared page header injects nav links and version pill correctly. |
| `page-path.test.mjs` | Route parsing (`?repo=…&branch=…&path=…`) extracts parameters robustly. |
| `p2p-native-wasm-chromium.mjs` | **CRITICAL FUNCTIONALITY** — End-to-end P2P sync: native Rust peer and WASM Chromium peer exchange a real NIP-PIP git bundle. This is the primary test that decentralised git works. Skipped in CI because headless Chromium hangs on GitHub Actions; run locally with `node --test test/p2p-native-wasm-chromium.mjs`. |
| `p2p-wasm.test.mjs` | WASM `P2pNode` mock surface: callback registration, broadcast loopback, message delivery. |
| `pip-git-bare-transfer.test.mjs` | Git bare-repo bundle is packetised, broadcast as NIP-PIP events, and reconstructed byte-for-byte. |
| `pip-js-rust-parity.test.mjs` | JS `parseTransferEvent` / `reconstructPayload` can parse slices produced by Rust `encode_payload_as_transfer_events_chained`. |
| `server-smoke.test.mjs` | HTTP smoke tests: `/git/`, `/bridge/`, `/dag/`, `/proxy/`, `/peers` all return expected content. Skips when server is not running. |

## Standalone scripts (diagnostics / verification)

| File | Purpose |
|------|---------|
| `check-gh-pages.mjs` | Verifies the GH Pages deployment is reachable and serves the expected version. |
| `check-ipv6.mjs` | Quick connectivity check for IPv6 bootstrap relays. |
| `gh-pages-peer-check.mjs` | Polls GH Pages `/peers` to confirm the WASM peer is reporting. |
| `gh-pages-simplepool-check.mjs` | Verifies GH Pages bridge can reach default Nostr relays. |
| `verify-bridge-peer.mjs` | curl-level check that `/peers` contains the localhost entry. |
| `verify-gh-pages-peer.mjs` | curl-level check that GH Pages peer is visible from the public internet. |

## Rust tests

Run via `cargo test --features native` (or `--features p2p,native` for P2P code).

Key integration tests:
- `git_bare_pip_transfer_verbose_trace` — native peer clones a repo, bundles it,
  packetises via NIP-PIP, and publishes manifest + slices to the relay mesh.
- `p2p_node_roundtrip` — two native peers discover each other via mDNS and
  exchange a ping payload over gossipsub.

## CI behaviour

The GitHub Actions workflow runs JS tests **without** starting the server.
Any test that requires the server must detect this and skip gracefully (see
`server-smoke.test.mjs`, `bridge-page-peer-visible.test.mjs`,
`bridge-peer-visible.test.mjs` for the pattern).

The `p2p-native-wasm-chromium.mjs` test is **excluded** from CI because
headless Chromium dead-locks on the GitHub Actions runner. It must be run
locally after `make build`.
