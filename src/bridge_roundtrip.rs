use nostr::{Event, Tag};

pub const BRIDGE_RTT_TAG: &str = "bridge-rtt";

pub fn stamp_bridge_round_trip_tag(tags: &[Tag], started_at_ms: i64) -> Vec<Tag> {
    let mut stamped: Vec<Tag> = tags
        .iter()
        .filter(|tag| !is_bridge_round_trip_tag(tag))
        .cloned()
        .collect();
    stamped.push(make_bridge_round_trip_tag(started_at_ms));
    stamped
}

pub fn extract_bridge_round_trip_start_ms(event: &Event) -> Option<i64> {
    event
        .tags
        .as_slice()
        .iter()
        .find_map(extract_bridge_round_trip_start_ms_from_tag)
}

fn make_bridge_round_trip_tag(started_at_ms: i64) -> Tag {
    Tag::parse(vec![BRIDGE_RTT_TAG.to_string(), started_at_ms.to_string()])
        .expect("bridge round-trip tag is valid")
}

fn is_bridge_round_trip_tag(tag: &Tag) -> bool {
    let parts = tag.as_slice();
    matches!(parts.first().map(|s| s.as_str()), Some(BRIDGE_RTT_TAG))
}

fn extract_bridge_round_trip_start_ms_from_tag(tag: &Tag) -> Option<i64> {
    let parts = tag.as_slice();
    match parts {
        [kind, value] if kind == BRIDGE_RTT_TAG => value.parse::<i64>().ok(),
        [kind, marker, value] if kind == "x" && marker == BRIDGE_RTT_TAG => value.parse::<i64>().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::EventBuilder;
    use nostr::Keys;

    #[test]
    fn stamp_bridge_round_trip_tag_appends_marker() {
        let tags = vec![Tag::parse(vec!["e".to_string(), "parent".to_string()]).expect("parent tag should parse")];
        let stamped = stamp_bridge_round_trip_tag(&tags, 12_345);

        assert_eq!(tags.len(), 1);
        assert_eq!(stamped.len(), 2);
        assert_eq!(stamped[1].as_slice(), &[BRIDGE_RTT_TAG.to_string(), "12345".to_string()]);
    }

    #[test]
    fn extract_bridge_round_trip_start_ms_reads_standard_marker() {
        let keys = Keys::generate();
        let event = EventBuilder::new(nostr::Kind::Custom(21000), "")
            .tags([make_bridge_round_trip_tag(54_321)])
            .sign_with_keys(&keys)
            .expect("event should sign");

        assert_eq!(extract_bridge_round_trip_start_ms(&event), Some(54_321));
    }

    #[test]
    fn extract_bridge_round_trip_start_ms_reads_nested_marker_shape() {
        let keys = Keys::generate();
        let event = EventBuilder::new(nostr::Kind::Custom(21000), "")
            .tags([Tag::parse(vec![
                "x".to_string(),
                BRIDGE_RTT_TAG.to_string(),
                "9876".to_string(),
            ]).expect("nested marker tag should parse")])
            .sign_with_keys(&keys)
            .expect("event should sign");

        assert_eq!(extract_bridge_round_trip_start_ms(&event), Some(9_876));
    }
}
