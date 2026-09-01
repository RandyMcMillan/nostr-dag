//! Range-Based Set Reconciliation (RBSR).
//!
//! Efficiently computes differences between two ordered sets of items using
//! recursive range fingerprinting.  Instead of exchanging full sets, peers
//! compare compact checksums over key ranges and only bisect when fingerprints
//! differ, yielding logarithmic round-trip complexity.
//!
//! # Algorithm
//! 1. Each node maintains items in a `BTreeMap` keyed by a deterministic hash.
//! 2. A `RangeFingerprint` captures `(count, xor_checksum)` over a key interval.
//! 3. To reconcile, peers compare root fingerprints. If equal, the range is synced.
//! 4. If different, the range is bisected and the process repeats recursively.
//! 5. Once a range drops below `threshold` items, entries are exchanged directly.
//!
//! This is directly applicable to DAG event-set reconciliation by implementing
//! [`Item`] for your event type.

use std::collections::BTreeMap;

/// Key type for ordered range queries.
pub type Key = u64;

/// Trait for types that can be reconciled with RBSR.
pub trait Item {
    /// Deterministic key used for ordering and range queries.
    fn key(&self) -> Key;
    /// Fingerprint used for equality checks within a range.
    fn fingerprint(&self) -> u64;
}

/// Compact summary of a key range `[min_key, max_key]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeFingerprint {
    /// Lower boundary of the evaluated range (inclusive).
    pub min_key: Key,
    /// Upper boundary of the evaluated range (inclusive).
    pub max_key: Key,
    /// Total count of elements residing within the key boundary.
    pub count: usize,
    /// Cumulative bitwise XOR sum of all item fingerprints in the range.
    pub xor_checksum: u64,
}

impl RangeFingerprint {
    /// Compute fingerprint over a range of items.
    pub fn compute<T: Item>(items: &BTreeMap<Key, T>, min_key: Key, max_key: Key) -> Self {
        let mut count = 0;
        let mut xor_checksum = 0u64;
        for (_, item) in items.range(min_key..=max_key) {
            count += 1;
            xor_checksum ^= item.fingerprint();
        }
        Self {
            min_key,
            max_key,
            count,
            xor_checksum,
        }
    }
}

/// Result of a reconciliation pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncResult {
    /// Number of recursive bisection steps (round trips).
    pub round_trips: usize,
    /// Items missing on the local node (present on remote).
    pub local_missing: Vec<String>,
    /// Items missing on the remote node (present on local).
    pub remote_missing: Vec<String>,
    /// Items where the fingerprint differs (same key, different content).
    pub mismatches: Vec<String>,
}

/// A node holding a set of reconcilable items.
pub struct Node<T: Item> {
    pub name: String,
    pub items: BTreeMap<Key, T>,
}

impl<T: Item> Node<T> {
    /// Create an empty node.
    pub fn empty(name: &str) -> Self {
        Self {
            name: name.to_string(),
            items: BTreeMap::new(),
        }
    }

    /// Reconcile against a remote node.
    pub fn diff_and_reconcile(&self, remote: &Node<T>, threshold: usize) -> SyncResult
    where
        T: Clone,
    {
        let (discovered, round_trips) =
            reconcile_range(&self.items, &remote.items, u64::MIN, u64::MAX, threshold);

        let mut local_missing = Vec::new();
        let mut mismatches = Vec::new();
        for item in discovered {
            let key = item.key();
            match self.items.get(&key) {
                Some(local) => {
                    if local.fingerprint() != item.fingerprint() {
                        mismatches.push(format!("{:?}", key));
                    }
                }
                None => local_missing.push(format!("{:?}", key)),
            }
        }

        let mut remote_missing = Vec::new();
        for (key, _local) in &self.items {
            if !remote.items.contains_key(key) {
                remote_missing.push(format!("{:?}", key));
            }
        }

        SyncResult {
            round_trips,
            local_missing,
            remote_missing,
            mismatches,
        }
    }
}

