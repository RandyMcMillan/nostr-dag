# NIP-PIP Git Transport Specification

**Status:** Draft  
**Objective:** Replace centralized CORS proxies with peer-to-peer git bundle
distribution over Nostr + libp2p.

## Problem

- Browsers cannot talk to GitHub/GitLab smart-HTTP endpoints directly because
  CORS headers are missing.
- Public CORS proxies are a single point of failure and can rate-limit or
  disappear.
- We want git cloning to work on GitHub Pages without any external proxy
  dependency.

## Solution Overview

A native `p2p-node` peer mirrors git repos, creates bundles, and publishes them
as NIP-PIP (Nostr Packetised Payload) events.  Browsers discover the peer via
libp2p gossipsub or Nostr relay presence broadcasts, reconstruct the bundle,
and clone from it locally.

```
┌─────────────┐     NIP-PIP gossipsub    ┌──────────────┐
│  p2p-node   │ ◄──────────────────────► │ browser/WASM │
│  (native)   │   manifest + slices      │  (git viewer)│
└──────┬──────┘                          └──────┬───────┘
       │                                         │
       │ git clone / bundle create               │ clone from bundle
       ▼                                         ▼
┌─────────────┐                          ┌──────────────┐
│  GitHub     │                          │  LightningFS │
│  (upstream) │                          │  (in-browser)│
└─────────────┘                          └──────────────┘
```

## Event Kinds

| Kind | Name | Purpose |
|------|------|---------|
| 39078 | `TRANSFER_MANIFEST_KIND` | Advertises a payload: size, packet count, SHA-256, repo URL (`path`). |
| 39079 | `TRANSFER_SLICE_KIND` | Carries one packet of the payload. Linked to manifest via `e` tag. |
| 39080 | `PIP_ATTEST_KIND` | Attestation that a peer reconstructed the blob and verified its hash. |
| 39081 | `PIP_SEAL_KIND` | Quorum seal once enough attestations exist. |
| 39082 | `PIP_JOIN_KIND` | New member joining an existing sealed quorum. |

## Manifest Event (kind 39078)

Content JSON:

```json
{
  "protocol": "nostr-dag-transfer",
  "version": 1,
  "type": "manifest",
  "root": "<deterministic root id>",
  "sha256": "<hex sha256 of full payload>",
  "size": 123456,
  "packets": 42,
  "depth": 3,
  "mtu": 256,
  "encoding": "json",
  "path": "https://github.com/owner/repo"
}
```

- `path` is the repo URL so browsers can index manifests by repo.
- `root` is a deterministic identifier derived from the publisher key and
  timestamp.

## Slice Event (kind 39079)

Content JSON:

```json
{
  "protocol": "nostr-dag-transfer",
  "version": 1,
  "type": "slice",
  "id": "<packet tree node id>",
  "header": { "seq_num": 0, "total_packets": 42 },
  "data": [255, 0, 1, ...],
  "is_parity": false
}
```

Tags:

```json
[["e", "<manifest event id>"]]
```

### Deterministic chain extension

Each slice should also reference the **previous slice** (or the manifest for
slice 0) in its `e` tags, producing a verifiable chain:

```json
[["e", "<manifest event id>"], ["e", "<previous slice event id>"]]
```

This makes the sequence tamper-evident and allows incremental verification.

## Native Peer: Git Mirror Mode

The native `p2p-node` binary supports automatic repo mirroring via the
`GIT_MIRROR_REPOS` environment variable:

```bash
GIT_MIRROR_REPOS="https://github.com/RandyMcMillan/nostr-dag,https://github.com/isomorphic-git/isomorphic-git" \
  cargo run --bin p2p-node --features p2p
```

On startup (and every 5 minutes) the peer:

1. Clones the repo into `.nostr-dag-mirrors/{sha256-of-url}/`
2. Runs `git bundle create --all`
3. Reads the bundle bytes
4. Calls `publish_pip_payload` to packetize and broadcast

## Browser: Bundle Reception

`demo/shared/git-p2p-transport.mjs` implements the browser-side listener:

1. Subscribe to `nostr-dag-bridge` gossipsub topic.
2. On manifest (kind 39078): index by `path` (repo URL).
3. On slice (kind 39079): accumulate under the manifest.
4. Once all slices arrive, reconstruct the payload.
5. Write the bundle to LightningFS.
6. Clone from the bundle using `createBundleHttpClient`.

## Browser: Fallback Strategy

The git viewer uses this priority order:

1. **Local bundle cache** — if the repo was already fetched in this session.
2. **libp2p PIP bundle** — if a peer has advertised the repo.
3. **Local CORS proxy** — `http://127.0.0.1:3000/proxy/` (localhost only).
4. **Public CORS proxies** — `cors.isomorphic-git.org`, `corsproxy.io`.

Over time we want (2) to replace (3) and (4) entirely.

## Phase 1 (Native) — Status: Implemented

- [x] `GIT_MIRROR_REPOS` env var support
- [x] `mirror_repo_bundle` clones and bundles repos
- [x] `publish_pip_payload` broadcasts manifest + slices over gossipsub
- [x] Periodic re-mirror every 5 minutes

## Phase 2 (Browser) — Status: Partial

- [x] `GitP2PTransport` listens for manifest/slice events
- [x] `createBundleHttpClient` serves bundle bytes to isomorphic-git
- [ ] Wire `GitP2PTransport` into `demo/git/index.html` as primary fetch path
- [ ] Show UI indicator when a repo is being fetched from peers vs proxy
- [ ] Handle partial bundles / incremental updates
- [ ] Add parent-event `e` tag chaining to slices

## Phase 3 (Integration)

- [ ] Native peer responds to slice re-requests (ACK/NAK per slice)
- [ ] Range/limit field in manifest for partial bundles
- [ ] RTT tracking tags on all PIP events
- [ ] Quorum attestation for bundle integrity (kind 39080-39082)

## Security Notes

- Bundle SHA-256 in the manifest lets browsers verify integrity before cloning.
- Quorum attestations (kind 39080) provide decentralised integrity checks.
- The `path` field in the manifest binds the payload to a specific repo URL,
  preventing substitution attacks.

## References

- [isomorphic-git CORS proxy reference](https://gist.githubusercontent.com/RandyMcMillan/cbe978f175e69a499898a6786430040d/raw/8ea88a09dfc925cda7a83e28e92059266e7ab67b/isomorphic-git-cors-proxy.js)
- [gnostr NIP-PIP types](https://github.com/gnostr-org/gnostr/tree/4bd5d9cd1866c824eee7a168ff84187646960172/types/src/nostr/pip.rs)
- [gnostr NIPs commit](https://github.com/gnostr-org/gnostr-nips/commit/0000003bfafd14dc9f5e319f1d05104d5856a148)
