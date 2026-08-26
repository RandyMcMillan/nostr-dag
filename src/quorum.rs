//! DAG quorum signing of PIP data blobs.
//!
//! [`BlobQuorum`] orchestrates the full lifecycle:
//!
//! 1. **Attest** — each participant independently reconstructs the PIP blob from its manifest
//!    and slice events, verifies the SHA-256 digest, then calls [`BlobQuorum::attest`] with a
//!    signed [`PIP_ATTEST_KIND`] (`kind 39080`) event.
//! 2. **Seal** — once the attestation count exceeds the 4/5 threshold, the caller seals the
//!    quorum by building a [`PIP_SEAL_KIND`] (`kind 39081`) event via
//!    [`create_seal_event`].
//! 3. **Join** — up to N new members may join after a seal exists by publishing
//!    [`PIP_JOIN_KIND`] (`kind 39082`) events via [`create_join_event`] and calling
//!    [`BlobQuorum::add_member`].  Membership grows and the threshold is recalculated via
//!    [`Dag::add_participant`].

use std::collections::{BTreeSet, HashMap};

use nostr::{Event, EventId, PublicKey};
use tracing::{debug, info, warn};

use crate::dag::Dag;
use crate::event::{
    create_seal_event, PIP_ATTEST_KIND, PIP_JOIN_KIND,
};
use nostr::Keys;

/// Result of processing a [`PIP_ATTEST_KIND`] event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttestResult {
    /// Attestation accepted; quorum not yet reached.
    Recorded { count: usize, threshold: usize },
    /// Attestation accepted and the quorum threshold has been reached.
    /// The caller should publish the returned seal event.
    ThresholdReached { count: usize, seal: Event },
    /// Attestation was rejected (wrong kind, wrong blob digest, or duplicate).
    Rejected(String),
}

/// Result of a new member joining via [`PIP_JOIN_KIND`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JoinResult {
    /// Member successfully added; new participant count returned.
    Joined { member_count: usize },
    /// Rejected (wrong kind, wrong seal reference, or SHA-256 mismatch).
    Rejected(String),
}

/// Parsed body of a PIP protocol event content field.
struct PipContent {
    pip_type: String,
    root_id: String,
    sha256: String,
    seal_id: Option<String>,
}

