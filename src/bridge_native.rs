use std::collections::HashSet;

use nostr::Event;

#[cfg(feature = "native")]
use serde::{Deserialize, Serialize};

pub const BRIDGE_PROTOCOL: &str = "nostr-dag-bridge";
pub const BRIDGE_PROTOCOL_VERSION: u64 = 1;

#[cfg_attr(feature = "native", derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize))]
#[cfg_attr(not(feature = "native"), derive(Debug, Clone, PartialEq, Eq))]
pub struct BridgeEnvelope {
    pub protocol: String,
    pub version: u64,
    pub direction: String,
    pub event: Event,
    pub relay_hints: Vec<String>,
    pub topic: String,
    pub origin_peer_id: String,
    pub forwarded_by: String,
    pub hop_count: u64,
    pub ts: u64,
}

impl BridgeEnvelope {
    pub fn new(event: Event, direction: impl Into<String>, relay_hints: impl IntoIterator<Item = String>) -> Self {
        Self {
            protocol: BRIDGE_PROTOCOL.to_string(),
            version: BRIDGE_PROTOCOL_VERSION,
            direction: direction.into(),
            event,
            relay_hints: dedupe_relay_hints(relay_hints),
            topic: String::new(),
            origin_peer_id: String::new(),
            forwarded_by: String::new(),
            hop_count: 0,
            ts: now_ms(),
        }
    }
}

#[cfg(feature = "native")]
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct BridgeEnvelopeMeta {
    pub topic: String,
    pub origin_peer_id: String,
    pub forwarded_by: String,
    pub hop_count: u64,
    pub ts: Option<u64>,
}

#[cfg(feature = "native")]
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct BridgeRoundTripMetrics {
    pub sample_count: u64,
    pub total_ms: u64,
    pub last_ms: Option<u64>,
    pub min_ms: Option<u64>,
    pub max_ms: Option<u64>,
    pub last_event_id: Option<String>,
    pub last_relay: Option<String>,
}

#[cfg(feature = "native")]
impl BridgeRoundTripMetrics {
    pub fn record_sample(&mut self, elapsed_ms: u64, event_id: impl Into<String>, relay: impl Into<String>) {
        let event_id = event_id.into();
        let relay = relay.into();
        self.sample_count = self.sample_count.saturating_add(1);
        self.total_ms = self.total_ms.saturating_add(elapsed_ms);
        self.last_ms = Some(elapsed_ms);
        self.min_ms = Some(self.min_ms.map_or(elapsed_ms, |current| current.min(elapsed_ms)));
        self.max_ms = Some(self.max_ms.map_or(elapsed_ms, |current| current.max(elapsed_ms)));
        self.last_event_id = if event_id.is_empty() { None } else { Some(event_id) };
        self.last_relay = if relay.is_empty() { None } else { Some(relay) };
    }

    pub fn average_ms(&self) -> Option<u64> {
        if self.sample_count == 0 {
            None
        } else {
            Some(self.total_ms / self.sample_count)
        }
    }
}

pub fn build_bridge_envelope(
    event: Event,
    direction: impl Into<String>,
    relay_hints: impl IntoIterator<Item = String>,
    meta: Option<BridgeEnvelopeMeta>,
) -> BridgeEnvelope {
    let mut envelope = BridgeEnvelope::new(event, direction, relay_hints);
    if let Some(meta) = meta {
        envelope.topic = meta.topic;
        envelope.origin_peer_id = meta.origin_peer_id;
        envelope.forwarded_by = meta.forwarded_by;
        envelope.hop_count = meta.hop_count;
        envelope.ts = meta.ts.unwrap_or_else(now_ms);
    }
    envelope
}

#[cfg(feature = "native")]
pub fn serialize_bridge_envelope(envelope: &BridgeEnvelope) -> Result<String, serde_json::Error> {
    serde_json::to_string(envelope)
}

