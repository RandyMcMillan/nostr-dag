# Perfect IP (PIP) / NIP-PIP

`nostr-dag` formalizes its data transfer protocol as **Perfect IP (PIP)**, also referred to in this repository as
**NIP-PIP**.  This document defines the canonical wire formats and validation rules used when the project moves Nostr
events and larger payloads between libp2p peers and Nostr relays.

PIP is descriptive of the current protocol implemented in `src/p2p.rs` and the browser bridge in
`demo/shared/bridge-page.mjs`.  Where field names and topic names already exist on the wire, they remain normative for
compatibility.

## 1. Scope

PIP covers two related transports:

1. **Bridge envelopes** for moving complete Nostr events across the shared libp2p gossip topic
2. **Transfer events** for splitting and reconstructing larger payloads across Nostr events

PIP does **not** redefine the Nostr event format itself; the embedded `event` object remains a standard Nostr event.

## 2. Terminology

- **Bridge envelope** — a JSON object carried over libp2p that wraps a standard Nostr event plus routing metadata
- **Manifest event** — a Nostr event describing the root identifier, SHA-256 digest, size, packet count, tree depth,
  MTU, encoding, and path for a multi-slice payload
- **Slice event** — a Nostr event containing one packet slice from the recursive packet tree
- **Root ID** — an application-defined identifier shared by all manifest and slice events belonging to the same payload
- **Relay hints** — a deduplicated list of relay URLs that may be used when forwarding or publishing events

## 3. Protocol constants

The following identifiers are normative:

- Bridge topic / bridge protocol string: `nostr-dag-bridge`
- Transfer protocol string: `nostr-dag-transfer`
- Bridge version: `"1"` (string)
- Transfer version: `1` (integer)
- Transfer ACK / NAK kind: `39076`
- Transfer request kind: `39077`
- Transfer manifest kind: `39078`
- Transfer slice kind: `39079`
- PIP Blob Attestation kind: `39080`
- PIP Quorum Seal kind: `39081`
- PIP Quorum Membership kind: `39082`

## 4. Bridge envelope

Bridge envelopes are JSON objects published on the `nostr-dag-bridge` libp2p gossip topic.

### 4.1 Canonical shape

```json
{
  "protocol": "nostr-dag-bridge",
  "version": "1",
  "direction": "nostr->libp2p",
  "event": { "id": "...", "pubkey": "...", "kind": 1, "tags": [], "content": "", "sig": "..." },
  "relay_hints": ["wss://relay.example"],
  "topic": "nostr-dag-bridge",
  "ts": 1724544000000
}
```

### 4.2 Required fields

- `protocol` — MUST be `nostr-dag-bridge`
- `version` — MUST be `"1"`
- `direction` — SHOULD describe the forwarding direction such as `nostr->libp2p` or `libp2p->nostr`
- `event` — MUST be a valid Nostr event object
- `relay_hints` — SHOULD be an array of relay URLs; implementations SHOULD deduplicate and discard empty values

### 4.3 Compatibility rules

- Consumers MAY accept a raw Nostr event without an envelope for backward compatibility
- Consumers MAY accept alternate relay hint field spellings (`relayHints`, `relays`, `relayTargets`) when decoding
- Consumers MUST reject an envelope whose `protocol` is present and is not `nostr-dag-bridge`
- Producers SHOULD include `topic` and `ts` for observability, but these fields are informational

## 5. Transfer manifest events

Manifest events are Nostr events with `kind` `39078`.  Their `content` is a JSON object with the following shape:

```json
{
  "protocol": "nostr-dag-transfer",
  "version": 1,
  "type": "manifest",
  "root": "root-1",
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "size": 1024,
  "packets": 15,
  "depth": 3,
  "mtu": 512,
  "encoding": "json",
  "path": ""
}
```

### 5.1 Required fields

- `protocol` — MUST be `nostr-dag-transfer`
- `version` — MUST be integer `1`
- `type` — MUST be `manifest`
- `root` — MUST be a string
- `sha256` — MUST be a lowercase hex SHA-256 of the full reconstructed payload
- `size` — MUST be a non-negative integer (total bytes of the payload)
- `packets` — MUST be a non-negative integer (total slices including parity)
- `depth` — MUST be a non-negative integer (maximum tree depth)
- `mtu` — MUST be a non-negative integer (threshold used for leaf sizing)
- `encoding` — MUST be a string (e.g. `"json"`)
- `path` — MUST be a string (relative path when walking a directory; empty for single blobs)

## 6. Transfer slice events

