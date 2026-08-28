#[cfg(feature = "p2p")]
use libp2p::Multiaddr;

#[cfg(feature = "p2p")]
use crate::{
    bridge_native::unwrap_bridge_envelope,
    create_ack_event,
    event::DAG_EVENT_KIND,
    p2p::{parse_transfer_event, TransferEventPayload},
    Dag, InsertResult, PIP_ATTEST_KIND, PIP_JOIN_KIND, PIP_SEAL_KIND,
};

#[cfg(feature = "p2p")]
use nostr::{Event, EventId, Keys, PublicKey};

#[cfg(feature = "p2p")]
use std::collections::BTreeSet;

#[cfg(feature = "p2p")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerTopicRole {
    NativeLike,
    WasmLike,
}

#[cfg(feature = "p2p")]
pub fn classify_peer_topic_role(address: &Multiaddr) -> PeerTopicRole {
    classify_peer_topic_role_str(&address.to_string())
}

#[cfg(feature = "p2p")]
pub fn classify_peer_topic_role_str(address: &str) -> PeerTopicRole {
    let lowered = address.to_ascii_lowercase();
    if lowered.contains("/ws")
        || lowered.contains("/wss")
        || lowered.contains("/webrtc")
        || lowered.contains("/webtransport")
        || lowered.contains("/p2p-circuit")
    {
        PeerTopicRole::WasmLike
    } else {
        PeerTopicRole::NativeLike
    }
}

#[cfg(feature = "p2p")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeCommand {
    Broadcast(String),
    Dial(Multiaddr),
    Help,
    Status,
    Quit,
}

#[cfg(feature = "p2p")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerReaction {
    pub summary: InboundSummary,
    pub outbound_messages: Vec<String>,
    pub inserted_event_id: Option<String>,
    pub canonical_count: usize,
    pub tip_count: usize,
}

#[cfg(feature = "p2p")]
pub struct PeerRuntime {
    keys: Keys,
    dag: Dag,
    participants: BTreeSet<PublicKey>,
}

#[cfg(feature = "p2p")]
impl PeerRuntime {
    pub fn new(keys: Keys, participants: impl IntoIterator<Item = PublicKey>) -> Self {
        let participants: BTreeSet<PublicKey> = participants.into_iter().collect();
        let dag = Dag::new(participants.iter().copied());
        Self {
            keys,
            dag,
            participants,
        }
    }

    pub fn new_with_self_participation(keys: Keys) -> Self {
        let self_pubkey = keys.public_key();
        Self::new(keys, [self_pubkey])
    }

    pub fn public_key(&self) -> PublicKey {
        self.keys.public_key()
    }

    pub fn participant_count(&self) -> usize {
        self.participants.len()
    }

    pub fn status_line(&self, listen_addrs: &[String], connected_peers: usize) -> String {
        format!(
            "STATUS nostr_pubkey={} listen_addrs={} connected_peers={} participants={} canonical={} tips={}",
            self.public_key(),
            listen_addrs.join(","),
            connected_peers,
            self.participant_count(),
            self.dag.canonical_events().count(),
            self.dag.tips().count(),
        )
    }

    pub fn process_inbound_message(&mut self, message: &str) -> PeerReaction {
        let summary = summarize_inbound_message(message);
        let Some(event) = decode_event_message(message) else {
            return PeerReaction {
                summary,
                outbound_messages: Vec::new(),
                inserted_event_id: None,
                canonical_count: self.dag.canonical_events().count(),
                tip_count: self.dag.tips().count(),
            };
        };

        let inserted_event_id = match self.dag.insert(event.clone()) {
            InsertResult::Inserted(id) | InsertResult::Buffered { event_id: id, .. } => {
                Some(id.to_hex())
            }
            InsertResult::Duplicate => None,
        };

        let mut outbound_messages = Vec::new();
        if should_ack_event(&event) {
            let tips: Vec<EventId> = self.dag.tips().collect();
            if !tips.is_empty() {
                if let Ok(ack) = create_ack_event(&self.keys, &tips) {
                    let ack_json = serde_json::to_string(&ack).unwrap();
                    let _ = self.dag.insert(ack.clone());
                    outbound_messages.push(ack_json);
                }
            }
        }

        PeerReaction {
            summary,
            outbound_messages,
            inserted_event_id,
            canonical_count: self.dag.canonical_events().count(),
            tip_count: self.dag.tips().count(),
        }
    }
}

