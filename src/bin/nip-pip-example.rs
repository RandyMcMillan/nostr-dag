//! Native NIP-PIP round-trip example with RTT tracking.
//!
//! Run with:
//!   cargo run --bin nip-pip-example --features p2p
//!
//! This builds a small payload, packetizes it into a deterministic chain of
//! manifest + slice Nostr events, stamps every event with a `bridge-rtt` tag,
//! reconstructs the payload, and prints the event IDs and parent chain.

use nostr_dag::extract_bridge_round_trip_start_ms;
use nostr_dag::p2p::{
    encode_payload_as_transfer_events_chained, parse_transfer_event, reconstruct_payload,
    TransferEventPayload,
};

fn main() {
    let keys = nostr::Keys::generate();
    let payload = b"hello nip-pip rtt example";
    let root_id = "nip-pip-example-native";
    let rtt_start = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let (manifest_event, slice_events) =
        encode_payload_as_transfer_events_chained(&keys, root_id, payload, 8, Some(rtt_start), None)
            .expect("encode chained transfer events");

    let manifest_rtt = extract_bridge_round_trip_start_ms(&manifest_event).unwrap();

    println!("=== NIP-PIP RTT round-trip (native example) ===");
    println!("  root_id      {root_id}");
    println!("  payload      {} bytes", payload.len());
    println!("  slices       {}", slice_events.len());
    println!("  manifest     {} rtt={manifest_rtt}", manifest_event.id);

    let mut previous_id = manifest_event.id;
    for (seq, ev) in slice_events.iter().enumerate() {
        let rtt = extract_bridge_round_trip_start_ms(ev).unwrap();
        let parent_tag = ev
            .tags
            .iter()
            .find(|t| t.as_slice().first().map(|s| s.as_str()) == Some("e"))
            .and_then(|t| t.as_slice().get(1))
            .map(|s| s.as_str())
            .unwrap_or("?");
        println!("  slice[{seq}]   {} rtt={rtt} parent={parent_tag}", ev.id);
        assert_eq!(parent_tag, &previous_id.to_hex(), "slice {seq} parent mismatch");
        previous_id = ev.id;
    }

    let received_slices: Vec<_> = slice_events
        .iter()
        .map(|ev| match parse_transfer_event(ev).unwrap() {
            TransferEventPayload::Slice(s) => s,
            other => panic!("expected slice, got {other:?}"),
        })
        .collect();

    let reconstructed = reconstruct_payload(&received_slices).unwrap();
    assert_eq!(reconstructed.as_slice(), payload.as_slice());
    println!("  reconstructed  {} bytes  OK", reconstructed.len());
}
