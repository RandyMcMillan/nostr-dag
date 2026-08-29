use nostr::{Event, EventBuilder, EventId, Keys, Kind, Tag};
use tracing::trace;

pub const DAG_EVENT_KIND: Kind = Kind::Custom(21000);

/// PIP Blob Attestation event (kind 39080).
///
/// A quorum member publishes this to attest they have independently reconstructed and
/// SHA-256-verified a PIP blob identified by `root_id`.  The content is a JSON object:
/// ```json
/// {
///   "protocol": "nostr-dag-transfer",
///   "version": 1,
///   "type": "attest",
///   "root_id": "<manifest root_id>",
///   "sha256": "<lowercase hex sha256 of reconstructed blob>",
///   "manifest_id": "<hex event id of the manifest event>"
/// }
/// ```
/// `e` tags reference the manifest event id and all slice event ids.
pub const PIP_ATTEST_KIND: Kind = Kind::Custom(39080);

/// PIP Quorum Seal event (kind 39081).
///
/// Published (by any participant) once the attestation threshold has been reached.
/// Content:
/// ```json
/// {
///   "protocol": "nostr-dag-transfer",
///   "version": 1,
///   "type": "seal",
///   "root_id": "<manifest root_id>",
///   "sha256": "<lowercase hex sha256>",
///   "attest_ids": ["<hex attestation event id>", ...]
/// }
/// ```
pub const PIP_SEAL_KIND: Kind = Kind::Custom(39081);

/// PIP Quorum Membership event (kind 39082).
///
/// A new participant publishes this to join an already-sealed quorum, proving they
/// independently verified the blob.  Content:
/// ```json
/// {
///   "protocol": "nostr-dag-transfer",
///   "version": 1,
///   "type": "join",
///   "root_id": "<manifest root_id>",
///   "sha256": "<lowercase hex sha256>",
///   "seal_id": "<hex event id of the quorum seal>"
/// }
/// ```
/// The event carries an `e` tag referencing the seal event.
pub const PIP_JOIN_KIND: Kind = Kind::Custom(39082);

pub fn create_ack_event(
    keys: &Keys,
    parents: &[EventId],
) -> Result<Event, nostr::event::builder::Error> {
    trace!(parent_count = parents.len(), "creating ack event");
    let tags: Vec<Tag> = parents.iter().map(|id| Tag::event(*id)).collect();

    EventBuilder::new(DAG_EVENT_KIND, "")
        .tags(tags)
        .sign_with_keys(keys)
}

/// Build a PIP Blob Attestation event (kind 39080).
///
/// * `keys` – signing keypair of the attesting participant
/// * `root_id` – PIP manifest `root_id` string
/// * `sha256_hex` – lowercase hex SHA-256 of the fully reconstructed blob
/// * `manifest_event_id` – Nostr event id of the manifest event
/// * `slice_event_ids` – Nostr event ids of every slice event
pub fn create_attest_event(
    keys: &Keys,
    root_id: &str,
    sha256_hex: &str,
    manifest_event_id: EventId,
    slice_event_ids: &[EventId],
) -> Result<Event, nostr::event::builder::Error> {
    trace!(root_id, "creating PIP attest event");
    let content = format!(
        r#"{{"protocol":"nostr-dag-transfer","version":1,"type":"attest","root_id":"{root_id}","sha256":"{sha256_hex}","manifest_id":"{manifest_id}"}}"#,
        root_id = root_id,
        sha256_hex = sha256_hex,
        manifest_id = manifest_event_id.to_hex(),
    );
    let mut tags: Vec<Tag> = Vec::with_capacity(4 + 1 + slice_event_ids.len());
    tags.push(Tag::hashtag("nostr-dag"));
    tags.push(Tag::hashtag("nip-pip"));
    tags.push(Tag::hashtag("transfer"));
    tags.push(Tag::event(manifest_event_id));
    for sid in slice_event_ids {
        tags.push(Tag::event(*sid));
    }
    EventBuilder::new(PIP_ATTEST_KIND, content)
        .tags(tags)
        .sign_with_keys(keys)
}