#[cfg(feature = "p2p")]
pub fn parse_node_command(line: &str) -> Result<Option<NodeCommand>, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    if trimmed == "/help" || trimmed == "help" {
        return Ok(Some(NodeCommand::Help));
    }

    if trimmed == "/status" {
        return Ok(Some(NodeCommand::Status));
    }

    if trimmed == "/quit" || trimmed == "/exit" {
        return Ok(Some(NodeCommand::Quit));
    }

    if let Some(rest) = trimmed.strip_prefix("/dial ") {
        let addr = rest
            .trim()
            .parse::<Multiaddr>()
            .map_err(|err| format!("invalid multiaddr: {err}"))?;
        return Ok(Some(NodeCommand::Dial(addr)));
    }

    if let Some(rest) = trimmed.strip_prefix("/broadcast ") {
        let message = rest.trim();
        if message.is_empty() {
            return Err("/broadcast requires a message".to_string());
        }
        return Ok(Some(NodeCommand::Broadcast(message.to_string())));
    }

    Ok(Some(NodeCommand::Broadcast(trimmed.to_string())))
}

#[cfg(feature = "p2p")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InboundSummary {
    BridgeEnvelope {
        direction: String,
        topic: String,
        event_id: String,
        relay_hints: usize,
        hop_count: u64,
    },
    TransferManifest {
        root_id: String,
        total_bytes: usize,
        total_slices: usize,
        event_id: String,
    },
    TransferSlice {
        root_id: String,
        seq: usize,
        total_slices: usize,
        event_id: String,
    },
    NostrEvent {
        kind: String,
        event_id: String,
    },
    Raw {
        message: String,
    },
}

#[cfg(feature = "p2p")]
pub fn summarize_inbound_message(message: &str) -> InboundSummary {
    if let Some(envelope) = unwrap_bridge_envelope(message) {
        return InboundSummary::BridgeEnvelope {
            direction: envelope.direction,
            topic: envelope.topic,
            event_id: envelope.event.id.to_hex(),
            relay_hints: envelope.relay_hints.len(),
            hop_count: envelope.hop_count,
        };
    }

    if let Ok(event) = serde_json::from_str::<nostr::Event>(message) {
        if let Ok(payload) = parse_transfer_event(&event) {
            return match payload {
                TransferEventPayload::Manifest(manifest) => InboundSummary::TransferManifest {
                    root_id: manifest.root_id,
                    total_bytes: manifest.total_bytes,
                    total_slices: manifest.total_slices,
                    event_id: event.id.to_hex(),
                },
                TransferEventPayload::Slice(slice) => InboundSummary::TransferSlice {
                    root_id: slice.root_id,
                    seq: slice.seq,
                    total_slices: slice.total_slices,
                    event_id: event.id.to_hex(),
                },
            };
        }

        return InboundSummary::NostrEvent {
            kind: format!("{:?}", event.kind),
            event_id: event.id.to_hex(),
        };
    }

    InboundSummary::Raw {
        message: message.to_string(),
    }
}

#[cfg(feature = "p2p")]
pub fn format_inbound_summary(summary: &InboundSummary) -> String {
    match summary {
        InboundSummary::BridgeEnvelope {
            direction,
            topic,
            event_id,
            relay_hints,
            hop_count,
        } => format!(
            "INBOUND bridge direction={direction} topic={topic} event={event_id} relay_hints={relay_hints} hop_count={hop_count}"
        ),
        InboundSummary::TransferManifest {
            root_id,
            total_bytes,
            total_slices,
            event_id,
        } => format!(
            "INBOUND transfer-manifest root_id={root_id} total_bytes={total_bytes} total_slices={total_slices} event={event_id}"
        ),
        InboundSummary::TransferSlice {
            root_id,
            seq,
            total_slices,
            event_id,
        } => format!(
            "INBOUND transfer-slice root_id={root_id} seq={seq} total_slices={total_slices} event={event_id}"
        ),
        InboundSummary::NostrEvent { kind, event_id } => {
            format!("INBOUND nostr-event kind={kind} event={event_id}")
        }
        InboundSummary::Raw { message } => format!("INBOUND raw {message}"),
    }
}