pub fn unwrap_bridge_envelope(message: &str) -> Option<BridgeEnvelope> {
    let parsed: serde_json::Value = serde_json::from_str(message).ok()?;
    let protocol = parsed.get("protocol").or_else(|| parsed.get("source"))?.as_str()?;
    if protocol != BRIDGE_PROTOCOL && protocol != "nostr-dag-bridge" {
        return None;
    }

    let event_value = parsed
        .get("event")
        .cloned()
        .or_else(|| parsed.get("payload").and_then(serde_json::Value::as_object).and_then(|payload| payload.get("event")).cloned())
        .or_else(|| parsed.get("payload").cloned())?;
    let event: Event = serde_json::from_value(event_value).ok()?;

    Some(BridgeEnvelope {
        protocol: protocol.to_string(),
        version: parsed.get("version").and_then(serde_json::Value::as_u64).unwrap_or(BRIDGE_PROTOCOL_VERSION),
        direction: parsed.get("direction").and_then(serde_json::Value::as_str).unwrap_or("libp2p->nostr").to_string(),
        event,
        relay_hints: collect_bridge_relay_hints(&parsed),
        topic: parsed.get("topic").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
        origin_peer_id: parsed
            .get("origin_peer_id")
            .or_else(|| parsed.get("originPeerId"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string(),
        forwarded_by: parsed
            .get("forwarded_by")
            .or_else(|| parsed.get("forwardedBy"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string(),
        hop_count: parsed.get("hop_count").or_else(|| parsed.get("hopCount")).and_then(serde_json::Value::as_u64).unwrap_or(0),
        ts: parsed.get("ts").and_then(serde_json::Value::as_u64).unwrap_or_else(now_ms),
    })
}

pub fn collect_bridge_relay_hints(payload: &serde_json::Value) -> Vec<String> {
    let mut hints = Vec::new();
    let mut seen = HashSet::new();
    collect_bridge_relay_hints_inner(payload, &mut hints, &mut seen, true);
    hints
}

fn collect_bridge_relay_hints_inner(
    payload: &serde_json::Value,
    found: &mut Vec<String>,
    seen: &mut HashSet<String>,
    top_level: bool,
) {
    match payload {
        serde_json::Value::String(value) => {
            let trimmed = value.trim();
            if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
                found.push(trimmed.to_string());
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_bridge_relay_hints_inner(item, found, seen, false);
            }
        }
        serde_json::Value::Object(map) => {
            if top_level {
                for key in ["relay_hints", "relayHints", "relays", "relayTargets"] {
                    if let Some(value) = map.get(key) {
                        collect_bridge_relay_hints_inner(value, found, seen, false);
                    }
                }
            } else {
                for value in map.values() {
                    collect_bridge_relay_hints_inner(value, found, seen, false);
                }
            }
        }
        _ => {}
    }
}

fn dedupe_relay_hints<I>(relay_hints: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut seen = HashSet::new();
    let mut ordered = Vec::new();
    for hint in relay_hints {
        let hint = hint.trim().to_string();
        if hint.is_empty() || !seen.insert(hint.clone()) {
            continue;
        }
        ordered.push(hint);
    }
    ordered
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Tag};

    fn make_event() -> Event {
        let keys = Keys::generate();
        EventBuilder::new(nostr::Kind::Custom(21000), "{}")
            .tags([Tag::parse(vec!["bridge-rtt".to_string(), "12345".to_string()]).unwrap()])
            .sign_with_keys(&keys)
            .unwrap()
    }

    #[test]
    fn bridge_envelope_roundtrip_preserves_fields() {
        let event = make_event();
        let envelope = build_bridge_envelope(
            event.clone(),
            "nostr->libp2p",
            ["wss://relay.one".to_string(), "wss://relay.two".to_string()],
            Some(BridgeEnvelopeMeta {
                topic: "nostr/bridge".to_string(),
                origin_peer_id: "peer-a".to_string(),
                forwarded_by: "peer-b".to_string(),
                hop_count: 3,
                ts: Some(99),
            }),
        );

        let json = serialize_bridge_envelope(&envelope).unwrap();
        let decoded = unwrap_bridge_envelope(&json).unwrap();

        assert_eq!(decoded.protocol, BRIDGE_PROTOCOL);
        assert_eq!(decoded.version, BRIDGE_PROTOCOL_VERSION);
        assert_eq!(decoded.direction, "nostr->libp2p");
        assert_eq!(decoded.topic, "nostr/bridge");
        assert_eq!(decoded.origin_peer_id, "peer-a");
        assert_eq!(decoded.forwarded_by, "peer-b");
        assert_eq!(decoded.hop_count, 3);
        assert_eq!(decoded.relay_hints, vec!["wss://relay.one".to_string(), "wss://relay.two".to_string()]);
        assert_eq!(decoded.event.id, event.id);
    }

    #[test]
    fn collect_bridge_relay_hints_flattens_nested_values() {
        let value = serde_json::json!({
            "relay_hints": ["wss://relay.one", ["wss://relay.two", "wss://relay.one"]],
            "relayTargets": {"a": "wss://relay.three"},
        });

        let hints = collect_bridge_relay_hints(&value);
        assert_eq!(hints, vec![
            "wss://relay.one".to_string(),
            "wss://relay.two".to_string(),
            "wss://relay.three".to_string(),
        ]);
    }

    #[test]
    fn bridge_round_trip_metrics_records_samples() {
        let mut metrics = BridgeRoundTripMetrics::default();
        metrics.record_sample(42, "event-a", "wss://relay.one");
        metrics.record_sample(84, "event-b", "wss://relay.two");

        assert_eq!(metrics.sample_count, 2);
        assert_eq!(metrics.total_ms, 126);
        assert_eq!(metrics.average_ms(), Some(63));
        assert_eq!(metrics.min_ms, Some(42));
        assert_eq!(metrics.max_ms, Some(84));
        assert_eq!(metrics.last_event_id.as_deref(), Some("event-b"));
        assert_eq!(metrics.last_relay.as_deref(), Some("wss://relay.two"));
    }
}
