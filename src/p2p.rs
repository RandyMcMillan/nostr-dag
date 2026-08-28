//! Dual-target libp2p node and Perfect IP (PIP) reference implementation.
//!
//! * `#[cfg(feature = "p2p")]`       — native Tokio-based `SwarmHandle`
//! * `#[cfg(feature = "p2p-wasm")]`  — WASM `P2pNode` (`#[wasm_bindgen]`)
//!
//! Both expose the same logical interface:
//! * `broadcast(msg)` — publish a UTF-8 message on the nostr-dag gossipsub topic
//! * subscribe / `on_message(cb)` — receive messages from peers
//!
//! This module also defines the wire format for the repository's data transfer protocol,
//! **Perfect IP (PIP)** / **NIP-PIP**:
//!
//! * bridge envelopes on the `nostr-dag-bridge` topic
//! * transfer manifest events (`kind:39078`)
//! * transfer slice events (`kind:39079`)
//! * payload packetization and reconstruction rules
//!
//! The repository-level specification lives in `PIP.md`.  The constants and helpers in this
//! module are the normative implementation used by both native and browser peers.

// ---------------------------------------------------------------------------
// Shared constant
// ---------------------------------------------------------------------------

/// Gossipsub topic and bridge protocol identifier used by all PIP peers (native and WASM).
pub const NOSTR_DAG_TOPIC: &str = "nostr-dag-bridge";
pub const NETWORK_TIME_PROTOCOL: &str = "nostr-dag-network-time";
pub const NETWORK_TIME_VERSION: u64 = 1;

/// PIP Nostr event kind used for transfer manifests.
pub const TRANSFER_MANIFEST_KIND: nostr::Kind = nostr::Kind::Custom(39078);
/// PIP Nostr event kind used for transfer slices.
pub const TRANSFER_SLICE_KIND: nostr::Kind = nostr::Kind::Custom(39079);

// Stable SHA-256 preimage material for the native test identity.
// The `nostr-dag-native` label hashes to the 32-byte Ed25519 seed used here.
// Verify locally with: `printf 'nostr-dag-native' | shasum -a 256`
const DETERMINISTIC_NATIVE_LIBP2P_SEED_HEX: &str =
    "0401a34dbb8fd5fee2ffd914b184de1b89e78df8c76b68b01cf941570be8b872";
#[cfg(all(feature = "p2p-wasm", target_arch = "wasm32"))]
// Stable SHA-256 preimage material for the WASM test identity.
// The `nostr-dag-wasm` label hashes to the 32-byte Ed25519 seed used here.
// Verify locally with: `printf 'nostr-dag-wasm' | shasum -a 256`
const DETERMINISTIC_WASM_LIBP2P_SEED_HEX: &str =
    "3870cd6b88012214ab72801833c63ff224a18ac7e859c489df7be554bf88c78a";
// The native Nostr signing key reuses the same deterministic 32-byte seed so
// the browser/native test can reproduce the exact same signer across runs.
const DETERMINISTIC_NATIVE_NOSTR_SECRET_HEX: &str =
    "0401a34dbb8fd5fee2ffd914b184de1b89e78df8c76b68b01cf941570be8b872";

/// PIP protocol name carried in transfer manifest and slice event payloads.
const TRANSFER_PROTOCOL: &str = "nostr-dag-transfer";
/// PIP transfer payload version.
const TRANSFER_VERSION: u64 = 1;

fn hex_to_bytes<const N: usize>(hex: &str) -> [u8; N] {
    assert_eq!(hex.len(), N * 2, "hex string must be exactly {} bytes", N);
    let mut out = [0u8; N];
    for (index, chunk) in hex.as_bytes().chunks_exact(2).enumerate() {
        let hi = (chunk[0] as char).to_digit(16).expect("invalid hex digit") as u8;
        let lo = (chunk[1] as char).to_digit(16).expect("invalid hex digit") as u8;
        out[index] = (hi << 4) | lo;
    }
    out
}

#[cfg(feature = "p2p")]
pub fn deterministic_native_identity_keypair() -> libp2p::identity::Keypair {
    let seed_hex = std::env::var("NOSTR_DAG_NATIVE_LIBP2P_SEED_HEX")
        .ok()
        .filter(|value| value.len() == 64)
        .unwrap_or_else(|| DETERMINISTIC_NATIVE_LIBP2P_SEED_HEX.to_string());
    libp2p::identity::Keypair::ed25519_from_bytes(hex_to_bytes::<32>(
        &seed_hex,
    ))
        .expect("deterministic native libp2p identity seed is valid")
}

#[cfg(all(feature = "p2p-wasm", target_arch = "wasm32"))]
pub fn deterministic_wasm_identity_keypair() -> libp2p::identity::Keypair {
    libp2p::identity::Keypair::ed25519_from_bytes(hex_to_bytes::<32>(
        DETERMINISTIC_WASM_LIBP2P_SEED_HEX,
    ))
        .expect("deterministic wasm libp2p identity seed is valid")
}

