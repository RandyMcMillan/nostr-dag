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
- **Manifest event** — a Nostr event describing the root identifier, total byte length, and total slice count for a
  multi-slice payload
- **Slice event** — a Nostr event containing one ordered slice of a larger payload
- **Root ID** — an application-defined identifier shared by all manifest and slice events belonging to the same payload
- **Relay hints** — a deduplicated list of relay URLs that may be used when forwarding or publishing events

## 3. Protocol constants

The following identifiers are normative:

- Bridge topic / bridge protocol string: `nostr-dag-bridge`
- Transfer protocol string: `nostr-dag-transfer`
- Bridge version: `"1"` (string)
- Transfer version: `1` (integer)
- Transfer manifest kind: `39078`
- Transfer slice kind: `39079`

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
  "root_id": "root-1",
  "total_bytes": 1024,
  "total_slices": 8
}
```

### 5.1 Required fields

- `protocol` — MUST be `nostr-dag-transfer`
- `version` — MUST be integer `1`
- `type` — MUST be `manifest`
- `root_id` — MUST be a string
- `total_bytes` — MUST be a non-negative integer
- `total_slices` — MUST be a non-negative integer and describe the full slice count for the payload

## 6. Transfer slice events

Slice events are Nostr events with `kind` `39079`.  Their `content` is a JSON object with the following shape:

```json
{
  "protocol": "nostr-dag-transfer",
  "version": 1,
  "type": "slice",
  "root_id": "root-1",
  "seq": 0,
  "total_slices": 8,
  "data": [1, 2, 3, 4]
}
```

Each slice event MUST also include an `e` tag referencing the manifest event it belongs to.

### 6.1 Required fields

- `protocol` — MUST be `nostr-dag-transfer`
- `version` — MUST be integer `1`
- `type` — MUST be `slice`
- `root_id` — MUST be a string matching the manifest `root_id`
- `seq` — MUST be a zero-based integer sequence number
- `total_slices` — MUST match the manifest `total_slices`
- `data` — MUST be an array of integers in the byte range `0..=255`

## 7. Packetization rules

- Producers MUST split payload bytes into ordered slices
- `max_slice_bytes` less than `1` MUST be treated as `1`
- Empty payloads MUST still produce exactly one slice with:
  - `seq = 0`
  - `total_slices = 1`
  - `data = []`

## 8. Reconstruction rules

Consumers reconstruct payloads by ordering slices by `seq` and concatenating their `data` arrays.

Consumers MUST reject reconstruction when:

- the slice set is missing a sequence number
- the number of received slices does not equal `total_slices`
- slices for different `root_id` values are mixed together
- slices disagree on `total_slices`
- any byte value falls outside `0..=255`

Consumers MAY treat an empty slice set as an empty payload.

## 9. Error handling

Implementations SHOULD surface validation failures as explicit protocol errors.  The current Rust implementation
distinguishes:

- unsupported event kind
- invalid transfer payload
- missing required field
- invalid bridge envelope
- JSON decoding failure

## 10. Security and interoperability notes

- PIP relies on standard Nostr event signatures for authenticity of embedded events
- Relay hints are advisory and MUST NOT be treated as proof of origin or trust
- Unknown bridge envelope metadata fields SHOULD be ignored unless they change protocol validity
- Producers and consumers SHOULD preserve the normative protocol strings and versions exactly as specified here for
  interoperability

## 11. Reference implementation

The repository’s current reference implementation lives in:

- `src/p2p.rs`
- `demo/shared/bridge-page.mjs`

Any future protocol change should update both the implementation and this document together.