#[cfg(feature = "p2p")]
fn decode_event_message(message: &str) -> Option<Event> {
    if let Some(envelope) = unwrap_bridge_envelope(message) {
        return Some(envelope.event);
    }

    serde_json::from_str::<Event>(message).ok()
}

#[cfg(feature = "p2p")]
fn should_ack_event(event: &Event) -> bool {
    event.kind != DAG_EVENT_KIND
        && event.kind != PIP_ATTEST_KIND
        && event.kind != PIP_SEAL_KIND
        && event.kind != PIP_JOIN_KIND
        && event.kind != crate::p2p::TRANSFER_MANIFEST_KIND
        && event.kind != crate::p2p::TRANSFER_SLICE_KIND
}

#[cfg(feature = "p2p")]
pub const HELP_TEXT: &str = concat!(
    "Commands:\n",
    "  /help                 show this help\n",
    "  /status               print local peer status\n",
    "  /dial <multiaddr>     dial a peer by multiaddr\n",
    "  /broadcast <message>  publish a message\n",
    "  /quit                 exit the process\n",
    "Any other non-empty line is broadcast as-is.\n",
);

#[cfg(test)]
mod tests {
    #[cfg(feature = "p2p")]
    use super::*;

    #[cfg(feature = "p2p")]
    use crate::{
        bridge_native::{build_bridge_envelope, serialize_bridge_envelope, BridgeEnvelopeMeta},
        p2p::{
            build_transfer_manifest_event, build_transfer_slice_event, packetize_payload,
            TransferManifest,
        },
    };

    #[cfg(feature = "p2p")]
    use nostr::{EventBuilder, Keys};

    #[cfg(feature = "p2p")]
    #[test]
    fn parse_node_command_recognizes_peer_controls() {
        assert!(matches!(parse_node_command("").unwrap(), None));
        assert!(matches!(
            parse_node_command("/help").unwrap(),
            Some(NodeCommand::Help)
        ));
        assert!(matches!(
            parse_node_command("/status").unwrap(),
            Some(NodeCommand::Status)
        ));
        assert!(matches!(
            parse_node_command("/quit").unwrap(),
            Some(NodeCommand::Quit)
        ));
        assert!(matches!(
            parse_node_command("/broadcast hello world").unwrap(),
            Some(NodeCommand::Broadcast(message)) if message == "hello world"
        ));
        assert!(matches!(
            parse_node_command("hello world").unwrap(),
            Some(NodeCommand::Broadcast(message)) if message == "hello world"
        ));
    }

    #[cfg(feature = "p2p")]
    #[test]
    fn classify_peer_topic_role_marks_browser_like_transports() {
        assert_eq!(
            classify_peer_topic_role_str("/ip4/127.0.0.1/tcp/4001"),
            PeerTopicRole::NativeLike
        );
        assert_eq!(
            classify_peer_topic_role_str("/dns4/example.com/tcp/443/wss/p2p/abc"),
            PeerTopicRole::WasmLike
        );
        assert_eq!(
            classify_peer_topic_role_str("/webrtc/p2p/abc"),
            PeerTopicRole::WasmLike
        );
    }

