# Decentralized Git Viewer via libp2p

## Objective
Replace the centralized CORS proxy (`cors.isomorphic-git.org`) and GitHub HTTP dependency with peer-to-peer git transport using our native `p2p-node.rs` and browser libp2p stack.

---

## Architecture

```
┌─────────────────┐     gossipsub (nostr-dag-bridge)     ┌─────────────────┐
│  Browser (WASM) │ ◄──────────────────────────────────► │  Native peer    │
│                 │   manifest (kind 39078)              │  (p2p-node.rs)  │
│  GitP2PTransport│   slices   (kind 39079)              │                 │
│                 │                                        │  git mirror     │
│  LightningFS    │                                        │  bundle create  │
│  isomorphic-git │                                        │  packetize      │
└─────────────────┘                                        └─────────────────┘
```

---

## Phase 1 — Native Peer Becomes a Git Mirror ✅

The native `p2p-node.rs` reads `GIT_MIRROR_REPOS` (comma-separated URLs) on
startup, clones each repo using `git2`, creates a `git bundle`, packetizes it
via `packetize_payload()`, and publishes a PIP manifest + slices on the
`nostr-dag-bridge` gossipsub topic.  Re-mirroring happens every 5 minutes.

Key code:
- `src/p2p_node.rs` lines ~150–180 — mirror startup & periodic re-mirror
- `src/p2p_node.rs` `mirror_repo_bundle()` — `git clone --mirror` + `git bundle create`
- `src/p2p.rs` `encode_payload_as_transfer_events_chained()` — manifest + slice event builder

---

## Phase 2 — Browser Peer Requests Git via libp2p ✅

`demo/shared/git-p2p-transport.mjs` subscribes to `nostr-dag-bridge`, indexes
incoming manifests by repo URL, and accumulates slices.  `requestBundle(url)`
waits until all slices arrive, calls `reconstructPayload()`, and returns the
bundle bytes.

Key code:
- `demo/shared/git-p2p-transport.mjs` — `GitP2PTransport` class
- `demo/shared/nip34-quorum.mjs` — `parseTransferEvent()`, `reconstructPayload()`

---

## Phase 3 — Bundle → isomorphic-git ✅

Instead of implementing a full git smart-HTTP stream from bundle bytes (which
would require re-implementing `git-upload-pack` negotiation), the viewer takes
a simpler path:

1. `requestBundle()` returns raw bundle bytes.
2. Bytes are written to LightningFS at `/bundles/{repo}.bundle`.
3. `createBundleHttpClient()` (in `demo/shared/git-bundle-http.mjs`) parses the
   bundle header, serves refs advertisement for `info/refs?service=git-upload-pack`,
   and streams the packfile for `git-upload-pack` POST.
4. `isomorphic-git.clone()` uses this custom HTTP client with `url: 'bundle://local'`.

This avoids the complexity of smart-HTTP state machines while still allowing
isomorphic-git to clone from a peer-provided bundle.

Key code:
- `demo/shared/git-bundle-http.mjs` — `createBundleHttpClient()`
- `demo/git/index.html` `ensureRepo()` lines ~528–570 — bundle fetch + clone

---

## Phase 4 — Integrate & Fallback ✅

`demo/git/index.html` and `blame.html` import `git-p2p-transport.mjs`.
`ensureRepo()` tries libp2p first:

1. Check `transport.hasRepo(url)`.
2. If yes, call `transport.requestBundle(url, 15000)`.
3. On success, clone from bundle and set `repoSource.set(repo.name, 'p2p')`.
4. On failure (timeout, missing slices, etc.), fall back to the CORS proxy
   and set `repoSource.set(repo.name, 'proxy')`.

The repo card renders a green **p2p** pill or grey **proxy** pill so the user
knows which path was used.

Key code:
- `demo/git/index.html` `ensureRepo()` lines ~521–600
- `demo/shared/page.css` `.pill-source-p2p` / `.pill-source-proxy`

---

## Remaining Work

- **Smart-HTTP interception:** `GitP2PTransport.getHttpClient()` has a TODO
  for converting bundle bytes into a git smart-HTTP response.  This is *not*
  used by the current viewer because `createBundleHttpClient()` is simpler and
  works.  It is kept for future use if we want transparent interception of
  every isomorphic-git HTTP request.
- **DCUtR hole punching:** The browser stack already enables `dcutr`, but
  verification across NATs (GH Pages → home router → laptop) is hard to
  automate.  Manual testing shows the path works via circuit relay.
- **On-demand slice requests:** Currently the native peer publishes all slices
  proactively.  A request/response protocol (browser asks for missing slices
  by sequence number) would reduce bandwidth for large repos.

---

## Deliverables

| File | Role |
|------|------|
| `src/p2p_node.rs` | Native peer git mirror mode |
| `src/p2p.rs` | PIP packetize / reconstruct / event builders |
| `demo/shared/git-p2p-transport.mjs` | Browser-side libp2p git transport |
| `demo/shared/git-bundle-http.mjs` | Bundle → smart-HTTP adapter for isomorphic-git |
| `demo/git/index.html` + `blame.html` | libp2p-first clone with HTTP fallback |