#[cfg(feature = "p2p")]
pub fn deterministic_native_nostr_keys() -> nostr::Keys {
    nostr::Keys::new(
        nostr::SecretKey::from_hex(DETERMINISTIC_NATIVE_NOSTR_SECRET_HEX)
            .expect("deterministic native nostr secret key seed is valid"),
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferManifest {
    pub root_id: String,
    pub total_bytes: usize,
    pub total_slices: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferSlice {
    pub root_id: String,
    pub seq: usize,
    pub total_slices: usize,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransferEventPayload {
    Manifest(TransferManifest),
    Slice(TransferSlice),
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TransferError {
    #[error("unsupported transfer event kind: {0}")]
    UnsupportedKind(String),
    #[error("invalid transfer payload: {0}")]
    InvalidPayload(String),
    #[error("missing transfer field: {0}")]
    MissingField(&'static str),
    #[error("invalid bridge envelope: {0}")]
    InvalidEnvelope(String),
    #[error("json error: {0}")]
    Json(String),
}

#[cfg(feature = "p2p")]
fn native_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(all(feature = "p2p-wasm", target_arch = "wasm32"))]
fn wasm_now_ms() -> i64 {
    js_sys::Date::now() as i64
}

#[cfg(feature = "p2p")]
fn maybe_build_native_time_response(message: &str, local_peer_id: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(message).ok()?;
    if parsed.get("protocol")?.as_str()? != NETWORK_TIME_PROTOCOL
        || parsed.get("version")?.as_u64()? != NETWORK_TIME_VERSION
        || parsed.get("type")?.as_str()? != "query"
    {
        return None;
    }
    let request_id = parsed.get("request_id")?.as_str()?.trim().to_string();
    if request_id.is_empty() {
        return None;
    }
    let requester_peer_id = parsed
        .get("requester_peer_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    if !requester_peer_id.trim().is_empty() && requester_peer_id == local_peer_id {
        return None;
    }
    let sent_at_ms = parsed.get("sent_at_ms")?.as_i64()?;
    serde_json::to_string(&serde_json::json!({
        "protocol": NETWORK_TIME_PROTOCOL,
        "version": NETWORK_TIME_VERSION,
        "type": "response",
        "request_id": request_id,
        "requester_peer_id": requester_peer_id,
        "responder_peer_id": local_peer_id,
        "sent_at_ms": sent_at_ms,
        "server_time_ms": native_now_ms(),
    }))
    .ok()
}

#[cfg(all(feature = "p2p-wasm", target_arch = "wasm32"))]
fn maybe_build_wasm_time_response(message: &str, local_peer_id: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(message).ok()?;
    if parsed.get("protocol")?.as_str()? != NETWORK_TIME_PROTOCOL
        || parsed.get("version")?.as_u64()? != NETWORK_TIME_VERSION
        || parsed.get("type")?.as_str()? != "query"
    {
        return None;
    }
    let request_id = parsed.get("request_id")?.as_str()?.trim().to_string();
    if request_id.is_empty() {
        return None;
    }
    let requester_peer_id = parsed
        .get("requester_peer_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    if !requester_peer_id.trim().is_empty() && requester_peer_id == local_peer_id {
        return None;
    }
    let sent_at_ms = parsed.get("sent_at_ms")?.as_i64()?;
    serde_json::to_string(&serde_json::json!({
        "protocol": NETWORK_TIME_PROTOCOL,
        "version": NETWORK_TIME_VERSION,
        "type": "response",
        "request_id": request_id,
        "requester_peer_id": requester_peer_id,
        "responder_peer_id": local_peer_id,
        "sent_at_ms": sent_at_ms,
        "server_time_ms": wasm_now_ms(),
    }))
    .ok()
}

fn parse_payload_json(event: &nostr::Event) -> Result<serde_json::Value, TransferError> {
    serde_json::from_str(&event.content).map_err(|err| TransferError::Json(err.to_string()))
}

fn read_u64_field(payload: &serde_json::Value, field: &'static str) -> Result<u64, TransferError> {
    payload
        .get(field)
        .and_then(serde_json::Value::as_u64)
        .ok_or(TransferError::MissingField(field))
}

fn read_string_field(
    payload: &serde_json::Value,
    field: &'static str,
) -> Result<String, TransferError> {
    payload
        .get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or(TransferError::MissingField(field))
}

fn validate_protocol(payload: &serde_json::Value) -> Result<(), TransferError> {
    let protocol = read_string_field(payload, "protocol")?;
    if protocol != TRANSFER_PROTOCOL {
        return Err(TransferError::InvalidPayload(format!(
            "protocol mismatch: expected {TRANSFER_PROTOCOL}, got {protocol}"
        )));
    }

    let version = read_u64_field(payload, "version")?;
    if version != TRANSFER_VERSION {
        return Err(TransferError::InvalidPayload(format!(
            "version mismatch: expected {TRANSFER_VERSION}, got {version}"
        )));
    }
    Ok(())
}

/// Split payload bytes into ordered PIP transfer slices.
///
/// The output is suitable for a PIP manifest/slice sequence:
/// - all slices share the same `root_id`
/// - `seq` values are zero-based and contiguous
/// - empty payloads still emit a single empty slice so reconstruction remains well-defined
pub fn packetize_payload(
    root_id: &str,
    payload: &[u8],
    max_slice_bytes: usize,
) -> Vec<TransferSlice> {
    let chunk_size = max_slice_bytes.max(1);
    let total_slices = payload.len().div_ceil(chunk_size).max(1);

    if payload.is_empty() {
        return vec![TransferSlice {
            root_id: root_id.to_string(),
            seq: 0,
            total_slices,
            data: Vec::new(),
        }];
    }

    payload
        .chunks(chunk_size)
        .enumerate()
        .map(|(seq, chunk)| TransferSlice {
            root_id: root_id.to_string(),
            seq,
            total_slices,
            data: chunk.to_vec(),
        })
        .collect()
}

/// Build a PIP transfer-manifest Nostr event.
///
/// The event content follows the `PIP.md` manifest schema and advertises the total payload size
/// plus the total number of slices expected for the shared `root_id`.
pub fn build_transfer_manifest_event(
    keys: &nostr::Keys,
    manifest: &TransferManifest,
) -> Result<nostr::Event, nostr::event::builder::Error> {
    let content = serde_json::json!({
        "protocol": TRANSFER_PROTOCOL,
        "version": TRANSFER_VERSION,
        "type": "manifest",
        "root_id": manifest.root_id,
        "total_bytes": manifest.total_bytes,
        "total_slices": manifest.total_slices,
    })
    .to_string();

    nostr::EventBuilder::new(TRANSFER_MANIFEST_KIND, content).sign_with_keys(keys)
}

/// Build a PIP transfer-slice Nostr event and link it to the manifest via `e` tag.
///
/// Each slice repeats the `root_id`, exposes its zero-based sequence number, and carries raw bytes
/// as a JSON array so the payload can be reconstructed deterministically by receivers.
pub fn build_transfer_slice_event(
    keys: &nostr::Keys,
    slice: &TransferSlice,
    manifest_id: nostr::EventId,
) -> Result<nostr::Event, nostr::event::builder::Error> {
    let content = serde_json::json!({
        "protocol": TRANSFER_PROTOCOL,
        "version": TRANSFER_VERSION,
        "type": "slice",
        "root_id": slice.root_id,
        "seq": slice.seq,
        "total_slices": slice.total_slices,
        "data": slice.data,
    })
    .to_string();

    let tags = [nostr::Tag::event(manifest_id)];
    nostr::EventBuilder::new(TRANSFER_SLICE_KIND, content)
        .tags(tags)
        .sign_with_keys(keys)
}

/// Encode an arbitrary payload into the canonical PIP manifest/slice Nostr events.
///
/// This is the explicit "bytes -> Nostr events" conversion used by the bare-repo transfer
/// tests and by any future caller that wants to package a blob for publication.
pub fn encode_payload_as_transfer_events(
    keys: &nostr::Keys,
    root_id: &str,
    payload: &[u8],
    max_slice_bytes: usize,
) -> Result<(nostr::Event, Vec<nostr::Event>), nostr::event::builder::Error> {
    let slices = packetize_payload(root_id, payload, max_slice_bytes);
    let manifest = TransferManifest {
        root_id: root_id.to_string(),
        total_bytes: payload.len(),
        total_slices: slices.len(),
    };
    let manifest_event = build_transfer_manifest_event(keys, &manifest)?;
    let slice_events = slices
        .iter()
        .map(|slice| build_transfer_slice_event(keys, slice, manifest_event.id))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((manifest_event, slice_events))
}

/// Parse a PIP manifest or slice transfer event payload.
///
/// Validation enforces the normative transfer protocol string and version before decoding the
/// event-specific fields.
pub fn parse_transfer_event(event: &nostr::Event) -> Result<TransferEventPayload, TransferError> {
    let payload = parse_payload_json(event)?;
    validate_protocol(&payload)?;
    let root_id = read_string_field(&payload, "root_id")?;

    if event.kind == TRANSFER_MANIFEST_KIND {
        let total_bytes = read_u64_field(&payload, "total_bytes")? as usize;
        let total_slices = read_u64_field(&payload, "total_slices")? as usize;
        return Ok(TransferEventPayload::Manifest(TransferManifest {
            root_id,
            total_bytes,
            total_slices,
        }));
    }

    if event.kind == TRANSFER_SLICE_KIND {
        let seq = read_u64_field(&payload, "seq")? as usize;
        let total_slices = read_u64_field(&payload, "total_slices")? as usize;
        let data = payload
            .get("data")
            .and_then(serde_json::Value::as_array)
            .ok_or(TransferError::MissingField("data"))?
            .iter()
            .map(|value| {
                let byte = value.as_u64().ok_or_else(|| {
                    TransferError::InvalidPayload("slice data must be byte array".to_string())
                })?;
                u8::try_from(byte).map_err(|_| {
                    TransferError::InvalidPayload("slice data byte out of range".to_string())
                })
            })
            .collect::<Result<Vec<_>, _>>()?;

        return Ok(TransferEventPayload::Slice(TransferSlice {
            root_id,
            seq,
            total_slices,
            data,
        }));
    }

    Err(TransferError::UnsupportedKind(format!("{:?}", event.kind)))
}

/// Reconstruct the original payload from validated PIP transfer slices.
///
/// Reconstruction requires a complete set of slices sharing one `root_id` and one
/// `total_slices` value.  Missing sequence numbers or mixed metadata are rejected.
pub fn reconstruct_payload(slices: &[TransferSlice]) -> Result<Vec<u8>, TransferError> {
    if slices.is_empty() {
        return Ok(Vec::new());
    }

    let root_id = &slices[0].root_id;
    let expected_total = slices[0].total_slices;
    if expected_total != slices.len() {
        return Err(TransferError::InvalidPayload(format!(
            "slice count mismatch: expected {expected_total}, got {}",
            slices.len()
        )));
    }

    let mut ordered = slices.to_vec();
    ordered.sort_by_key(|slice| slice.seq);

    for (index, slice) in ordered.iter().enumerate() {
        if &slice.root_id != root_id {
            return Err(TransferError::InvalidPayload(
                "mixed root_id values in transfer slices".to_string(),
            ));
        }
        if slice.total_slices != expected_total {
            return Err(TransferError::InvalidPayload(
                "mixed total_slices values in transfer slices".to_string(),
            ));
        }
        if slice.seq != index {
            return Err(TransferError::InvalidPayload(format!(
                "missing slice sequence {index}, got {}",
                slice.seq
            )));
        }
    }

    Ok(ordered.into_iter().flat_map(|slice| slice.data).collect())
}

/// Encode a Nostr event as a PIP bridge envelope.
///
/// The resulting JSON object is the canonical bridge message published on the
/// `nostr-dag-bridge` topic.  The embedded `event` remains a standard Nostr event, while
/// `direction` and `relay_hints` carry transport metadata defined by `PIP.md`.
pub fn encode_bridge_message(
    event: &nostr::Event,
    direction: &str,
    relay_hints: &[String],
) -> Result<String, TransferError> {
    serde_json::to_string(&serde_json::json!({
        "protocol": NOSTR_DAG_TOPIC,
        "version": "1",
        "direction": direction,
        "event": event,
        "relay_hints": relay_hints,
    }))
    .map_err(|err| TransferError::Json(err.to_string()))
}

/// Decode and validate a PIP bridge envelope into a Nostr event.
///
/// Consumers reject mismatched bridge protocol identifiers and then deserialize the embedded
/// standard Nostr event payload.
pub fn decode_bridge_message(message: &str) -> Result<nostr::Event, TransferError> {
    let payload: serde_json::Value =
        serde_json::from_str(message).map_err(|err| TransferError::Json(err.to_string()))?;
    let protocol = payload
        .get("protocol")
        .and_then(serde_json::Value::as_str)
        .ok_or(TransferError::MissingField("protocol"))?;
    if protocol != NOSTR_DAG_TOPIC {
        return Err(TransferError::InvalidEnvelope(format!(
            "protocol mismatch: expected {NOSTR_DAG_TOPIC}, got {protocol}"
        )));
    }

    let event_payload = payload
        .get("event")
        .ok_or(TransferError::MissingField("event"))?
        .clone();
    serde_json::from_value(event_payload).map_err(|err| TransferError::Json(err.to_string()))
}

#[cfg(test)]
mod transfer_tests {
    use super::*;

    #[test]
    fn packetize_and_reconstruct_payload_roundtrip() {
        let original = b"nostr dag p2p transfer payload";
        let slices = packetize_payload("root-1", original, 5);
        assert!(slices.len() > 1);
        assert!(slices
            .iter()
            .all(|slice| slice.total_slices == slices.len()));

        let reconstructed = reconstruct_payload(&slices).unwrap();
        assert_eq!(reconstructed, original);
    }

    #[test]
    fn packetize_empty_payload_emits_single_empty_slice() {
        let slices = packetize_payload("root-empty", &[], 8);
        assert_eq!(slices.len(), 1);
        assert_eq!(slices[0].seq, 0);
        assert!(slices[0].data.is_empty());

        let reconstructed = reconstruct_payload(&slices).unwrap();
        assert!(reconstructed.is_empty());
    }

    #[test]
    fn reconstruct_rejects_missing_sequence() {
        let slices = vec![
            TransferSlice {
                root_id: "root-1".into(),
                seq: 0,
                total_slices: 2,
                data: vec![1, 2],
            },
            TransferSlice {
                root_id: "root-1".into(),
                seq: 2,
                total_slices: 2,
                data: vec![3],
            },
        ];

        let err = reconstruct_payload(&slices).unwrap_err();
        assert!(matches!(err, TransferError::InvalidPayload(_)));
    }

    #[test]
    fn parse_transfer_manifest_and_slice_events() {
        let keys = nostr::Keys::generate();
        let payload = b"abcdefgh";
        let slices = packetize_payload("root-2", payload, 3);
        let manifest = TransferManifest {
            root_id: "root-2".to_string(),
            total_bytes: payload.len(),
            total_slices: slices.len(),
        };
        let manifest_event = build_transfer_manifest_event(&keys, &manifest).unwrap();

        let parsed_manifest = parse_transfer_event(&manifest_event).unwrap();
        assert_eq!(
            parsed_manifest,
            TransferEventPayload::Manifest(manifest.clone())
        );

        let slice_event = build_transfer_slice_event(&keys, &slices[0], manifest_event.id).unwrap();
        let parsed_slice = parse_transfer_event(&slice_event).unwrap();
        assert_eq!(parsed_slice, TransferEventPayload::Slice(slices[0].clone()));
    }

    #[tokio::test]
    async fn p2p_bridge_message_roundtrip_for_nostr_transfer_events() {
        let keys = nostr::Keys::generate();
        let payload = b"fractal swarm adaptation for nostr dag";
        let slices = packetize_payload("root-bridge", payload, 7);
        let manifest = TransferManifest {
            root_id: "root-bridge".to_string(),
            total_bytes: payload.len(),
            total_slices: slices.len(),
        };
        let manifest_event = build_transfer_manifest_event(&keys, &manifest).unwrap();

        let mut slice_events = Vec::new();
        for slice in &slices {
            slice_events.push(build_transfer_slice_event(&keys, slice, manifest_event.id).unwrap());
        }

        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(64);
        let relay_hints = vec!["ws://localhost:8080".to_string()];

        tx.send(encode_bridge_message(&manifest_event, "outbound", &relay_hints).unwrap())
            .await
            .unwrap();
        for event in &slice_events {
            tx.send(encode_bridge_message(event, "outbound", &relay_hints).unwrap())
                .await
                .unwrap();
        }
        drop(tx);

        let mut received_manifest = None;
        let mut received_slices = Vec::new();

        while let Some(frame) = rx.recv().await {
            let event = decode_bridge_message(&frame).unwrap();
            match parse_transfer_event(&event).unwrap() {
                TransferEventPayload::Manifest(manifest) => received_manifest = Some(manifest),
                TransferEventPayload::Slice(slice) => received_slices.push(slice),
            }
        }

        assert_eq!(received_manifest, Some(manifest));
        assert_eq!(received_slices.len(), slices.len());

        let reconstructed = reconstruct_payload(&received_slices).unwrap();
        assert_eq!(reconstructed, payload);
    }
}

// ---------------------------------------------------------------------------
// Native git bare-repo PIP transfer tests
//
// These tests require the `native` feature (git2 dependency) and a `git`
// binary on PATH.  They are skipped automatically in WASM targets.
//
// Strategy
// --------
// 1. Build a git repository in a tempdir with DEPTH_LEVELS commits so that
//    the object graph has many ancestors.
// 2. Serialize all objects to a portable `git bundle` binary blob.
// 3. Compute a reference SHA-256 over the raw bundle bytes.
// 4. Packetize the bundle through the PIP transfer protocol at several
//    different slice sizes to exercise multi-level reconstruction.
// 5. Reconstruct each time and verify the reconstructed SHA-256 matches the
//    reference — guaranteeing bit-for-bit accuracy.
// 6. Unbundle the reconstructed bytes into a fresh bare repo and assert that
//    the HEAD OID matches the original.
// ---------------------------------------------------------------------------

#[cfg(all(test, feature = "native"))]
mod git_bare_pip_tests {
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    use sha2::{Digest, Sha256};

    use super::*;

    /// Number of commits in the linear ancestry chain.
    const DEPTH_LEVELS: usize = 10;

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /// SHA-256 a byte slice, returning a lower-hex string.
    fn sha256_hex(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("{:x}", hasher.finalize())
    }

    /// Run a `git` command in `dir`, panicking on failure.
    fn git_run(args: &[&str], dir: &std::path::Path) {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap_or_else(|e| panic!("failed to spawn git {args:?}: {e}"));
        assert!(
            status.status.success(),
            "git {args:?} failed in {dir:?}:\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&status.stdout),
            String::from_utf8_lossy(&status.stderr),
        );
    }

    fn print_tree(root: &Path, label: &str) {
        fn walk(root: &Path, path: &Path, indent: usize) {
            let mut entries = match fs::read_dir(path) {
                Ok(entries) => entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .collect::<Vec<_>>(),
                Err(err) => {
                    println!(
                        "{:indent$}{} (unreadable: {})",
                        "",
                        path.strip_prefix(root).unwrap_or(path).display(),
                        err,
                        indent = indent
                    );
                    return;
                }
            };
            entries.sort();
            for entry in entries {
                let rel = entry.strip_prefix(root).unwrap_or(&entry);
                let metadata = match fs::metadata(&entry) {
                    Ok(metadata) => metadata,
                    Err(err) => {
                        println!(
                            "{:indent$}{} (stat error: {})",
                            "",
                            rel.display(),
                            err,
                            indent = indent
                        );
                        continue;
                    }
                };
                if metadata.is_dir() {
                    println!("{:indent$}{}/", "", rel.display(), indent = indent);
                    walk(root, &entry, indent + 2);
                } else {
                    println!(
                        "{:indent$}{} ({})",
                        "",
                        rel.display(),
                        metadata.len(),
                        indent = indent
                    );
                }
            }
        }

        println!("{label} tree at {}", root.display());
        walk(root, root, 2);
    }

    /// Build a git repository at `src_dir` with `depth` commits.
    ///
    /// Each commit adds or modifies one file so that every level creates a
    /// unique tree object.  Returns the HEAD commit OID string.
    fn build_repo_with_depth(src_dir: &std::path::Path, depth: usize) -> String {
        git_run(&["init", "-b", "main"], src_dir);
        git_run(&["config", "user.email", "pip-test@nostr-dag"], src_dir);
        git_run(&["config", "user.name", "PIP Test"], src_dir);

        for level in 0..depth {
            let file = src_dir.join(format!("level-{level:03}.txt"));
            std::fs::write(
                &file,
                format!(
                    "PIP git-bare transfer depth level {level}\n\
                     root_id: git-bare-pip-test\n\
                     depth: {depth}\n\
                     level: {level}\n"
                ),
            )
            .unwrap();
            git_run(&["add", "-A"], src_dir);
            git_run(
                &[
                    "commit",
                    "-m",
                    &format!("depth level {level}: add level-{level:03}.txt"),
                ],
                src_dir,
            );
        }

        // Return HEAD OID
        let out = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(src_dir)
            .output()
            .unwrap();
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    /// Create a `git bundle create` covering all reachable objects from main.
    fn create_bundle(src_dir: &std::path::Path, bundle_path: &std::path::Path) -> Vec<u8> {
        git_run(
            &["bundle", "create", bundle_path.to_str().unwrap(), "main"],
            src_dir,
        );
        std::fs::read(bundle_path).unwrap()
    }

    /// Verify a git bundle and retrieve the HEAD OID it advertises.
    fn verify_bundle_head(bundle_path: &std::path::Path) -> String {
        let out = Command::new("git")
            .args(["bundle", "list-heads", bundle_path.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(out.status.success(), "git bundle list-heads failed");
        // Output: "<oid> refs/heads/main\n"
        String::from_utf8(out.stdout)
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string()
    }

    /// Clone a bundle into a fresh bare repo and return its HEAD OID.
    ///
    /// `git clone --bare <bundle> <dst_dir>` is the canonical one-step path:
    /// it initialises a bare repository and imports all refs from the bundle.
    fn unbundle_and_get_head(bundle_path: &std::path::Path, dst_dir: &std::path::Path) -> String {
        // dst_dir must not yet exist for git clone --bare.
        let _ = std::fs::remove_dir_all(dst_dir);
        git_run(
            &[
                "clone",
                "--bare",
                bundle_path.to_str().unwrap(),
                dst_dir.to_str().unwrap(),
            ],
            dst_dir.parent().unwrap_or(std::path::Path::new(".")),
        );

        // In bare repos with newer git (safe.bareRepository=explicit), we must
        // pass `GIT_DIR` explicitly or suppress the guard with a config flag.
        // Use `for-each-ref` to list the HEAD ref regardless of branch name.
        let out = Command::new("git")
            .args([
                "-c",
                "safe.bareRepository=all",
                "for-each-ref",
                "--format=%(objectname)",
                "refs/heads/",
            ])
            .env("GIT_DIR", dst_dir)
            .current_dir(dst_dir)
            .output()
            .unwrap();
        // for-each-ref may list multiple branches; take the last one which is
        // the tip of the most recent branch (our linear chain has only `main`).
        String::from_utf8(out.stdout)
            .unwrap()
            .lines()
            .last()
            .unwrap_or("")
            .trim()
            .to_string()
    }

    // -----------------------------------------------------------------------
    // Core PIP transfer roundtrip over a git bundle
    //
    // Tests a full packetize → Nostr-event encode → decode → reconstruct
    // cycle at several slice sizes ("depth levels") and verifies SHA-256
    // equality at each level.
    // -----------------------------------------------------------------------

    #[test]
    fn git_bare_pip_transfer_sha256_multi_depth() {
        let work = tempfile::tempdir().unwrap();
        let src_dir = work.path().join("src-repo");
        std::fs::create_dir_all(&src_dir).unwrap();

        let original_head = build_repo_with_depth(&src_dir, DEPTH_LEVELS);
        let bundle_path = work.path().join("repo.bundle");
        let bundle_bytes = create_bundle(&src_dir, &bundle_path);

        let reference_sha256 = sha256_hex(&bundle_bytes);
        println!(
            "bundle size: {} bytes  SHA-256: {}",
            bundle_bytes.len(),
            reference_sha256
        );
        println!("original HEAD: {original_head}");

        // Advertised HEAD in the bundle must match the repo HEAD.
        let bundle_head = verify_bundle_head(&bundle_path);
        assert_eq!(
            original_head, bundle_head,
            "bundle HEAD OID must match source repo HEAD"
        );

        // Transfer at several slice sizes to exercise different depth levels.
        let slice_sizes: &[usize] = &[
            bundle_bytes.len(),          // 1 slice  — depth 1
            bundle_bytes.len() / 2 + 1,  // ~2 slices — depth 2
            bundle_bytes.len() / 4 + 1,  // ~4 slices — depth 4
            bundle_bytes.len() / 8 + 1,  // ~8 slices — depth 8
            bundle_bytes.len() / 16 + 1, // ~16 slices — depth 16
            512,                         // fine-grained slices
            64,                          // very fine-grained slices
        ];

        for &slice_size in slice_sizes {
            let slice_size = slice_size.max(1);
            let root_id = format!("git-bare-pip-depth-{slice_size}");

            // --- packetize ---
            let slices = packetize_payload(&root_id, &bundle_bytes, slice_size);
            let slice_count = slices.len();
            println!("slice_size={slice_size}  slice_count={slice_count}");

            let manifest = TransferManifest {
                root_id: root_id.clone(),
                total_bytes: bundle_bytes.len(),
                total_slices: slice_count,
            };

            // --- encode to Nostr events ---
            let keys = nostr::Keys::generate();
            let manifest_event =
                build_transfer_manifest_event(&keys, &manifest).expect("build manifest event");
            let slice_events: Vec<nostr::Event> = slices
                .iter()
                .map(|s| {
                    build_transfer_slice_event(&keys, s, manifest_event.id)
                        .expect("build slice event")
                })
                .collect();

            // --- decode from Nostr events ---
            let parsed_manifest =
                match parse_transfer_event(&manifest_event).expect("parse manifest") {
                    TransferEventPayload::Manifest(m) => m,
                    other => panic!("expected Manifest, got {other:?}"),
                };
            assert_eq!(parsed_manifest.root_id, root_id);
            assert_eq!(parsed_manifest.total_bytes, bundle_bytes.len());
            assert_eq!(parsed_manifest.total_slices, slice_count);

            let mut recovered: Vec<TransferSlice> = slice_events
                .iter()
                .map(|ev| match parse_transfer_event(ev).expect("parse slice") {
                    TransferEventPayload::Slice(s) => s,
                    other => panic!("expected Slice, got {other:?}"),
                })
                .collect();

            // Shuffle to prove order-independent reconstruction.
            recovered.sort_by_key(|s| s.seq.wrapping_mul(1_000_003).wrapping_add(17));

            // --- reconstruct ---
            let reconstructed = reconstruct_payload(&recovered).expect("reconstruct payload");
            assert_eq!(
                reconstructed.len(),
                bundle_bytes.len(),
                "slice_size={slice_size}: reconstructed length mismatch"
            );
            assert_eq!(
                reconstructed, bundle_bytes,
                "slice_size={slice_size}: bit-for-bit mismatch"
            );

            // --- SHA-256 verification ---
            let reconstructed_sha256 = sha256_hex(&reconstructed);
            assert_eq!(
                reconstructed_sha256, reference_sha256,
                "slice_size={slice_size}: SHA-256 mismatch\n  expected  {reference_sha256}\n  got       {reconstructed_sha256}"
            );
            println!("slice_size={slice_size}  SHA-256 VERIFIED: {reconstructed_sha256}");
        }
    }

    // -----------------------------------------------------------------------
    // Full roundtrip: transfer → unbundle → bare repo HEAD verification
    //
    // Reconstructs the bundle from PIP slices, writes it to disk, unbundles
    // into a fresh bare repo, and asserts the HEAD OID matches the original.
    // -----------------------------------------------------------------------

    #[test]
    fn git_bare_pip_transfer_unbundle_head_roundtrip() {
        let work = tempfile::tempdir().unwrap();
        let src_dir = work.path().join("src-repo2");
        std::fs::create_dir_all(&src_dir).unwrap();

        let original_head = build_repo_with_depth(&src_dir, DEPTH_LEVELS);
        let bundle_path = work.path().join("original.bundle");
        let bundle_bytes = create_bundle(&src_dir, &bundle_path);

        // Transfer at a modest slice size that produces several dozen slices.
        let slice_size = bundle_bytes.len() / 8 + 1;
        let root_id = "git-bare-pip-unbundle-test";

        let slices = packetize_payload(root_id, &bundle_bytes, slice_size);
        let keys = nostr::Keys::generate();
        let manifest = TransferManifest {
            root_id: root_id.to_string(),
            total_bytes: bundle_bytes.len(),
            total_slices: slices.len(),
        };
        let manifest_event = build_transfer_manifest_event(&keys, &manifest).unwrap();
        let slice_events: Vec<nostr::Event> = slices
            .iter()
            .map(|s| build_transfer_slice_event(&keys, s, manifest_event.id).unwrap())
            .collect();

        let recovered_slices: Vec<TransferSlice> = slice_events
            .iter()
            .map(|ev| match parse_transfer_event(ev).unwrap() {
                TransferEventPayload::Slice(s) => s,
                other => panic!("expected Slice, got {other:?}"),
            })
            .collect();

        let reconstructed = reconstruct_payload(&recovered_slices).unwrap();

        // Write reconstructed bundle and verify SHA-256.
        let reconstructed_bundle_path = work.path().join("reconstructed.bundle");
        std::fs::write(&reconstructed_bundle_path, &reconstructed).unwrap();

        let ref_sha = sha256_hex(&bundle_bytes);
        let rec_sha = sha256_hex(&reconstructed);
        assert_eq!(ref_sha, rec_sha, "reconstructed bundle SHA-256 mismatch");
        println!("unbundle test SHA-256 VERIFIED: {rec_sha}");

        // Unbundle reconstructed bytes into a fresh bare repo.
        let dst_dir = work.path().join("dst-bare-repo");
        std::fs::create_dir_all(&dst_dir).unwrap();
        let restored_head = unbundle_and_get_head(&reconstructed_bundle_path, &dst_dir);

        assert_eq!(
            original_head, restored_head,
            "restored bare repo HEAD must match original\n  expected  {original_head}\n  got       {restored_head}"
        );
        println!("bare repo HEAD VERIFIED: {restored_head}");
    }

    #[test]
    fn git_bare_pip_transfer_verbose_trace() {
        let work = tempfile::tempdir().unwrap();
        let src_dir = work.path().join("src-repo-verbose");
        fs::create_dir_all(&src_dir).unwrap();

        let original_head = build_repo_with_depth(&src_dir, DEPTH_LEVELS);
        println!("=== created source repo ===");
        println!("  path {}", src_dir.display());
        print_tree(&src_dir, "source repo");

        let bundle_path = work.path().join("verbose.bundle");
        let bundle_bytes = create_bundle(&src_dir, &bundle_path);
        let reference_sha256 = sha256_hex(&bundle_bytes);
        println!("=== created bundle ===");
        println!("  size {} bytes", bundle_bytes.len());
        println!("  sha256 {reference_sha256}");
        println!("  head {original_head}");

        let slice_size = 64usize;
        let root_id = "git-bare-pip-verbose";
        println!("=== broadcast settings ===");
        println!("  root_id {root_id}");
        println!("  slice_size {slice_size}");

        let keys = nostr::Keys::generate();
        let (manifest_event, slice_events) = encode_payload_as_transfer_events(
            &keys,
            root_id,
            &bundle_bytes,
            slice_size,
        )
        .expect("encode payload as transfer events");
        println!("=== encoded bare repo ===");
        println!("  manifest {}", manifest_event.id);
        println!("  slices {}", slice_events.len());
        println!("manifest event:");
        for line in serde_json::to_string_pretty(&manifest_event).unwrap().lines() {
            println!("  {line}");
        }
        for (index, event) in slice_events.iter().enumerate() {
            println!("slice event seq={index}:");
            for line in serde_json::to_string_pretty(event).unwrap().lines() {
                println!("  {line}");
            }
        }

        let mut received_slices = Vec::new();
        for event in &slice_events {
            match parse_transfer_event(event).unwrap() {
                TransferEventPayload::Slice(slice) => received_slices.push(slice),
                other => panic!("expected slice event, got {other:?}"),
            }
        }
        println!("=== received transfer payload ===");
        println!("  manifest root_id {root_id}");
        println!("  received slices {}", received_slices.len());

        let reconstructed = reconstruct_payload(&received_slices).unwrap();
        let reconstructed_sha256 = sha256_hex(&reconstructed);
        println!("=== reconstructed bundle ===");
        println!("  size {} bytes", reconstructed.len());
        println!("  sha256 {reconstructed_sha256}");
        assert_eq!(reference_sha256, reconstructed_sha256);

        let reconstructed_bundle_path = work.path().join("verbose.reconstructed.bundle");
        fs::write(&reconstructed_bundle_path, &reconstructed).unwrap();

        let dst_dir = work.path().join("verbose-bare-repo");
        let restored_head = unbundle_and_get_head(&reconstructed_bundle_path, &dst_dir);
        print_tree(&dst_dir, "bare repo");
        assert_eq!(original_head, restored_head);
        println!("=== bare repo restored ===");
        println!("  head {restored_head}");
    }
}

// ---------------------------------------------------------------------------
// Native implementation
// ---------------------------------------------------------------------------

#[cfg(feature = "p2p")]
pub mod native {
    use std::time::Duration;

    use libp2p::{
        futures::StreamExt,
        gossipsub::{self, IdentTopic, MessageAuthenticity},
        mdns, noise,
        swarm::{NetworkBehaviour, SwarmEvent},
        tcp, yamux, Multiaddr,
    };
    use tokio::sync::mpsc;
    use tracing::{debug, info, warn};

    use super::{
        deterministic_native_identity_keypair, maybe_build_native_time_response, NOSTR_DAG_TOPIC,
    };

    #[derive(NetworkBehaviour)]
    struct Behaviour {
        gossipsub: gossipsub::Behaviour,
        mdns: mdns::tokio::Behaviour,
    }

    /// A running libp2p node.  Cheap to clone — cloning duplicates the sender
    /// handle only.
    #[derive(Clone)]
    pub struct SwarmHandle {
        tx: mpsc::Sender<String>,
    }

    impl SwarmHandle {
        /// Start a new libp2p node, listen on a random TCP port, and return a
        /// handle plus a receiver for inbound messages.
        pub async fn start(
        ) -> Result<(Self, mpsc::Receiver<String>), Box<dyn std::error::Error + Send + Sync>>
        {
            let local_key = deterministic_native_identity_keypair();

            let topic = IdentTopic::new(NOSTR_DAG_TOPIC);

            // Gossipsub
            let gossipsub_config = gossipsub::ConfigBuilder::default()
                .heartbeat_interval(Duration::from_secs(10))
                .validation_mode(gossipsub::ValidationMode::Strict)
                .build()
                .map_err(|e| format!("gossipsub config: {e}"))?;
            let mut gossipsub = gossipsub::Behaviour::new(
                MessageAuthenticity::Signed(local_key.clone()),
                gossipsub_config,
            )
            .map_err(|e| format!("gossipsub init: {e}"))?;
            gossipsub.subscribe(&topic)?;

            // mDNS
            let mdns = mdns::tokio::Behaviour::new(
                mdns::Config::default(),
                local_key.public().to_peer_id(),
            )?;

            let behaviour = Behaviour { gossipsub, mdns };

            let mut swarm = libp2p::SwarmBuilder::with_existing_identity(local_key)
                .with_tokio()
                .with_tcp(
                    tcp::Config::default(),
                    noise::Config::new,
                    yamux::Config::default,
                )?
                .with_behaviour(|_| behaviour)?
                .with_swarm_config(|cfg| cfg.with_idle_connection_timeout(Duration::from_secs(60)))
                .build();

            swarm.listen_on("/ip4/0.0.0.0/tcp/0".parse::<Multiaddr>()?)?;

            let (tx, mut cmd_rx) = mpsc::channel::<String>(64);
            let (event_tx, event_rx) = mpsc::channel::<String>(256);

            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        msg = cmd_rx.recv() => {
                            match msg {
                                Some(text) => {
                                    if let Err(e) = swarm.behaviour_mut().gossipsub.publish(
                                        IdentTopic::new(NOSTR_DAG_TOPIC),
                                        text.as_bytes(),
                                    ) {
                                        warn!(?e, "gossipsub publish failed");
                                    }
                                }
                                None => break,
                            }
                        }
                        event = swarm.select_next_some() => {
                            match event {
                                SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(
                                    gossipsub::Event::Message { message, .. },
                                )) => {
                                    if let Ok(text) = String::from_utf8(message.data) {
                                        if let Some(response) = maybe_build_native_time_response(
                                            &text,
                                            &swarm.local_peer_id().to_string(),
                                        ) {
                                            let _ = swarm.behaviour_mut().gossipsub.publish(
                                                IdentTopic::new(NOSTR_DAG_TOPIC),
                                                response.as_bytes(),
                                            );
                                        }
                                        debug!(%text, "gossipsub message received");
                                        let _ = event_tx.send(text).await;
                                    }
                                }
                                SwarmEvent::Behaviour(BehaviourEvent::Mdns(
                                    mdns::Event::Discovered(peers),
                                )) => {
                                    for (peer_id, addr) in peers {
                                        info!(%peer_id, %addr, "mDNS peer discovered");
                                        swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
                                    }
                                }
                                SwarmEvent::Behaviour(BehaviourEvent::Mdns(
                                    mdns::Event::Expired(peers),
                                )) => {
                                    for (peer_id, _) in peers {
                                        swarm.behaviour_mut().gossipsub.remove_explicit_peer(&peer_id);
                                    }
                                }
                                SwarmEvent::NewListenAddr { address, .. } => {
                                    info!(%address, "p2p listening");
                                }
                                _ => {}
                            }
                        }
                    }
                }
            });

            Ok((Self { tx }, event_rx))
        }

        /// Publish `msg` on the nostr-dag gossipsub topic.
        pub async fn broadcast(&self, msg: String) -> Result<(), mpsc::error::SendError<String>> {
            self.tx.send(msg).await
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::p2p::deterministic_native_nostr_keys;

        /// Two nodes discover each other via mDNS and exchange a message.
        /// This test is marked `#[ignore]` so it does not run in plain
        /// `cargo test` (mDNS requires a network interface); run it explicitly
        /// with `cargo test --features native,p2p -- --ignored`.
        #[tokio::test]
        #[ignore]
        async fn test_two_peer_gossipsub_echo() {
            let (node_a, mut rx_a) = SwarmHandle::start().await.expect("node a");
            let (node_b, mut rx_b) = SwarmHandle::start().await.expect("node b");

            // Give mDNS time to discover peers.
            tokio::time::sleep(Duration::from_secs(2)).await;

            node_a.broadcast("hello from A".into()).await.unwrap();
            node_b.broadcast("hello from B".into()).await.unwrap();

            // Collect messages for up to 3 s.
            let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
            let mut received_a = Vec::new();
            let mut received_b = Vec::new();
            loop {
                tokio::select! {
                    msg = rx_a.recv() => { if let Some(m) = msg { received_a.push(m); } }
                    msg = rx_b.recv() => { if let Some(m) = msg { received_b.push(m); } }
                    _ = tokio::time::sleep_until(deadline) => break,
                }
            }

            assert!(received_a.iter().any(|m| m.contains("from B")));
            assert!(received_b.iter().any(|m| m.contains("from A")));
        }

        #[test]
        fn deterministic_identity_helpers_are_stable() {
            let native_a = deterministic_native_identity_keypair();
            let native_b = deterministic_native_identity_keypair();
            assert_eq!(native_a.public().to_peer_id(), native_b.public().to_peer_id());
            assert_eq!(
                native_a.public().to_peer_id().to_string(),
                "12D3KooWSL8rLNFrwVGVBJbHWxXQfFTfVtYnozURrqBFYBMfrniH"
            );

            let nostr_keys = deterministic_native_nostr_keys();
            assert_eq!(
                nostr_keys.public_key().to_hex(),
                "2d724a13a80b6002607737ad1a99f3c0b148843707d59ac3bff08c7fce72ecce"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// WASM implementation
// ---------------------------------------------------------------------------

#[cfg(all(feature = "p2p-wasm", target_arch = "wasm32"))]
pub mod wasm_node {
    use futures::StreamExt;
    use libp2p::{
        gossipsub::{self, IdentTopic, MessageAuthenticity},
        identity, noise,
        swarm::{NetworkBehaviour, SwarmEvent},
        websocket_websys, yamux, Transport,
    };
    use wasm_bindgen::prelude::*;
    use wasm_bindgen_futures::spawn_local;
    use web_sys::js_sys::Function;

    use super::{maybe_build_wasm_time_response, NOSTR_DAG_TOPIC};

    #[derive(NetworkBehaviour)]
    struct Behaviour {
        gossipsub: gossipsub::Behaviour,
    }

    /// Browser-side libp2p node exposed to JavaScript.
    ///
    /// ```js
    /// import init from './pkg/nostr_dag.js';
    /// await init();
    /// const node = new P2pNode();
    /// node.on_message((msg) => console.log('received', msg));
    /// await node.start();
    /// await node.broadcast('hello');
    /// ```
    #[wasm_bindgen]
    pub struct P2pNode {
        local_key: identity::Keypair,
        on_message: Option<Function>,
    }

    #[derive(Debug, Clone)]
    enum ControlMessage {
        Broadcast(String),
        Dial(String),
    }

    #[wasm_bindgen]
    impl P2pNode {
        /// Create a new node with a deterministic Ed25519 identity.
        #[wasm_bindgen(constructor)]
        pub fn new() -> P2pNode {
            P2pNode {
                local_key: deterministic_wasm_identity_keypair(),
                on_message: None,
            }
        }

        /// Register a JavaScript callback that is invoked for every inbound
        /// gossipsub message.  `cb` receives a single `string` argument.
        pub fn on_message(&mut self, cb: Function) {
            self.on_message = Some(cb);
        }

        /// Start the swarm event loop and resolve when initialization completes.
        pub async fn start(&self) -> Result<(), JsValue> {
            let local_key = self.local_key.clone();
            let on_message = self.on_message.clone();
            let (ready_tx, ready_rx) = oneshot::channel::<()>();

            spawn_local(async move {
                if let Err(e) = run_swarm(local_key, on_message, Some(ready_tx)).await {
                    web_sys::console::error_1(&e);
                }
            });

            ready_rx
                .await
                .map_err(|_| JsValue::from_str("p2p node failed before initialization"))
        }

        /// Publish a message on the nostr-dag gossipsub topic.
        /// Returns a Promise that resolves once the publish completes.
        pub async fn broadcast(&self, msg: String) -> Result<(), JsValue> {
            CONTROL_TX.with(|cell| {
                let mut borrow = cell.borrow_mut();
                if let Some(tx) = borrow.as_mut() {
                    let _ = tx.try_send(ControlMessage::Broadcast(msg));
                }
            });
            Ok(())
        }

        /// Dial a peer multiaddr from the running WASM swarm.
        pub async fn dial(&self, addr: String) -> Result<(), JsValue> {
            CONTROL_TX.with(|cell| {
                let mut borrow = cell.borrow_mut();
                if let Some(tx) = borrow.as_mut() {
                    let _ = tx.try_send(ControlMessage::Dial(addr));
                }
            });
            Ok(())
        }

        /// Return the local peer id as a string.
        pub fn peer_id(&self) -> String {
            self.local_key.public().to_peer_id().to_string()
        }
    }

    // Thread-local channel used to hand commands from JavaScript into the
    // swarm event loop.
    use futures::channel::{mpsc as fmpsc, oneshot};
    use std::cell::RefCell;

    thread_local! {
        static CONTROL_TX: RefCell<Option<fmpsc::Sender<ControlMessage>>> = RefCell::new(None);
    }

    async fn run_swarm(
        local_key: identity::Keypair,
        on_message: Option<Function>,
        ready_tx: Option<oneshot::Sender<()>>,
    ) -> Result<(), JsValue> {
        let topic = IdentTopic::new(NOSTR_DAG_TOPIC);

        let gossipsub_config = gossipsub::ConfigBuilder::default()
            .validation_mode(gossipsub::ValidationMode::Strict)
            .build()
            .map_err(|e| JsValue::from_str(&format!("gossipsub config: {e}")))?;
        let mut gossipsub = gossipsub::Behaviour::new(
            MessageAuthenticity::Signed(local_key.clone()),
            gossipsub_config,
        )
        .map_err(|e| JsValue::from_str(&format!("gossipsub init: {e}")))?;
        gossipsub
            .subscribe(&topic)
            .map_err(|e| JsValue::from_str(&format!("subscribe: {e}")))?;

        let behaviour = Behaviour { gossipsub };
        let local_peer_id = local_key.public().to_peer_id().to_string();

        let (tx, mut cmd_rx) = fmpsc::channel::<ControlMessage>(64);
        CONTROL_TX.with(|cell| {
            *cell.borrow_mut() = Some(tx);
        });

        let mut swarm = libp2p::SwarmBuilder::with_existing_identity(local_key)
            .with_wasm_bindgen()
            .with_other_transport(|key| {
                websocket_websys::Transport::default()
                    .upgrade(libp2p::core::upgrade::Version::V1)
                    .authenticate(
                        noise::Config::new(key)
                            .expect("libp2p noise config should initialize for wasm transport"),
                    )
                    .multiplex(yamux::Config::default())
                    .boxed()
            })
            .map_err(|e| JsValue::from_str(&format!("transport: {e}")))?
            .with_behaviour(|_| behaviour)
            .map_err(|e| JsValue::from_str(&format!("behaviour: {e}")))?
            .build();

        if let Some(tx) = ready_tx {
            let _ = tx.send(());
        }

        loop {
            futures::select! {
                msg = cmd_rx.next() => {
                    if let Some(command) = msg {
                        match command {
                            ControlMessage::Broadcast(text) => {
                                let _ = swarm.behaviour_mut().gossipsub.publish(
                                    IdentTopic::new(NOSTR_DAG_TOPIC),
                                    text.as_bytes(),
                                );
                            }
                            ControlMessage::Dial(addr) => {
                                match addr.parse::<libp2p::Multiaddr>() {
                                    Ok(addr) => {
                                        if let Err(e) = swarm.dial(addr) {
                                            web_sys::console::error_1(
                                                &JsValue::from_str(&format!("dial failed: {e}"))
                                            );
                                        }
                                    }
                                    Err(e) => {
                                        web_sys::console::error_1(
                                            &JsValue::from_str(&format!("invalid multiaddr: {e}"))
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
                event = swarm.select_next_some() => {
                    if let SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(
                        gossipsub::Event::Message { message, .. },
                    )) = event
                    {
                        if let Ok(text) = String::from_utf8(message.data) {
                            if let Some(response) =
                                maybe_build_wasm_time_response(&text, &local_peer_id)
                            {
                                let _ = swarm.behaviour_mut().gossipsub.publish(
                                    IdentTopic::new(NOSTR_DAG_TOPIC),
                                    response.as_bytes(),
                                );
                            }
                            if let Some(cb) = &on_message {
                                let _ = cb.call1(
                                    &JsValue::NULL,
                                    &JsValue::from_str(&text),
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}