    #[cfg(feature = "p2p")]
    #[test]
    fn summarize_bridge_and_transfer_messages() {
        let keys = Keys::generate();
        let event = EventBuilder::new(nostr::Kind::Custom(21000), "{\"hello\":\"world\"}")
            .sign_with_keys(&keys)
            .unwrap();

        let envelope = build_bridge_envelope(
            event.clone(),
            "nostr->libp2p",
            ["wss://relay.one".to_string()],
            Some(BridgeEnvelopeMeta {
                topic: "nostr-dag-bridge".to_string(),
                origin_peer_id: "peer-a".to_string(),
                forwarded_by: "peer-b".to_string(),
                hop_count: 2,
                ts: Some(7),
            }),
        );
        let envelope_json = serialize_bridge_envelope(&envelope).unwrap();

        match summarize_inbound_message(&envelope_json) {
            InboundSummary::BridgeEnvelope {
                direction,
                topic,
                event_id,
                relay_hints,
                hop_count,
            } => {
                assert_eq!(direction, "nostr->libp2p");
                assert_eq!(topic, "nostr-dag-bridge");
                assert_eq!(event_id, event.id.to_hex());
                assert_eq!(relay_hints, 1);
                assert_eq!(hop_count, 2);
            }
            other => panic!("unexpected summary: {other:?}"),
        }

        let payload = b"nostr dag peer packet";
        let slices = packetize_payload("root-1", payload, 8);
        let manifest = TransferManifest {
            root_id: "root-1".to_string(),
            total_bytes: payload.len(),
            total_slices: slices.len(),
        };
        let manifest_event = build_transfer_manifest_event(&keys, &manifest).unwrap();
        let slice_event = build_transfer_slice_event(&keys, &slices[0], manifest_event.id).unwrap();

        let manifest_json = serde_json::to_string(&manifest_event).unwrap();
        match summarize_inbound_message(&manifest_json) {
            InboundSummary::TransferManifest {
                root_id,
                total_bytes,
                total_slices,
                event_id,
            } => {
                assert_eq!(root_id, "root-1");
                assert_eq!(total_bytes, payload.len());
                assert_eq!(total_slices, slices.len());
                assert_eq!(event_id, manifest_event.id.to_hex());
            }
            other => panic!("unexpected manifest summary: {other:?}"),
        }

        let slice_json = serde_json::to_string(&slice_event).unwrap();
        match summarize_inbound_message(&slice_json) {
            InboundSummary::TransferSlice {
                root_id,
                seq,
                total_slices,
                event_id,
            } => {
                assert_eq!(root_id, "root-1");
                assert_eq!(seq, 0);
                assert_eq!(total_slices, slices.len());
                assert_eq!(event_id, slice_event.id.to_hex());
            }
            other => panic!("unexpected slice summary: {other:?}"),
        }

        match summarize_inbound_message("plain-text-message") {
            InboundSummary::Raw { message } => assert_eq!(message, "plain-text-message"),
            other => panic!("unexpected raw summary: {other:?}"),
        }
    }

    #[cfg(feature = "p2p")]
    #[test]
    fn runtime_acknowledges_nostr_events_but_not_protocol_frames() {
        let runtime_keys = Keys::generate();
        let sender_keys = Keys::generate();
        let mut runtime = PeerRuntime::new_with_self_participation(runtime_keys.clone());

        let chat_event = EventBuilder::new(nostr::Kind::Custom(42), "{\"hello\":\"peer\"}")
            .sign_with_keys(&sender_keys)
            .unwrap();
        let chat_json = serde_json::to_string(&chat_event).unwrap();
        let reaction = runtime.process_inbound_message(&chat_json);

        assert!(matches!(
            reaction.summary,
            InboundSummary::NostrEvent { .. }
        ));
        assert_eq!(reaction.outbound_messages.len(), 1);
        assert!(reaction.inserted_event_id.is_some());
        assert!(reaction.canonical_count >= 1);
        assert!(reaction.tip_count >= 1);

        let payload = b"native peer protocol sample";
        let slices = packetize_payload("root-protocol", payload, 8);
        let manifest = TransferManifest {
            root_id: "root-protocol".to_string(),
            total_bytes: payload.len(),
            total_slices: slices.len(),
        };
        let manifest_event = build_transfer_manifest_event(&runtime_keys, &manifest).unwrap();
        let manifest_json = serde_json::to_string(&manifest_event).unwrap();
        let reaction = runtime.process_inbound_message(&manifest_json);

        assert!(matches!(
            reaction.summary,
            InboundSummary::TransferManifest { .. }
        ));
        assert!(reaction.outbound_messages.is_empty());
    }
}
