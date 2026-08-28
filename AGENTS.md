# nostr-dag — Agent Reference

This file is a concise, up-to-date guide for AI coding agents working on `nostr-dag`.

## Project Overview

`nostr-dag` is a Rust library and browser application that implements **DAG-based optimistic consensus over Nostr events**. A federation of keypairs mutually acknowledges events (Kind 21000); an event becomes "canonical" once a majority of participants have acked it. The project also includes a libp2p bridge, an in-browser Git viewer, NIP-34 helpers, and a dual-layer relational store (SQLite natively, IndexedDB in the browser).

Repository: https://github.com/RandyMcMillan/nostr-dag  
License: MIT

## Technology Stack

| Layer | Technology |
|-------|------------|
| Core language | Rust (edition 2021) |
| WASM toolchain | `wasm-bindgen` + `wasm-pack` |
| Browser runtime | Vanilla ES modules (no framework) |
| Bundler | `esbuild` (for vendor bundles only) |
| P2P networking | `libp2p` 0.54 (native TCP/mDNS/gossipsub + WASM WebSocket) |
| Nostr protocol | `rust-nostr` SDK (`nostr` 0.44, `nostr-relay-pool` 0.44.3) |
| Native database | `rusqlite` with bundled SQLite |
| Native Git | `git2` |
| Browser Git | `isomorphic-git` + `@isomorphic-git/lightning-fs` |
| Testing (Rust) | Built-in `cargo test` |
| Testing (JS) | Node.js built-in test runner (`node --test`) |
| Browser testing | Playwright (optional, for Safari/macOS) |
| Task runner | `just` (preferred) or `make` (kept in sync) |

## Project Layout

```
src/
  lib.rs               Public API + WASM entry points
  dag.rs               Core DAG consensus engine
  event.rs             Nostr event kind helpers (21000, 39080–39082)
  quorum.rs            BlobQuorum attestation / seal / join logic
  store.rs             SQLite relational store (native only)
  p2p.rs               Dual-target libp2p node (native + WASM)
  p2p_node.rs          Standalone native libp2p peer CLI logic
  bridge_native.rs     Nostr ↔ libp2p bridge envelopes (native)
  bridge_roundtrip.rs  RTT timestamp tagging for bridge messages
  nip34.rs             NIP-34 nostr:// URL helpers
  git.rs               Native git2 helpers
  git_wasm.rs          WASM isomorphic-git bindings
  error.rs             Error types
  assets.rs            Embedded favicon / SVG icons
  bin/
    federation.rs      Federation daemon (watches relay, publishes acks)
    relay.rs           Embedded Nostr relay for local demo
    keygen.rs          Demo key + startup command / TOML generator
    nostr-dag-server.rs  Local static/API server
    git-info.rs        CLI git info helper
    p2p-node.rs        Standalone native libp2p peer CLI

demo/
  index.html           Main browser frontend (DAG + bridge)
  git/index.html       Git viewer
  git/blame.html       Git blame view
  bridge/index.html    libp2p bridge page
  bridge/relay.html    Bridge relay page
  shared/              Shared browser modules (source of truth for site/)
  run.sh               Demo launcher (relay + 5 federation daemons)
  federation.toml      Pre-generated demo federation keys

test/
  *.test.mjs           Node.js test suite (unit + integration)

site/                  Generated GitHub Pages output — **do not hand-edit**
scripts/build-vendor.mjs   esbuild bundles for demo/vendor/
vendor-src/            ESM wrapper entry points for esbuild
```

## Build System

The project uses **Cargo** for Rust and **feature flags** to target three environments:

- `native` — server-side binaries, SQLite, tokio, relay pool
- `wasm` — browser WASM package via `wasm-pack`
- `p2p` / `p2p-wasm` — libp2p gossipsub node (native or WASM)
- `relay` — embedded Nostr relay (`nostr-relay-builder`)

### Common Commands

Use `just` (preferred) or `make`. The two files are kept in sync.

```bash
# Build native library + binaries
just build                   # cargo build --features native

# Run all tests
just test                    # test-native + test-js
just test-native             # cargo test --features native
just test-js                 # node --test test/*.test.mjs
just test-p2p                # P2P integration tests
just test-p2p-native-wasm    # native ↔ wasm PIP test
just test-pip-bare-repo      # bare-repo PIP transfer tests

# WASM package → site/pkg
just wasm

# Full static site (WASM + demo assets → site/)
just site

# Local preview server (builds site first)
just server

# Start embedded relay + 5 federation daemons
just demo

# Release binaries
just build-relay             # relay + federation
just build-server            # nostr-dag-server

# Clean
just clean                   # cargo clean + rm -rf pkg site
```

### WASM Build Notes

- Requires `wasm32-unknown-unknown` target.
- On macOS the build script auto-detects Homebrew LLVM (`brew --prefix llvm`) and falls back to `clang` / `xcrun`.
- `wasm-pack` is auto-installed if missing.
- The build disables `wasm-opt` in `Cargo.toml` (`wasm-opt = false`).

## Feature Flags