Slice events are Nostr events with `kind` `39079`.  Their `content` is a JSON object with the following shape:

```json
{
  "protocol": "nostr-dag-transfer",
  "version": 1,
  "type": "slice",
  "id": "root-1.0.0",
  "header": {"seq_num": 0, "total_packets": 15},
  "data": [1, 2, 3, 4],
  "is_parity": false
}
```

Each slice event MUST also include an `e` tag referencing the manifest event it belongs to.

### 6.1 Required fields

- `protocol` — MUST be `nostr-dag-transfer`
- `version` — MUST be integer `1`
- `type` — MUST be `slice`
- `id` — MUST be a recursive packet identifier (e.g. `ROOT.0.0` or `ROOT.0.P`)
- `header` — MUST contain:
  - `seq_num` — zero-based sequence number assigned during packetization
  - `total_packets` — total number of packets in the batch (data + parity)
- `data` — MUST be an array of integers in the byte range `0..=255`
- `is_parity` — MUST be `true` for parity slices, `false` for data slices

## 7. Packetization rules

Producers split payload bytes using a recursive binary tree:

1. If `data.len() <= mtu`, emit a single data slice (`is_parity: false`) with the current `id`
2. Otherwise:
   - Split the data in half
   - Recursively packetize the left half with `id + ".0"`
   - Recursively packetize the right half with `id + ".1"`
   - Emit a parity slice (`id + ".P"`) whose payload is the XOR of the left and right halves
3. `seq_num` is assigned monotonically during depth-first traversal
4. `total_packets` is set to the final batch size after traversal completes
5. Empty payloads still emit a single empty data slice so reconstruction remains well-defined

### 7.1 Parity calculation

Parity between two buffers is computed bytewise with XOR.  If the buffers differ in length, the shorter buffer is
treated as padded with zeroes:

```rust
fn calculate_parity(left: &[u8], right: &[u8]) -> Vec<u8> {
    let max_len = left.len().max(right.len());
    let mut parity = vec![0; max_len];
    for i in 0..max_len {
        let l = if i < left.len() { left[i] } else { 0 };
        let r = if i < right.len() { right[i] } else { 0 };
        parity[i] = l ^ r;
    }
    parity
}
```

## 8. Reconstruction rules

Consumers reconstruct payloads by collecting data slices (`is_parity: false`), ordering them by `seq_num`, and
concatenating their `data` arrays.

Consumers MUST reject reconstruction when:

- slices for different `root` values are mixed together
- slices disagree on `total_packets`
- any byte value falls outside `0..=255`

Consumers MAY use parity slices to recover missing data slices when one sibling and the parent parity are both
available.  Recovery is the same XOR operation: `missing = sibling XOR parity`.

Consumers MAY treat an empty slice set as an empty payload.

## 9. Transfer request events

Request events are Nostr events with `kind` `39077`.  Their `content` is a JSON object that asks a peer to publish a
manifest for a specific payload, or to re-send missing slices.

### 9.1 Canonical shape

```json
{
  "protocol": "nostr-dag-transfer",
  "version": 1,
  "type": "request",
  "request_id": "req-abc123",
  "root_id": "root-1",
  "want": ["ROOT.0.0.P", "ROOT.1.1.0"],
  "range": { "offset": 0, "limit": 8 }
}
```

### 9.2 Required fields

- `protocol` — MUST be `nostr-dag-transfer`
- `version` — MUST be integer `1`
- `type` — MUST be `request`
- `request_id` — MUST be a unique string generated by the requester
- `root_id` — MUST be the string identifying the payload the requester wants

### 9.3 Optional fields

- `want` — array of missing packet ids the requester needs (gnostr repair-request style)
- `range` — MAY contain:
  - `offset` — zero-based slice index to start from (default `0`)
  - `limit` — maximum number of slices to return (default `total_packets`)
- `manifest_id` — MAY reference a specific known manifest event id

### 9.4 Behavior

- Producers that hold the requested payload SHOULD respond by publishing the manifest (kind 39078) and the requested
  slices (kind 39079) on the same topic.
- Producers SHOULD include the `request_id` in the manifest `metadata` field so the requester can correlate the
  response.
- If the producer does not hold the payload, it MUST silently ignore the request.

## 10. Transfer ACK / NAK events

ACK and NAK events are Nostr events with `kind` `39076`.  They let a consumer tell a producer which slices were
received or missed.

### 10.1 Canonical shape

```json
{
  "protocol": "nostr-dag-transfer",
  "version": 1,
  "type": "ack",
  "root_id": "root-1",
  "manifest_id": "<hex event id of the manifest event>",
  "received": [0, 1, 2, 4],
  "missing": [3, 5, 6, 7]
}
```