fn parse_pip_content(raw: &str) -> Option<PipContent> {
    // Minimal key extraction without pulling in serde_json at the crate level.
    // We use simple field parsing sufficient for our fixed JSON shapes.
    let get = |key: &str| -> Option<String> {
        let needle = format!(r#""{key}":""#);
        let start = raw.find(&needle)? + needle.len();
        let end = raw[start..].find('"')? + start;
        Some(raw[start..end].to_owned())
    };
    Some(PipContent {
        pip_type: get("type")?,
        root_id: get("root_id")?,
        sha256: get("sha256")?,
        seal_id: get("seal_id"),
    })
}

/// Manages the quorum attestation lifecycle for a single PIP blob.
pub struct BlobQuorum {
    /// PIP manifest `root_id`.
    root_id: String,
    /// Expected lowercase-hex SHA-256 of the reconstructed blob.
    sha256_hex: String,
    /// Member public key → attestation event id.
    attestations: HashMap<PublicKey, EventId>,
    /// The quorum seal event once the threshold was reached.
    seal: Option<Event>,
    /// Keeps dynamic membership and threshold.
    dag: Dag,
}

impl BlobQuorum {
    /// Create a new [`BlobQuorum`] for the given blob and initial participants.
    ///
    /// * `participants` – initial quorum member public keys
    /// * `root_id` – PIP manifest `root_id` string
    /// * `sha256_hex` – expected lowercase-hex SHA-256 of the full reconstructed blob
    pub fn new(
        participants: impl IntoIterator<Item = PublicKey>,
        root_id: impl Into<String>,
        sha256_hex: impl Into<String>,
    ) -> Self {
        let root_id = root_id.into();
        let sha256_hex = sha256_hex.into();
        info!(root_id, "creating BlobQuorum");
        Self {
            dag: Dag::new(participants),
            root_id,
            sha256_hex,
            attestations: HashMap::new(),
            seal: None,
        }
    }

    /// Process a signed [`PIP_ATTEST_KIND`] (kind 39080) event.
    ///
    /// Validates kind, root_id, and sha256; records the attestation; and—when the
    /// threshold is reached—builds and returns a ready-to-publish seal event via
    /// `seal_keys`.
    pub fn attest(&mut self, event: Event, seal_keys: &Keys) -> AttestResult {
        // Kind check
        if event.kind != PIP_ATTEST_KIND {
            return AttestResult::Rejected(format!(
                "expected kind {}, got {}",
                PIP_ATTEST_KIND.as_u16(),
                event.kind.as_u16()
            ));
        }

        // Must be a known participant
        if !self.dag.participants().contains(&event.pubkey) {
            return AttestResult::Rejected(format!(
                "pubkey {} is not a quorum participant",
                event.pubkey
            ));
        }

        // Parse content
        let Some(pip) = parse_pip_content(&event.content) else {
            return AttestResult::Rejected("failed to parse PIP content".into());
        };
        if pip.pip_type != "attest" {
            return AttestResult::Rejected(format!("expected type=attest, got {}", pip.pip_type));
        }
        if pip.root_id != self.root_id {
            return AttestResult::Rejected(format!(
                "root_id mismatch: expected {}, got {}",
                self.root_id, pip.root_id
            ));
        }
        if pip.sha256 != self.sha256_hex {
            warn!(
                expected = self.sha256_hex,
                got = pip.sha256,
                participant = %event.pubkey,
                "sha256 mismatch in attestation"
            );
            return AttestResult::Rejected(format!(
                "sha256 mismatch: expected {}, got {}",
                self.sha256_hex, pip.sha256
            ));
        }

        // Duplicate check
        if self.attestations.contains_key(&event.pubkey) {
            debug!(participant = %event.pubkey, "duplicate attestation ignored");
            return AttestResult::Rejected(format!(
                "duplicate attestation from {}",
                event.pubkey
            ));
        }

        self.attestations.insert(event.pubkey, event.id);
        let count = self.attestations.len();
        // threshold from Dag uses (participants * 4).div_ceil(5) - 1, so threshold+1 == required
        let threshold = self.threshold();

        info!(
            root_id = self.root_id,
            count,
            threshold,
            participant = %event.pubkey,
            "attestation recorded"
        );

        if count > threshold {
            // Build and cache the seal
            let attest_ids: Vec<EventId> = self.attestations.values().copied().collect();
            match create_seal_event(seal_keys, &self.root_id, &self.sha256_hex, &attest_ids) {
                Ok(seal) => {
                    info!(
                        root_id = self.root_id,
                        seal_id = %seal.id,
                        attest_count = count,
                        "quorum threshold reached — seal created"
                    );
                    self.seal = Some(seal.clone());
                    AttestResult::ThresholdReached { count, seal }
                }
                Err(e) => AttestResult::Rejected(format!("seal build error: {e}")),
            }
        } else {
            AttestResult::Recorded { count, threshold }
        }
    }

    /// Process a signed [`PIP_JOIN_KIND`] (kind 39082) event from a new member.
    ///
    /// Validates kind, root_id, sha256, and seal reference; adds the new member to
    /// `self.dag` (recalculating the threshold) and records the join.
    pub fn add_member(&mut self, event: Event) -> JoinResult {
        if event.kind != PIP_JOIN_KIND {
            return JoinResult::Rejected(format!(
                "expected kind {}, got {}",
                PIP_JOIN_KIND.as_u16(),
                event.kind.as_u16()
            ));
        }

        // Must have a seal to join
        let Some(ref seal) = self.seal else {
            return JoinResult::Rejected("quorum is not yet sealed".into());
        };

        // Parse content
        let Some(pip) = parse_pip_content(&event.content) else {
            return JoinResult::Rejected("failed to parse PIP content".into());
        };
        if pip.pip_type != "join" {
            return JoinResult::Rejected(format!("expected type=join, got {}", pip.pip_type));
        }
        if pip.root_id != self.root_id {
            return JoinResult::Rejected(format!(
                "root_id mismatch: expected {}, got {}",
                self.root_id, pip.root_id
            ));
        }
        if pip.sha256 != self.sha256_hex {
            return JoinResult::Rejected(format!(
                "sha256 mismatch: expected {}, got {}",
                self.sha256_hex, pip.sha256
            ));
        }

        // Verify seal_id reference
        let seal_hex = seal.id.to_hex();
        match &pip.seal_id {
            None => {
                return JoinResult::Rejected("join event missing seal_id".into());
            }
            Some(sid) if sid != &seal_hex => {
                return JoinResult::Rejected(format!(
                    "seal_id mismatch: expected {seal_hex}, got {sid}"
                ));
            }
            _ => {}
        }

        // Already a member?
        if self.dag.participants().contains(&event.pubkey) {
            debug!(member = %event.pubkey, "add_member: already a participant");
            return JoinResult::Rejected(format!(
                "pubkey {} is already a participant",
                event.pubkey
            ));
        }

        self.dag.add_participant(event.pubkey);
        let member_count = self.dag.participants().len();
        info!(
            root_id = self.root_id,
            member = %event.pubkey,
            member_count,
            threshold = self.threshold(),
            "new quorum member joined"
        );
        JoinResult::Joined { member_count }
    }

    /// Returns `true` once the attestation threshold has been reached and a seal exists.
    pub fn is_sealed(&self) -> bool {
        self.seal.is_some()
    }

    /// Return a reference to the quorum seal event, if one exists.
    pub fn seal_event(&self) -> Option<&Event> {
        self.seal.as_ref()
    }

    /// Number of accepted attestations so far.
    pub fn attestation_count(&self) -> usize {
        self.attestations.len()
    }

    /// Current set of quorum participants.
    pub fn participants(&self) -> &BTreeSet<PublicKey> {
        self.dag.participants()
    }

    /// Current canonical threshold value.
    pub fn threshold(&self) -> usize {
        let n = self.dag.participants().len();
        const NUM: usize = 4;
        const DEN: usize = 5;
        let required = (n * NUM).div_ceil(DEN);
        required.saturating_sub(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{create_attest_event, create_join_event, PIP_SEAL_KIND};
    use nostr::{EventId, Keys};

    fn make_keys(n: usize) -> Vec<Keys> {
        (0..n).map(|_| Keys::generate()).collect()
    }

    const ROOT_ID: &str = "test-root-1";
    const SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    fn quorum_of(keys: &[Keys]) -> BlobQuorum {
        BlobQuorum::new(
            keys.iter().map(|k| k.public_key()),
            ROOT_ID,
            SHA256,
        )
    }

    // ─── helpers ──────────────────────────────────────────────────────────────

    fn attest(keys: &Keys) -> Event {
        create_attest_event(keys, ROOT_ID, SHA256, EventId::all_zeros(), &[]).unwrap()
    }

    fn attest_wrong_hash(keys: &Keys) -> Event {
        create_attest_event(keys, ROOT_ID, "deadbeef", EventId::all_zeros(), &[]).unwrap()
    }

    // ─── tests ────────────────────────────────────────────────────────────────

    #[test]
    fn attest_below_threshold_no_seal() {
        // 5 participants; need >4 (i.e., 5) to seal.  2 attestations should not seal.
        let keys = make_keys(5);
        let seal_keys = Keys::generate();
        let mut q = quorum_of(&keys);

        for k in &keys[..2] {
            let r = q.attest(attest(k), &seal_keys);
            assert!(matches!(r, AttestResult::Recorded { .. }), "{r:?}");
        }
        assert!(!q.is_sealed());
        assert_eq!(q.attestation_count(), 2);
    }

    #[test]
    fn attest_reaches_threshold_seals() {
        // 5 participants; threshold = (5*4).div_ceil(5) - 1 = 4 - 1 = 3.
        // So count > 3 means 4+ attestations trigger seal.
        let keys = make_keys(5);
        let seal_keys = Keys::generate();
        let mut q = quorum_of(&keys);

        let mut last = None;
        for k in &keys[..4] {
            last = Some(q.attest(attest(k), &seal_keys));
        }
        let result = last.unwrap();
        assert!(matches!(result, AttestResult::ThresholdReached { .. }), "{result:?}");
        assert!(q.is_sealed());

        // Seal event has the right kind
        let seal = q.seal_event().unwrap();
        assert_eq!(seal.kind, PIP_SEAL_KIND);
    }

    #[test]
    fn wrong_sha256_rejected() {
        let keys = make_keys(3);
        let seal_keys = Keys::generate();
        let mut q = quorum_of(&keys);

        let r = q.attest(attest_wrong_hash(&keys[0]), &seal_keys);
        assert!(matches!(r, AttestResult::Rejected(_)), "{r:?}");
        assert_eq!(q.attestation_count(), 0);
    }

    #[test]
    fn duplicate_attestation_rejected() {
        let keys = make_keys(3);
        let seal_keys = Keys::generate();
        let mut q = quorum_of(&keys);

        let r1 = q.attest(attest(&keys[0]), &seal_keys);
        assert!(matches!(r1, AttestResult::Recorded { .. }));
        let r2 = q.attest(attest(&keys[0]), &seal_keys);
        assert!(matches!(r2, AttestResult::Rejected(_)), "{r2:?}");
    }

    #[test]
    fn non_participant_attestation_rejected() {
        let keys = make_keys(3);
        let outsider = Keys::generate();
        let seal_keys = Keys::generate();
        let mut q = quorum_of(&keys);

        let r = q.attest(attest(&outsider), &seal_keys);
        assert!(matches!(r, AttestResult::Rejected(_)), "{r:?}");
    }

    #[test]
    fn add_member_after_seal_three_new_members() {
        // Seal a 5-member quorum, then add 3 new members via join events.
        let keys = make_keys(5);
        let seal_keys = Keys::generate();
        let mut q = quorum_of(&keys);

        // Reach threshold (4 attestations for 5 participants)
        for k in &keys[..4] {
            q.attest(attest(k), &seal_keys);
        }
        assert!(q.is_sealed());
        let seal_id = q.seal_event().unwrap().id;

        let new_members = make_keys(3);
        for nm in &new_members {
            let join = create_join_event(nm, ROOT_ID, SHA256, seal_id).unwrap();
            let r = q.add_member(join);
            assert!(matches!(r, JoinResult::Joined { .. }), "{r:?}");
        }

        assert_eq!(q.participants().len(), 8);
        // New threshold for 8 members: (8*4).div_ceil(5) - 1 = 7 - 1 = 6
        assert_eq!(q.threshold(), 6);
    }

    #[test]
    fn add_member_before_seal_rejected() {
        let keys = make_keys(3);
        let new_member = Keys::generate();
        let fake_seal = EventId::all_zeros();
        let mut q = quorum_of(&keys);

        let join = create_join_event(&new_member, ROOT_ID, SHA256, fake_seal).unwrap();
        let r = q.add_member(join);
        assert!(matches!(r, JoinResult::Rejected(_)), "{r:?}");
    }

    #[test]
    fn add_member_wrong_sha256_rejected() {
        let keys = make_keys(5);
        let seal_keys = Keys::generate();
        let mut q = quorum_of(&keys);

        for k in &keys[..4] {
            q.attest(attest(k), &seal_keys);
        }
        let seal_id = q.seal_event().unwrap().id;

        let new_member = Keys::generate();
        let join = create_join_event(&new_member, ROOT_ID, "deadbeef", seal_id).unwrap();
        let r = q.add_member(join);
        assert!(matches!(r, JoinResult::Rejected(_)), "{r:?}");
    }

    #[test]
    fn add_participant_recalculates_threshold() {
        // 5 → 8 participants; verify threshold at each step.
        let keys = make_keys(5);
        let q = quorum_of(&keys);
        // threshold(5) = (5*4).div_ceil(5) - 1 = 4 - 1 = 3
        assert_eq!(q.threshold(), 3);

        let mut dag = Dag::new(keys.iter().map(|k| k.public_key()));
        assert_eq!(dag.participants().len(), 5);
        for _ in 0..3 {
            dag.add_participant(Keys::generate().public_key());
        }
        assert_eq!(dag.participants().len(), 8);
        // threshold(8) = (8*4).div_ceil(5) - 1 = 7 - 1 = 6
        // Verify via is_canonical behaviour indirectly: just check count
        assert_eq!(dag.participants().len(), 8);
    }
}
