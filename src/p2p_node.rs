#[cfg(feature = "p2p")]
use libp2p::Multiaddr;

#[cfg(feature = "p2p")]
use crate::{
    bridge_native::unwrap_bridge_envelope,
    p2p::{parse_transfer_event, TransferEventPayload},
};

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
}
