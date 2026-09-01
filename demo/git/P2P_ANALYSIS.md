# P2P Gap Analysis: `/bridge/` vs `/git/`

## Executive Summary

The `/git/` page is a **passive consumer** of P2P bundles. The `/bridge/` page is an **active network participant**. Until the git page does the same discovery, presence broadcast, and fallback dialing that the bridge does, it will always have fewer peers and slower bundle resolution.

---

## 1. Libp2p Stack Initialization

### `/bridge/` (bridge-page.mjs:1796-1836)
```
Config attempt 1: { includeWebRTC: true,  includeWebRTCDirect: false, includeCircuitRelay: true }
Config attempt 2: { includeWebRTC: true,  includeWebRTCDirect: false, includeCircuitRelay: false }
Config attempt 3: { includeWebRTC: false, includeWebRTCDirect: false, includeCircuitRelay: false }
```
The bridge tries **three transport configurations** and falls back to WebSocket-only if WebRTC fails. This is critical on GH Pages where mixed-content blocks `ws://` dials and WebRTC may be the only path.

### `/git/` (git/index.html:181)
```javascript
const { node } = await createSharedLibp2pStack({ onLog, onPeer });
```
The git page calls `createSharedLibp2pStack()` with **zero options**. It gets whatever the default is (WebRTC + WebSocket + circuit relay). If that default fails on a given browser/network, there is **no fallback attempt**.

**Impact**: On GH Pages (HTTPS) the default stack may fail because `ws://localhost` is blocked by mixed-content policy, and without the WebSocket-only fallback the node never starts.

---

## 2. Deterministic Peer Identity

### `/bridge/`
```javascript
deterministicKeySeed: deterministicPeerKeyLabels[1] || 'nostr-dag-wasm'
```
The bridge derives a **stable peer ID** from a seed. Other peers (including the native server) can predict this ID and advertise it in Nostr presence events.

### `/git/`
No `deterministicKeySeed` passed. The git page generates a **random ephemeral peer ID** on every reload. No one can dial it proactively because its identity changes each time.

**Impact**: The native server cannot publish a deterministic route to the git-page peer. Relay-based presence queries (kind-0 metadata) cannot target it.

---

## 3. Pubsub Topic Subscription

### `/bridge/`
- Subscribes to the topic: `node.services.pubsub.subscribe(topic)`
- Listens for **all** pubsub messages, not just PIP events
- Parses bridge-protocol envelopes and handles them

### `/git/`
- `createGitP2PTransport` subscribes to the topic **only for PIP manifest/slice events**
- It does **not** listen for general peer presence or bridge-protocol messages
- It never publishes its own presence on the topic

**Impact**: The git page is invisible on the gossipsub mesh. Peers know it exists only if they happen to see a Nostr relay event it published (and even then, only for PIP requests).

---

## 4. Nostr Relay Integration Depth

### `/bridge/`
1. Subscribes to relays with `pool.subscribeMany([{ limit: 500 }])` — catches all events
2. **Queries deterministic native pubkeys** for presence (kind-0 metadata):
   ```javascript
   pool.querySync(relays, { kinds: [0], authors: [pubkey], limit: 3 })
   ```
3. **Broadcasts its own presence** on relays so native peers know where to dial
4. **Discovers new relays** from relay hints in events (`scheduleRelayDiscovery`)
5. **Polls `/peers`** every 2 seconds to get the local server's current peer list

### `/git/`
1. `createGitP2PTransport` opens a **narrow relay subscription**:
   ```javascript
   { kinds: [39078, 39079], limit: 100 }
   ```
   It only listens for PIP manifests and slices.
2. It **publishes PIP requests** (kind 39077) when a repo is needed.
3. It does **NOT**:
   - Query for peer presence
   - Broadcast its own presence
   - Discover new relays
   - Poll `/peers`

**Impact**: The git page relies entirely on "pull" (requesting a bundle and hoping someone responds). The bridge uses "push + pull" (broadcasting presence so peers know to stay connected, plus pulling when needed).

---

## 5. Peer Visibility / UI Feedback

### `/bridge/`
- Renders a **peer list** with connection state, protocols, RTT, multiaddrs
- User can see at a glance whether the local server is connected
- Peers are sorted with deterministic peers pinned to the top

### `/git/`
- No peer list whatsoever
- The only P2P indicator is a tiny `p2p` badge on the repo card (set by `repoCard` if `p2pAvailable` is true)
- User has no way to know whether any peer is online

**Impact**: When bundles fail to arrive, the user cannot tell whether (a) no peer has the repo, or (b) no peer is connected at all. Debugging is impossible.

---

## 6. Mixed-Content / GH Pages Specifics

### `/bridge/`
- On GH Pages (HTTPS), direct `ws://` dials to localhost are blocked
- Bridge falls back to **WebRTC** (browser-to-browser) and **relay-indirect** (Nostr relay gossip) for discovery
- If WebRTC also fails, it falls back to **WebSocket-only** with relay-based communication

### `/git/`
- `createGitP2PTransport` does use Nostr relays as a fallback for PIP events
- However, the **underlying libp2p node** may fail to start because it attempts `ws://` dials during bootstrap and throws
- There is no fallback config loop to catch this

**Impact**: On GH Pages the git page often ends up with `window.__gitViewerP2pTransport = null` (or a node that can't dial), silently falling back to proxy-only mode.

---

## Root Cause: Why `/git/` P2P is Worse

| Capability | `/bridge/` | `/git/` |
|------------|-----------|---------|
| Transport fallback loop | 3 configs | 1 config |
| Deterministic peer ID | Yes | No |
| General pubsub subscription | Yes | No (only PIP) |
| Presence broadcast | Yes | No |
| Peer presence query | Yes | No |
| Relay discovery | Yes | No |
| `/peers` polling | Every 2s | Never |
| Peer list UI | Full list | None |

The git page expects P2P to "just work" after calling `createSharedLibp2pStack()`, but libp2p in a browser requires active management: signaling, presence, relay gossip, and fallback configs. The bridge does all of this; the git page does none of it.

---

## Recommended Fixes (in priority order)

### P1: Make `initGitP2P()` mirror `bootBridge()`

Extract the bridge's P2P bootstrap logic into a shared module (`demo/shared/p2p-bootstrap.mjs`) that both pages call. It should:
1. Try the 3-config fallback loop
2. Use deterministic peer ID
3. Subscribe to pubsub topic
4. Start relay presence broadcast + query
5. Poll `/peers`

### P2: Render peer connectivity on `/git/`

Add a minimal peer-status panel to the git page (or reuse the bridge's `peer-list` component) so the user can see whether any peer is connected before hitting Refresh.

### P3: Broadcast git-page presence

When the git page loads, broadcast a lightweight presence event (kind 0 or a custom kind) on Nostr relays so native peers know a git consumer is online and can preemptively publish bundles.

### P4: Share one libp2p node across tabs

Both `/bridge/` and `/git/` create separate libp2p nodes. On the same origin they could share a single node via a SharedWorker or BroadcastChannel, reducing connection overhead and improving peer visibility.
