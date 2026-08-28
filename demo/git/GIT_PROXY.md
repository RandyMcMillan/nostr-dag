# Plan: Decentralized Git Viewer via libp2p

## Objective
Replace the centralized CORS proxy (`cors.isomorphic-git.org`) and GitHub HTTP dependency with peer-to-peer git transport using our native `p2p-node.rs` and browser libp2p stack.

---

## Phase 1 — Native Peer Becomes a Git Mirror

**Goal:** The native `p2p-node.rs` maintains local clones and advertises them as PIP bundles over gossipsub.

| Step | Action |
|------|--------|
| 1.1 | Add a `git-mirror` config/mode to `p2p-node.rs` that reads a list of repo URLs to mirror |
| 1.2 | On startup, native peer clones each repo to local disk using `git2` (native feature) |
| 1.3 | Periodically (or on-demand), create a `git bundle` of each mirrored repo |
| 1.4 | Compute bundle SHA-256 and packetize via existing `packetize_payload()` |
| 1.5 | Publish a PIP **transfer manifest** (kind 39078) on `nostr-dag-bridge` gossipsub topic advertising the bundle |
| 1.6 | Listen for slice requests and publish PIP **transfer slices** (kind 39079) |

**Reuses existing code:** `git_bare_pip_tests` in `src/p2p.rs` already does the bundle -> packetize -> transfer flow.

---

## Phase 2 — Browser Peer Requests Git via libp2p

**Goal:** The browser discovers available git bundles from peers and requests them.

| Step | Action |
|------|--------|
| 2.1 | Create `demo/shared/git-p2p-transport.mjs` — a module that wraps the libp2p stack |
| 2.2 | Subscribe to `nostr-dag-bridge` and index incoming PIP manifests by repo URL |
| 2.3 | When the git viewer needs a repo, check the manifest index first |
| 2.4 | If a peer advertises the repo, send a request message (with `request_id`) on gossipsub |
| 2.5 | Collect slices, reconstruct the bundle via `reconstruct_payload()` |
| 2.6 | Unpack the bundle into LightningFS using isomorphic-git |

---

## Phase 3 — Custom isomorphic-git Transport

**Goal:** Make isomorphic-git use libp2p instead of HTTP for fetch/clone operations.

| Step | Action |
|------|--------|
| 3.1 | Implement a custom `http` client for isomorphic-git that routes git-upload-pack requests through libp2p |
| 3.2 | For `git.clone()` / `git.fetch()`: if a peer has the repo, stream the bundle instead of using CORS proxy |
| 3.3 | For `git.listServerRefs()`: query the peer for refs via gossipsub, or fall back to HTTP |
| 3.4 | Export the transport from `git-p2p-transport.mjs` as a drop-in replacement for `isomorphic-git/http/web` |

---

## Phase 4 — Integrate & Fallback

**Goal:** Wire the git viewer to use libp2p when available, HTTP when not.

| Step | Action |
|------|--------|
| 4.1 | Update `demo/git/index.html` and `blame.html` to import `git-p2p-transport.mjs` alongside the HTTP client |
| 4.2 | Modify `ensureRepo()` and `fetchRepoRefs()` to try libp2p first, then fall back to `cors.isomorphic-git.org` after a timeout |
| 4.3 | Add UI indicator showing whether a repo is being fetched from peers or from GitHub directly |
| 4.4 | End-to-end test: start `p2p-node` native peer, open browser git viewer, verify clone works without CORS proxy |

---

## Deliverables

- `src/bin/p2p-node.rs` — git mirror mode
- `demo/shared/git-p2p-transport.mjs` — browser-side libp2p git transport
- Updated `demo/git/index.html` + `blame.html` — libp2p-first with HTTP fallback
