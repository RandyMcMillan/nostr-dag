mod assets;
#[cfg(feature = "native")]
mod bridge_native;
mod bridge_roundtrip;
mod bft_time;
mod dag;
mod error;
mod event;
#[cfg(feature = "native")]
pub mod native_cli;
pub mod nip34;
pub mod quorum;
pub mod rbsr;
#[cfg(feature = "native")]
pub mod store;

#[cfg(feature = "native")]
pub mod git;
#[cfg(feature = "native")]
pub mod server;

#[cfg(feature = "wasm")]
pub mod git_wasm;

#[cfg(any(feature = "p2p", feature = "p2p-wasm"))]
pub mod p2p;
#[cfg(feature = "p2p")]
pub mod p2p_node;

pub use assets::FAVICON_ICO;
pub use assets::{ICON_CIRCLE_BITCOIN_SVG, ICON_CIRCLE_WHITE_SVG};
#[cfg(feature = "native")]
pub use bridge_native::{
    build_bridge_envelope, collect_bridge_relay_hints, serialize_bridge_envelope,
    unwrap_bridge_envelope, BridgeEnvelope, BridgeEnvelopeMeta, BridgeRoundTripMetrics,
    BRIDGE_PROTOCOL, BRIDGE_PROTOCOL_VERSION,
};
pub use bridge_roundtrip::{
    extract_bridge_round_trip_start_ms, stamp_bridge_round_trip_tag, BRIDGE_RTT_TAG,
};
pub use dag::{Dag, InsertResult};
pub use error::DagError;
pub use event::{
    create_ack_event, create_attest_event, create_join_event, create_seal_event, parents_of,
    DAG_EVENT_KIND, PIP_ATTEST_KIND, PIP_JOIN_KIND, PIP_SEAL_KIND,
};
pub use nip34::{
    git_remote_helper_url, git_remote_transport_url, normalize_nostr_clone_url,
    normalize_p2p_clone_url, nostr_to_p2p_clone_url, p2p_to_nostr_clone_url, parse_nostr_clone_url,
    parse_p2p_clone_url, Nip34Error, NostrRemote,
};
pub use quorum::{AttestResult, BlobQuorum, JoinResult};
#[cfg(feature = "native")]
pub use native_cli::run_federation;
#[cfg(feature = "relay")]
pub use native_cli::run_local_relay;
#[cfg(feature = "p2p")]
pub use p2p_node::run_native_p2p_node;
#[cfg(feature = "native")]
pub use native_cli::run_keygen;
#[cfg(feature = "native")]
pub use native_cli::run_git_info;
#[cfg(feature = "db-viewer")]
pub mod db_viewer;
#[cfg(feature = "db-viewer")]
pub use db_viewer::run_db_viewer;

#[cfg(feature = "wasm")]
mod wasm {
    use crate::bridge_roundtrip::{
        extract_bridge_round_trip_start_ms, stamp_bridge_round_trip_tag,
    };
    use serde_wasm_bindgen::{from_value, to_value};
    use wasm_bindgen::prelude::*;

    use crate::dag::{Dag, InsertResult};

    #[wasm_bindgen]
    pub struct WasmDag {
        inner: Dag,
    }

    #[wasm_bindgen]
    impl WasmDag {
        /// Create a new DAG with the given participant public keys (hex strings).
        #[wasm_bindgen(constructor)]
        pub fn new(pubkeys_json: &str) -> Result<WasmDag, JsValue> {
            let hex_keys: Vec<String> = serde_json::from_str(pubkeys_json)
                .map_err(|e| JsValue::from_str(&e.to_string()))?;

            let participants: Result<Vec<nostr::PublicKey>, _> = hex_keys
                .iter()
                .map(|h| nostr::PublicKey::from_hex(h))
                .collect();
            let participants =
                participants.map_err(|e: nostr::key::Error| JsValue::from_str(&e.to_string()))?;

            Ok(WasmDag {
                inner: Dag::new(participants),
            })
        }

        /// Insert a JSON-serialised Nostr event.
        /// Returns a JSON string with the result: `{"type":"Inserted","id":"..."}`,
        /// `{"type":"Buffered","id":"...","missing":[...]}`, or `{"type":"Duplicate"}`.
        pub fn insert(&mut self, event_json: &str) -> Result<String, JsValue> {
            let event: nostr::Event =
                serde_json::from_str(event_json).map_err(|e| JsValue::from_str(&e.to_string()))?;

            let result = self.inner.insert(event);
            let json = match result {
                InsertResult::Inserted(id) => {
                    format!(r#"{{"type":"Inserted","id":"{}"}}"#, id.to_hex())
                }
                InsertResult::Buffered { event_id, missing } => {
                    let missing_json: Vec<String> = missing.iter().map(|id| id.to_hex()).collect();
                    format!(
                        r#"{{"type":"Buffered","id":"{}","missing":{}}}"#,
                        event_id.to_hex(),
                        serde_json::to_string(&missing_json).unwrap()
                    )
                }
                InsertResult::Duplicate => r#"{"type":"Duplicate"}"#.to_string(),
            };
            Ok(json)
        }

        /// Return the IDs (hex) of all canonical events as a JSON array.
        pub fn canonical_ids(&self) -> String {
            let ids: Vec<String> = self
                .inner
                .canonical_events()
                .map(|id| id.to_hex())
                .collect();
            serde_json::to_string(&ids).unwrap()
        }

        /// Return the IDs (hex) of current DAG tips as a JSON array.
        pub fn tip_ids(&self) -> String {
            let ids: Vec<String> = self.inner.tips().map(|id| id.to_hex()).collect();
            serde_json::to_string(&ids).unwrap()
        }
    }

    /// Append the bridge RTT marker tag to an array of tags, replacing any previous marker.
    #[wasm_bindgen(js_name = stampBridgeRoundTripTag)]
    pub fn stamp_bridge_round_trip_tag_js(
        tags: JsValue,
        started_at_ms: i64,
    ) -> Result<JsValue, JsValue> {
        let tags: Vec<nostr::Tag> =
            from_value(tags).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let stamped = stamp_bridge_round_trip_tag(&tags, started_at_ms);
        to_value(&stamped).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Read the bridge RTT marker from a Nostr event and return the start timestamp in ms.
    #[wasm_bindgen(js_name = extractBridgeRoundTripStartMs)]
    pub fn extract_bridge_round_trip_start_ms_js(event: JsValue) -> Result<Option<i64>, JsValue> {
        let event: nostr::Event =
            from_value(event).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(extract_bridge_round_trip_start_ms(&event))
    }
}