### 10.2 Required fields

- `protocol` — MUST be `nostr-dag-transfer`
- `version` — MUST be integer `1`
- `type` — MUST be `ack` or `nak`
- `root_id` — MUST match the manifest `root`
- `manifest_id` — MUST be the hex event id of the manifest

### 10.3 Optional fields

- `received` — array of `seq_num` values the consumer already has
- `missing` — array of `seq_num` values the consumer still needs

### 10.4 Behavior

- Producers SHOULD re-send any slices listed in `missing`.
- A `type: "nak"` with only `missing` and no `received` is equivalent to a full re-request.
- Producers MAY cap re-send volume to avoid amplification attacks.

## 11. Error handling

Implementations SHOULD surface validation failures as explicit protocol errors.  The current Rust implementation
distinguishes:

- unsupported event kind
- invalid transfer payload
- missing required field
- invalid bridge envelope
- JSON decoding failure

## 12. Security and interoperability notes

- PIP relies on standard Nostr event signatures for authenticity of embedded events
- Relay hints are advisory and MUST NOT be treated as proof of origin or trust
- Unknown bridge envelope metadata fields SHOULD be ignored unless they change protocol validity
- Producers and consumers SHOULD preserve the normative protocol strings and versions exactly as specified here for
  interoperability

## 13. Reference implementation

The repository's current reference implementation lives in:

- `src/p2p.rs`
- `demo/shared/bridge-page.mjs`

Any future protocol change should update both the implementation and this document together.

## 14. Quorum attestation of PIP blobs

This section defines the three event kinds and lifecycle used when a DAG quorum collectively
verifies and signs a PIP blob.

### 14.1 Overview

The quorum attestation flow has three phases:

1. **Attest** — each participant independently reconstructs the blob from its manifest and
   slice events, verifies the SHA-256 digest, and publishes an *attestation event*.
2. **Seal** — once attestations from more than 4/5 of the current participant set have been
   collected, any participant publishes a *seal event* referencing all attestation event ids.
3. **Join** — new participants may join an already-sealed quorum by publishing a *join event*
   that references the seal and proves they verified the same blob.  Membership grows and the
   4/5 threshold is recalculated accordingly.

### 14.2 New event kinds

| Kind  | Name                   | Constant           |
|-------|------------------------|--------------------|
| 39080 | PIP Blob Attestation   | `PIP_ATTEST_KIND`  |
| 39081 | PIP Quorum Seal        | `PIP_SEAL_KIND`    |
| 39082 | PIP Quorum Membership  | `PIP_JOIN_KIND`    |

### 14.3 Attestation event (kind 39080)

```json
{
  "protocol": "nostr-dag-transfer",
  "version": 1,
  "type": "attest",
  "root_id": "<manifest root>",
  "sha256": "<lowercase hex sha256 of reconstructed blob>",
  "manifest_id": "<hex event id of the manifest event>"
}
```

The event MUST carry `e` tags referencing the manifest event id and every slice event id.

### 14.4 Seal event (kind 39081)

```json
{
  "protocol": "nostr-dag-transfer",
  "version": 1,
  "type": "seal",
  "root_id": "<manifest root>",
  "sha256": "<lowercase hex sha256>",
  "attest_ids": ["<hex attestation event id>", ...]
}
```

`attest_ids` MUST list exactly the attestation event ids that contributed to reaching
the threshold.

### 14.5 Membership (join) event (kind 39082)

```json
{
  "protocol": "nostr-dag-transfer",
  "version": 1,
  "type": "join",
  "root_id": "<manifest root>",
  "sha256": "<lowercase hex sha256>",
  "seal_id": "<hex event id of the quorum seal>"
}
```

The event MUST carry an `e` tag referencing the seal event id.  A join event MUST be
rejected if no seal event exists yet or if `seal_id` does not match the sealed event.

### 14.6 Threshold rule

Given N total participants the threshold T is computed as:

```
T = ceil(N × 4 / 5) − 1
```

A quorum is reached when the number of accepted attestations is strictly greater than T
(i.e., at least `ceil(N × 4 / 5)` attestations).  T is recalculated whenever new members
join via kind 39082.

### 14.7 Reference implementation

The Rust implementation lives in:

- `src/quorum.rs` — `BlobQuorum` struct
- `src/event.rs` — `create_attest_event`, `create_seal_event`, `create_join_event`
- `src/dag.rs` — `Dag::add_participant`
