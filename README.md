# nostr-dag

DAG-based optimistic consensus for Nostr, with libp2p bridging, a Git viewer, NIP-34 support, and a dual-layer relational store.

## What is this?

`nostr-dag` is a Rust library and browser application that implements DAG-based optimistic consensus over Nostr events.
A set of federation keypairs mutually acknowledge events (Kind 21000) referencing their parents; an event becomes
"canonical" once a majority of participants have acked it.  The project has grown well beyond the original hackathon
sketch into a multi-layer system.

`nostr-dag` is a protocol extension and software framework designed to structure Nostr events into explicit Directed Acyclic Graphs (DAGs).

While Nostr traditionally relies on simple event structures (such as direct replies or linear threads), nostr-dag enforces deterministic multi-parent linking and dependency tracking directly within event tags.

### Key Technical Integrations & Mechanics

- **Parent-Child Event Graphing:** Events explicitly list parent event IDs (via custom tags or explicit parent selections in the UI), building a strict single-direction, non-cyclical topology.

- **Domain-Specific Event Kinds:** Custom event kinds model complex state transitions beyond social posts:
  - **Repository & Code Collaboration:** 30617 (Repo Announcement), 30618 (Repo State), 1618 (Pull Request), 1621 (Issue).
  - **DAG State & Consensus:** 39078 (Transfer Manifest), 39079 (Transfer Slice), 39080 (Quorum Attest), 39081 (Quorum Seal), 21000 (Ack).

- **Deterministic Execution & Ordering:** By running graph-traversal logic over events, clients can topologically sort state changes to resolve dependencies, merge concurrent updates, and establish deterministic ordering without needing a centralized server.

### Primary Technical Benefits

- **Censorship-Resistant State Synchronization:** Enables distributed databases, git-like version control systems, and collaborative applications over simple, decentralized Nostr relays.

- **Conflict-Free & Asynchronous Operations:** Handles offline-first operations and parallel state changes gracefully. Concurrent edits branching off a common parent event can be merged downstream through DAG seals and attestation events.

- **Verifiable Audit Trails:** Every node/event in the DAG is cryptographically signed using Nostr public keys (npub), rendering the historical integrity of the DAG tamper-proof and verifiable by any observer.

### Core Developer Use Cases

- **Decentralized Code Collaboration:** Building decentralized alternatives to GitHub (e.g., NIP-34 style git sequences) where code commits, pull requests, and branch state transitions form explicit DAG structures across Nostr relays.

- **Distributed State Machines & Quorum Consensus:** Implementing off-chain micro-consensus networks using quorum attestations (39080) and seals (39081) for distributed ledger or app-state management.

- **Threaded & Graph-Based Messaging Protocols:** Constructing multi-path conversations, complex task workflows, and project management applications where nodes represent tasks, dependencies, or concurrent threads.

- **Consensus engine** (`src/dag.rs`) — buffers events with missing parents, tracks `seen_by`, caches depth, and
  derives canonical order by `(depth, event_id)`.
- **Persistent store** (`src/store.rs`, native; `demo/shared/dag-db.mjs`, browser) — dual-layer relational store using
  SQLite on the server and IndexedDB in the browser.  Both share the same eight-table schema: `events`, `tags`,
  `relays`, `users`, `user_relays`, `event_relays`, `dag_edges`, `dag_seen_by`.
- **libp2p bridge** (`src/p2p.rs`, `demo/shared/bridge-page.mjs`) — native and WASM libp2p nodes share a
  `nostr-dag-bridge` gossipsub topic.  The bridge page signs and publishes kind 0 presence events to all known relays
  and forwards libp2p messages into Nostr and back.
- **Git viewer** (`demo/git/`, `src/git.rs`, `src/git_wasm.rs`) — in-browser Git repository browser backed by
  `isomorphic-git`.  Supports a repo grid view and a detail panel (branches, tags, commits, tracked files).
- **NIP-34 helpers** (`src/nip34.rs`, `demo/shared/git-remote-nostr.mjs`) — parse and construct `nostr://` clone
  URLs, `naddr` coordinates, and `p2p://` transport URLs.
- **WASM bindings** — the consensus engine, Git helpers, and libp2p node are all exposed to the browser via
  `wasm-bindgen`.
- **Local server** (`src/bin/nostr-dag-server.rs`) — serves `site/` with correct MIME types (`.mjs` → `text/javascript`)
  and exposes `/events`, `/peers`, and static asset routes.

## Perfect IP (PIP) / NIP-PIP

The project’s data transfer protocol is formalized as **Perfect IP (PIP)**, also referred to here as
**NIP-PIP**.  PIP specifies the wire format for:

- libp2p ↔ Nostr bridge envelopes on the `nostr-dag-bridge` topic
- transfer manifest events (`kind:39078`)
- transfer slice events (`kind:39079`)
- validation and reconstruction rules for multi-slice payloads

See [`./PIP.md`](./PIP.md) for the full specification.

## Project layout