| Feature | Description | Key Dependencies |
|---------|-------------|------------------|
| `native` | Server binaries, SQLite store, tokio runtime | tokio, rusqlite, git2, reqwest, serde |
| `wasm` | Browser WASM bindings | wasm-bindgen, web-sys, getrandom |
| `relay` | Embedded Nostr relay | nostr-relay-builder |
| `p2p` | Native libp2p peer | libp2p (TCP, noise, yamux, gossipsub, mdns, …) |
| `p2p-wasm` | WASM libp2p peer | libp2p (wasm-bindgen, websocket-websys, …) |

Default features are **empty**; always pass explicit features.

## Code Organization Conventions

### Rust

- Modules are gated with `#[cfg(feature = "...")]` when they depend on optional dependencies.
- `src/lib.rs` exposes a unified public API; thin `src/bin/*.rs` wrappers delegate to `src/lib.rs` or `src/native_cli.rs`.
- Tracing is used throughout (`tracing::info`, `debug`, `trace`, `warn`). Native binaries init `tracing_subscriber` with `EnvFilter`.
- Error types live in `src/error.rs` and use `thiserror`.
- Nostr custom kinds are defined as constants in `src/event.rs`:
  - `DAG_EVENT_KIND` = 21000 (ack events)
  - `PIP_ATTEST_KIND` = 39080
  - `PIP_SEAL_KIND` = 39081
  - `PIP_JOIN_KIND` = 39082

### JavaScript / Browser

- All browser code is ES modules (`.mjs`). No bundler is required at dev time except for `demo/vendor/` bundles generated by `scripts/build-vendor.mjs`.
- **Source of truth for browser UI is `demo/`**. The `site/` directory is generated by `just site` / the Pages workflow. Never hand-edit `site/`.
- `demo/shared/page-path.js` exports `resolveHref()`, which must be used for all asset and navigation URLs so the app works both locally and on GitHub Pages.
- Shared helpers live in `demo/shared/` and are copied verbatim to `site/shared/` during builds.
- `demo/shared/app-version.generated.mjs` is written by `build.rs` (Cargo build script) and should not be edited manually.

## Testing Strategy

### Rust Tests

```bash
cargo test --features native
cargo test --features native,p2p
```

- Run with `RUST_BACKTRACE=full RUST_TEST_THREADS=1` in CI for deterministic output.
- Unit tests are embedded in source files (`#[cfg(test)] mod tests`).

### JS Tests

```bash
node --test test/*.test.mjs
```

- Uses Node.js built-in test runner (no jest/mocha).
- WASM-dependent tests stub the `WasmDag` class so they run in Node without `wasm-pack` output.
- Browser-only tests (e.g., `browser-detect.test.mjs`) run headlessly in Node when possible; Playwright is used for Safari-specific coverage.

### Integration Tests

- `test/p2p-native-wasm.test.mjs` — tests native ↔ WASM libp2p PIP transfer using deterministic test identities.
- `test/p2p-node-integration.test.mjs` — standalone native peer CLI integration.
- `test/pip-git-bare-transfer.test.mjs` — Git bare-repo PIP transfer end-to-end.

### Deterministic Test Identities

Test keys are derived from fixed SHA-256 labels (these are public preimages, not secrets):

- `nostr-dag-native` → native libp2p / Nostr seed
- `nostr-dag-wasm` → WASM libp2p seed

Verify locally: `printf 'nostr-dag-wasm' | shasum -a 256`

## Key Protocols & Specifications

### PIP / NIP-PIP (Perfect IP)

The project’s data transfer protocol is documented in `PIP.md`. Key constants:

- Bridge topic: `nostr-dag-bridge`
- Bridge version: `"1"`
- Transfer protocol: `nostr-dag-transfer`
- Transfer manifest kind: `39078`
- Transfer slice kind: `39079`

### Quorum Attestation

Threshold rule: `T = ceil(N × 4 / 5) − 1`. A quorum is reached when attestations are **strictly greater than T**.

## Deployment

### GitHub Pages

- Workflow: `.github/workflows/pages.yml`
- Triggered on pushes to `master` or manually.
- Builds WASM, copies `demo/` into `site/`, and deploys via `actions/deploy-pages`.

### CI

- `.github/workflows/ci.yml` — Ubuntu tests for native, JS, WASM, p2p, and p2p-wasm.
- `.github/workflows/macos-cross-architecture-ci.yml` — macOS cross-architecture builds.

## Security Considerations

- Relay hints in bridge envelopes are **advisory only** and must not be treated as proof of origin or trust.
- The bridge relay verification samples at most two relays per event and uses cache/backoff to avoid rate-limiting.
- PIP relies on standard Nostr event signatures for authenticity.
- Full event IDs and pubkeys are **never truncated** in the UI.
- The local server (`nostr-dag-server`) treats `BrokenPipe` / `ConnectionReset` / `UnexpectedEof` as normal client disconnects (trace level).

## Quick Reference

| Task | Command |
|------|---------|
| Build everything native | `just build` |
| Run all tests | `just test` |
| Build WASM | `just wasm` |
| Build site | `just site` |
| Start local server | `just server` |
| Start demo (relay + federation) | `just demo` |
| Run native peer CLI | `cargo run --features p2p --bin p2p-node` |
| Generate keys / TOML | `cargo run --bin keygen --format toml` |
| Build vendor bundles | `npm run build:vendor` |
