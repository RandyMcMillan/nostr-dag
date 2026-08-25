//! Dual-target libp2p node.
//!
//! * `#[cfg(feature = "p2p")]`       — native Tokio-based `SwarmHandle`
//! * `#[cfg(feature = "p2p-wasm")]`  — WASM `P2pNode` (`#[wasm_bindgen]`)
//!
//! Both expose the same logical interface:
//! * `broadcast(msg)` — publish a UTF-8 message on the nostr-dag gossipsub topic
//! * subscribe / `on_message(cb)` — receive messages from peers

// ---------------------------------------------------------------------------
// Shared constant
// ---------------------------------------------------------------------------

/// Gossipsub topic used by all nostr-dag peers (native and WASM).
pub const NOSTR_DAG_TOPIC: &str = "nostr-dag-bridge";

/// Nostr event kind used for transfer manifests.
pub const TRANSFER_MANIFEST_KIND: nostr::Kind = nostr::Kind::Custom(39078);
/// Nostr event kind used for transfer slices.
pub const TRANSFER_SLICE_KIND: nostr::Kind = nostr::Kind::Custom(39079);

const TRANSFER_PROTOCOL: &str = "nostr-dag-transfer";
const TRANSFER_VERSION: u64 = 1;

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

fn parse_payload_json(event: &nostr::Event) -> Result<serde_json::Value, TransferError> {
    serde_json::from_str(&event.content).map_err(|err| TransferError::Json(err.to_string()))
}

fn read_u64_field(payload: &serde_json::Value, field: &'static str) -> Result<u64, TransferError> {
    payload
        .get(field)
        .and_then(serde_json::Value::as_u64)
        .ok_or(TransferError::MissingField(field))
}

fn read_string_field(payload: &serde_json::Value, field: &'static str) -> Result<String, TransferError> {
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

/// Split payload bytes into ordered transfer slices.
pub fn packetize_payload(root_id: &str, payload: &[u8], max_slice_bytes: usize) -> Vec<TransferSlice> {
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

/// Build a transfer-manifest nostr event.
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

/// Build a transfer-slice nostr event and link it to the manifest via `e` tag.
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

/// Parse a manifest or slice transfer event payload.
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

/// Reconstruct original payload from validated transfer slices.
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

/// Encode a nostr event as a p2p bridge envelope.
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

/// Decode and validate a p2p bridge envelope into a nostr event.
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
        assert!(slices.iter().all(|slice| slice.total_slices == slices.len()));

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
        assert_eq!(parsed_manifest, TransferEventPayload::Manifest(manifest.clone()));

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
// Native implementation
// ---------------------------------------------------------------------------

#[cfg(feature = "p2p")]
pub mod native {
    use std::time::Duration;

    use libp2p::{
        futures::StreamExt,
        gossipsub::{self, IdentTopic, MessageAuthenticity},
        identity,
        mdns,
        noise,
        swarm::{NetworkBehaviour, SwarmEvent},
        tcp,
        yamux,
        Multiaddr,
    };
    use tokio::sync::mpsc;
    use tracing::{debug, info, warn};

    use super::NOSTR_DAG_TOPIC;

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
        pub async fn start() -> Result<(Self, mpsc::Receiver<String>), Box<dyn std::error::Error + Send + Sync>> {
            let local_key = identity::Keypair::generate_ed25519();

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
                .with_swarm_config(|cfg| {
                    cfg.with_idle_connection_timeout(Duration::from_secs(60))
                })
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
        identity,
        noise,
        swarm::{NetworkBehaviour, SwarmEvent},
        websocket_websys,
        yamux,
        Transport,
    };
    use wasm_bindgen::prelude::*;
    use wasm_bindgen_futures::spawn_local;
    use web_sys::js_sys::Function;

    use super::NOSTR_DAG_TOPIC;

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

    #[wasm_bindgen]
    impl P2pNode {
        /// Create a new node with a freshly generated Ed25519 identity.
        #[wasm_bindgen(constructor)]
        pub fn new() -> P2pNode {
            P2pNode {
                local_key: identity::Keypair::generate_ed25519(),
                on_message: None,
            }
        }

        /// Register a JavaScript callback that is invoked for every inbound
        /// gossipsub message.  `cb` receives a single `string` argument.
        pub fn on_message(&mut self, cb: Function) {
            self.on_message = Some(cb);
        }

        /// Start the swarm event loop (non-blocking; runs in a WASM future).
        pub fn start(&self) -> Result<(), JsValue> {
            let local_key = self.local_key.clone();
            let on_message = self.on_message.clone();

            spawn_local(async move {
                if let Err(e) = run_swarm(local_key, on_message).await {
                    web_sys::console::error_1(&e);
                }
            });
            Ok(())
        }

        /// Publish a message on the nostr-dag gossipsub topic.
        /// Returns a Promise that resolves once the publish completes.
        pub async fn broadcast(&self, msg: String) -> Result<(), JsValue> {
            // For the WASM node the publish happens inside the swarm loop.
            // We use a channel stored in thread-local storage.
            OUTBOUND_TX.with(|cell| {
                let mut borrow = cell.borrow_mut();
                if let Some(tx) = borrow.as_mut() {
                    let _ = tx.try_send(msg);
                }
            });
            Ok(())
        }
    }

    // Thread-local channel used to hand messages from `broadcast` into the
    // swarm event loop.
    use std::cell::RefCell;
    use futures::channel::mpsc as fmpsc;

    thread_local! {
        static OUTBOUND_TX: RefCell<Option<fmpsc::Sender<String>>> = RefCell::new(None);
    }

    async fn run_swarm(
        local_key: identity::Keypair,
        on_message: Option<Function>,
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
        gossipsub.subscribe(&topic)
            .map_err(|e| JsValue::from_str(&format!("subscribe: {e}")))?;

        let behaviour = Behaviour { gossipsub };

        let (tx, mut cmd_rx) = fmpsc::channel::<String>(64);
        OUTBOUND_TX.with(|cell| {
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

        loop {
            futures::select! {
                msg = cmd_rx.next() => {
                    if let Some(text) = msg {
                        let _ = swarm.behaviour_mut().gossipsub.publish(
                            IdentTopic::new(NOSTR_DAG_TOPIC),
                            text.as_bytes(),
                        );
                    }
                }
                event = swarm.select_next_some() => {
                    if let SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(
                        gossipsub::Event::Message { message, .. },
                    )) = event
                    {
                        if let Ok(text) = String::from_utf8(message.data) {
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