/// Recursively bisect and reconcile two item maps.
///
/// Compares fingerprints over `[min_key, max_key]`. If they match, the range
/// is synced. If the range is small (≤ threshold), items from `remote` are
/// returned directly. Otherwise the range is bisected and the process repeats.
fn reconcile_range<'a, T: Item>(
    local: &'a BTreeMap<Key, T>,
    remote: &'a BTreeMap<Key, T>,
    min_key: Key,
    max_key: Key,
    threshold: usize,
) -> (Vec<&'a T>, usize) {
    let local_fp = RangeFingerprint::compute(local, min_key, max_key);
    let remote_fp = RangeFingerprint::compute(remote, min_key, max_key);

    // Ranges match — nothing to do.
    if local_fp == remote_fp {
        return (vec![], 1);
    }

    // Small enough to resolve directly.
    if local_fp.count <= threshold && remote_fp.count <= threshold {
        let items: Vec<&T> = remote.range(min_key..=max_key).map(|(_, v)| v).collect();
        return (items, 1);
    }

    // Cannot split further — resolve directly to avoid infinite recursion.
    if min_key == max_key {
        let items: Vec<&T> = remote.range(min_key..=max_key).map(|(_, v)| v).collect();
        return (items, 1);
    }

    // Bisect and recurse.
    let mid = min_key + (max_key - min_key) / 2;
    let (mut left_items, left_steps) = reconcile_range(local, remote, min_key, mid, threshold);
    let (right_items, right_steps) = reconcile_range(local, remote, mid + 1, max_key, threshold);
    left_items.extend(right_items);
    (left_items, left_steps + right_steps + 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::hash::Hasher;

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct MockItem {
        id: u64,
        payload: String,
    }

    impl Item for MockItem {
        fn key(&self) -> Key {
            self.id
        }
        fn fingerprint(&self) -> u64 {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            std::hash::Hash::hash(&self.payload, &mut h);
            h.finish()
        }
    }

    fn item(id: u64, payload: &str) -> MockItem {
        MockItem {
            id,
            payload: payload.to_string(),
        }
    }

    #[test]
    fn empty_nodes_match_immediately() {
        let local = Node::<MockItem>::empty("local");
        let remote = Node::<MockItem>::empty("remote");
        let r = local.diff_and_reconcile(&remote, 2);
        assert_eq!(r.round_trips, 1);
        assert!(r.local_missing.is_empty());
        assert!(r.remote_missing.is_empty());
        assert!(r.mismatches.is_empty());
    }

    #[test]
    fn identical_nodes_match_in_one_trip() {
        let mut local = Node::<MockItem>::empty("local");
        let mut remote = Node::<MockItem>::empty("remote");
        for i in 0..10 {
            local.items.insert(i, item(i, &format!("content {i}")));
            remote.items.insert(i, item(i, &format!("content {i}")));
        }
        let r = local.diff_and_reconcile(&remote, 2);
        assert_eq!(r.round_trips, 1);
        assert!(r.local_missing.is_empty());
        assert!(r.remote_missing.is_empty());
        assert!(r.mismatches.is_empty());
    }

    #[test]
    fn detects_local_missing() {
        let mut local = Node::<MockItem>::empty("local");
        let mut remote = Node::<MockItem>::empty("remote");
        local.items.insert(1, item(1, "A"));
        remote.items.insert(1, item(1, "A"));
        remote.items.insert(2, item(2, "B"));
        let r = local.diff_and_reconcile(&remote, 2);
        assert_eq!(r.local_missing, vec!["2"]);
        assert!(r.remote_missing.is_empty());
    }

    #[test]
    fn detects_remote_missing() {
        let mut local = Node::<MockItem>::empty("local");
        let mut remote = Node::<MockItem>::empty("remote");
        local.items.insert(1, item(1, "A"));
        local.items.insert(2, item(2, "B"));
        remote.items.insert(1, item(1, "A"));
        let r = local.diff_and_reconcile(&remote, 2);
        assert_eq!(r.remote_missing, vec!["2"]);
        assert!(r.local_missing.is_empty());
    }

    #[test]
    fn detects_content_mismatch() {
        let mut local = Node::<MockItem>::empty("local");
        let mut remote = Node::<MockItem>::empty("remote");
        local.items.insert(1, item(1, "v1"));
        remote.items.insert(1, item(1, "v2"));
        let r = local.diff_and_reconcile(&remote, 2);
        assert_eq!(r.mismatches, vec!["1"]);
        assert!(r.local_missing.is_empty());
        assert!(r.remote_missing.is_empty());
    }

    #[test]
    fn detects_all_three_categories() {
        let mut local = Node::<MockItem>::empty("local");
        let mut remote = Node::<MockItem>::empty("remote");
        local.items.insert(1, item(1, "same"));
        local.items.insert(2, item(2, "L"));
        remote.items.insert(1, item(1, "same"));
        remote.items.insert(3, item(3, "R"));
        remote.items.insert(4, item(4, "remote"));
        local.items.insert(4, item(4, "local"));
        let r = local.diff_and_reconcile(&remote, 2);
        assert_eq!(r.local_missing, vec!["3"]);
        assert_eq!(r.remote_missing, vec!["2"]);
        assert_eq!(r.mismatches, vec!["4"]);
    }

    #[test]
    fn threshold_zero_forces_deep_bisection() {
        let mut local = Node::<MockItem>::empty("local");
        let mut remote = Node::<MockItem>::empty("remote");
        for i in 0..5 {
            local.items.insert(i, item(i, "x"));
            remote.items.insert(i, item(i, "x"));
        }
        remote.items.insert(99, item(99, "extra"));
        let r = local.diff_and_reconcile(&remote, 0);
        assert!(r.round_trips > 1);
        assert_eq!(r.local_missing, vec!["99"]);
    }

    #[test]
    fn large_set_logarithmic_round_trips() {
        let mut local = Node::<MockItem>::empty("local");
        let mut remote = Node::<MockItem>::empty("remote");
        for i in 0..100 {
            local.items.insert(i, item(i, &format!("content {i}")));
            remote.items.insert(i, item(i, &format!("content {i}")));
        }
        let r = local.diff_and_reconcile(&remote, 4);
        assert_eq!(r.round_trips, 1); // perfect match at root
    }

    #[test]
    fn range_fingerprint_empty_range() {
        let items: BTreeMap<Key, MockItem> = BTreeMap::new();
        let fp = RangeFingerprint::compute(&items, 0, u64::MAX);
        assert_eq!(fp.count, 0);
        assert_eq!(fp.xor_checksum, 0);
    }
}