```
src/
  dag.rs               Core DAG consensus engine
  event.rs             Kind 21000 ack event helpers
  store.rs             SQLite relational store (native)
  p2p.rs               Dual-target libp2p node (native + WASM)
  nip34.rs             NIP-34 nostr:// URL helpers
  git.rs               Native git2 helpers
  git_wasm.rs          WASM isomorphic-git bindings
  lib.rs               Public API + WASM entry points
  bin/
    federation.rs      Federation daemon (watches relay, publishes acks)
    relay.rs           Embedded Nostr relay for local demo
    keygen.rs          Demo key + startup command generator
    nostr-dag-server.rs  Local static/API server
    git-info.rs        CLI git info helper
    p2p-node.rs        Standalone native libp2p peer CLI

demo/
  index.html           Main browser frontend (DAG + bridge)
  git/index.html       Git viewer
  git/blame.html       Git blame view
  bridge/index.html    libp2p bridge page
  bridge/relay.html    Bridge relay page
  shared/              Shared browser modules (source of truth)
    dag-db.mjs         Browser IndexedDB store
    bridge-page.mjs    libp2p ↔ Nostr bridge logic
    libp2p-stack.mjs   Browser libp2p transport stack
    git-refs.mjs       Git ref helpers
    git-progress.mjs   isomorphic-git progress helpers
    git-remote-nostr.mjs  NIP-34 clone URL helpers
    page-header.mjs    Shared page header/nav chrome
    logger-footer.js   Batched log footer
    page-path.js       resolveHref() for Pages-safe URLs
    page.css           Shared stylesheet
  run.sh               Demo launcher

site/                  Generated Pages output (do not hand-edit)
test/                  Node.js test suite (*.test.mjs)
```

## Build, test, and site commands

```bash
# Rust library + native binaries
just build          # cargo build --features native
just test           # test-native + test-js
just test-native    # cargo test --features native
just test-js        # node --test test/*.test.mjs

# WASM package → site/pkg
just wasm

# Full static site (WASM + demo assets → site/)
just site

# Local preview server (builds site first)
just server

# Start relay + 5 federation daemons
just demo

# Start the standalone native peer CLI
cargo run --features p2p --bin p2p-node

# Publish a PIP / NIP-PIP blob from the native peer
#   /pip <message>

# Run the native↔wasm PIP integration test
node --test test/p2p-native-wasm.test.mjs

# The deterministic test identities come from fixed SHA-256 labels:
#   - `nostr-dag-native` → native libp2p / Nostr seed
#   - `nostr-dag-wasm`   → WASM libp2p seed
# These are preimages for reproducible test keys, not secrets.
# To verify a label locally:
#   `printf 'nostr-dag-wasm' | shasum -a 256`

# Safari variant of the same test (macOS only):
#   1. Safari → Settings → Advanced → show the Develop menu.
#   2. Develop → Allow Remote Automation.
#   3. If WebDriver still refuses to start, run `safaridriver --enable` once.
# The test auto-detects whether Safari remote automation is enabled and logs a
# short skip message if it is not.

# Optional: override the bootstrap peer list used for relay/hole-punch setup
P2P_BOOTSTRAP="/ip4/host/tcp/port/p2p/..." cargo run --features p2p --bin p2p-node

# Or use Make equivalents
make build / test / wasm / site / server / demo
```

## Workflow

1. `just site` builds the WASM package and copies `demo/` assets into `site/`.
2. `just server` starts the local preview server at `http://localhost:PORT`.
3. `just demo` launches the embedded relay and five federation daemons.
4. Open `http://localhost:PORT` in a browser, click **Connect**, send messages, watch them transition from pending (gray) to canonical (green) as acks arrive.

> **Note:** Always edit browser UI in `demo/`; regenerate `site/` with `just site`.  Never hand-edit `site/` directly.

## Key conventions

- `resolveHref()` (`demo/shared/page-path.js`) must be used for all asset and navigation URLs so the app works on both the local server and GitHub Pages.
- Shared browser helpers live in `demo/shared/` and are copied verbatim to `site/shared/` during the site build.
- The local server treats `BrokenPipe` / `ConnectionReset` / `UnexpectedEof` as normal client disconnects (trace level).
- Full event IDs and pubkeys are never truncated in the UI.
- The bridge relay verification samples at most two relays per event and uses cache/backoff to avoid rate-limiting.

## Dependencies

- [rust-nostr](https://github.com/rust-nostr/nostr) SDK (`nostr`, `nostr-relay-pool`)
- [libp2p](https://github.com/libp2p/rust-libp2p) 0.54 (native TCP/mDNS/gossipsub + WASM WebSocket)
- [rusqlite](https://github.com/rusqlite/rusqlite) with bundled SQLite (native store)
- [git2](https://github.com/rust-lang/git2-rs) (native Git helpers)
- [wasm-bindgen](https://github.com/rustwasm/wasm-bindgen) + [wasm-pack](https://github.com/rustwasm/wasm-pack)