/// Build a PIP Quorum Seal event (kind 39081).
///
/// * `keys` – signing keypair of the publisher
/// * `root_id` – PIP manifest `root_id` string
/// * `sha256_hex` – lowercase hex SHA-256 of the blob
/// * `attest_event_ids` – Nostr event ids of all contributing attestation events
pub fn create_seal_event(
    keys: &Keys,
    root_id: &str,
    sha256_hex: &str,
    attest_event_ids: &[EventId],
) -> Result<Event, nostr::event::builder::Error> {
    trace!(
        root_id,
        attest_count = attest_event_ids.len(),
        "creating PIP seal event"
    );
    let ids_json: Vec<String> = attest_event_ids
        .iter()
        .map(|id| format!(r#""{}""#, id.to_hex()))
        .collect();
    let ids_arr = format!("[{}]", ids_json.join(","));
    let content = format!(
        r#"{{"protocol":"nostr-dag-transfer","version":1,"type":"seal","root_id":"{root_id}","sha256":"{sha256_hex}","attest_ids":{attest_ids}}}"#,
        root_id = root_id,
        sha256_hex = sha256_hex,
        attest_ids = ids_arr,
    );
    let mut tags: Vec<Tag> = vec![
        Tag::hashtag("nostr-dag"),
        Tag::hashtag("nip-pip"),
        Tag::hashtag("transfer"),
    ];
    for id in attest_event_ids {
        tags.push(Tag::event(*id));
    }
    EventBuilder::new(PIP_SEAL_KIND, content)
        .tags(tags)
        .sign_with_keys(keys)
}

/// Build a PIP Quorum Membership (join) event (kind 39082).
///
/// * `keys` – signing keypair of the new member
/// * `root_id` – PIP manifest `root_id` string
/// * `sha256_hex` – lowercase hex SHA-256 of the blob (must match the seal)
/// * `seal_event_id` – Nostr event id of the quorum seal event being joined
pub fn create_join_event(
    keys: &Keys,
    root_id: &str,
    sha256_hex: &str,
    seal_event_id: EventId,
) -> Result<Event, nostr::event::builder::Error> {
    trace!(root_id, "creating PIP join event");
    let content = format!(
        r#"{{"protocol":"nostr-dag-transfer","version":1,"type":"join","root_id":"{root_id}","sha256":"{sha256_hex}","seal_id":"{seal_id}"}}"#,
        root_id = root_id,
        sha256_hex = sha256_hex,
        seal_id = seal_event_id.to_hex(),
    );
    EventBuilder::new(PIP_JOIN_KIND, content)
        .tags([
            Tag::hashtag("nostr-dag"),
            Tag::hashtag("nip-pip"),
            Tag::hashtag("transfer"),
            Tag::event(seal_event_id),
        ])
        .sign_with_keys(keys)
}

pub fn parents_of(event: &Event) -> impl Iterator<Item = EventId> + '_ {
    trace!(event_id = %event.id, "reading event parents");
    event.tags.event_ids().copied()
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;

    #[test]
    fn dag_event_kind_is_custom_21000() {
        assert_eq!(DAG_EVENT_KIND, Kind::Custom(21000));
    }

    #[test]
    fn create_ack_event_no_parents() {
        let keys = Keys::generate();
        let event = create_ack_event(&keys, &[]).unwrap();
        assert_eq!(event.kind, DAG_EVENT_KIND);
        assert_eq!(event.pubkey, keys.public_key());
        assert_eq!(parents_of(&event).count(), 0);
    }

    #[test]
    fn create_ack_event_with_parents() {
        let keys = Keys::generate();
        let genesis = create_ack_event(&keys, &[]).unwrap();
        let child = create_ack_event(&keys, &[genesis.id]).unwrap();
        let collected: Vec<EventId> = parents_of(&child).collect();
        assert_eq!(collected, vec![genesis.id]);
    }

    #[test]
    fn create_ack_event_multiple_parents() {
        let keys = Keys::generate();
        let a = create_ack_event(&keys, &[]).unwrap();
        let b = create_ack_event(&keys, &[]).unwrap();
        let merge = create_ack_event(&keys, &[a.id, b.id]).unwrap();
        let parents: Vec<EventId> = parents_of(&merge).collect();
        assert_eq!(parents.len(), 2);
        assert!(parents.contains(&a.id));
        assert!(parents.contains(&b.id));
    }

    #[test]
    fn parents_of_no_event_tags() {
        let keys = Keys::generate();
        let event = create_ack_event(&keys, &[]).unwrap();
        assert_eq!(parents_of(&event).count(), 0);
    }
}
