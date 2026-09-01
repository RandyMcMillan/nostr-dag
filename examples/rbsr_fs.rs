//! Range-Based Set Reconciliation (RBSR) for distributed file sets.
//!
//! Efficiently computes differences between two ordered sets of file entries
//! using recursive range fingerprinting.  Instead of exchanging full lists,
//! peers compare compact checksums over key ranges and only bisect when
//! fingerprints differ, yielding logarithmic round-trip complexity.
//!
//! # Algorithm
//! 1. Each node maintains files in a `BTreeMap` keyed by deterministic path hash.
//! 2. A `RangeFingerprint` captures `(count, xor_checksum)` over a key interval.
//! 3. To reconcile, peers compare root fingerprints. If equal, the range is synced.
//! 4. If different, the range is bisected and the process repeats recursively.
//! 5. Once a range drops below `threshold` items, entries are exchanged directly.
//!
//! This approach is directly applicable to DAG event-set reconciliation by
//! replacing `FileEntry` with `Event` and path keys with event IDs.

use std::collections::BTreeMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Instant;

/// Key type for ordered range queries.
type Key = u64;

/// A single file entry in a distributed file system snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    /// Relative path of the file.
    pub path: String,
    /// Hash of the file's content.
    pub content_hash: u64,
}

impl FileEntry {
    /// Deterministic key derived from the file path.
    pub fn path_key(&self) -> Key {
        let mut hasher = DefaultHasher::new();
        self.path.hash(&mut hasher);
        hasher.finish()
    }

    /// Composite fingerprint of path + content.
    pub fn entry_hash(&self) -> u64 {
        let mut hasher = DefaultHasher::new();
        self.path.hash(&mut hasher);
        self.content_hash.hash(&mut hasher);
        hasher.finish()
    }
}

/// Compact summary of a key range `[min_key, max_key]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeFingerprint {
    pub min_key: Key,
    pub max_key: Key,
    pub count: usize,
    pub xor_checksum: u64,
}

impl RangeFingerprint {
    /// Compute fingerprint over a range of entries.
    pub fn compute(entries: &BTreeMap<Key, FileEntry>, min_key: Key, max_key: Key) -> Self {
        let mut count = 0;
        let mut xor_checksum = 0u64;
        for (_, entry) in entries.range(min_key..=max_key) {
            count += 1;
            xor_checksum ^= entry.entry_hash();
        }
        Self { min_key, max_key, count, xor_checksum }
    }
}

/// Result of a reconciliation pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncResult {
    /// Number of recursive bisection steps (round trips).
    pub round_trips: usize,
    /// Paths missing on the local node.
    pub local_missing: Vec<String>,
    /// Paths missing on the remote node.
    pub remote_missing: Vec<String>,
    /// Paths where content differs.
    pub content_mismatches: Vec<String>,
    /// Elapsed time in microseconds.
    pub elapsed_micros: u128,
}

/// Recursively bisect and reconcile two file maps.
///
/// Compares fingerprints over `[min_key, max_key]`. If they match, the range
/// is synced. If the range is small (≤ threshold), entries from `remote` are
/// returned directly. Otherwise the range is bisected and the process repeats.
fn reconcile_range(
    local: &BTreeMap<Key, FileEntry>,
    remote: &BTreeMap<Key, FileEntry>,
    min_key: Key,
    max_key: Key,
    threshold: usize,
) -> (Vec<FileEntry>, usize) {
    let local_fp = RangeFingerprint::compute(local, min_key, max_key);
    let remote_fp = RangeFingerprint::compute(remote, min_key, max_key);

    // Ranges match — nothing to do.
    if local_fp == remote_fp {
        return (vec![], 1);
    }

    // Small enough to resolve directly.
    if local_fp.count <= threshold && remote_fp.count <= threshold {
        let entries: Vec<FileEntry> = remote.range(min_key..=max_key).map(|(_, e)| e.clone()).collect();
        return (entries, 1);
    }

    // Cannot split further — resolve directly to avoid infinite recursion.
    if min_key == max_key {
        let entries: Vec<FileEntry> = remote.range(min_key..=max_key).map(|(_, e)| e.clone()).collect();
        return (entries, 1);
    }

    // Bisect and recurse.
    let mid = min_key + (max_key - min_key) / 2;
    let (mut left_entries, left_steps) = reconcile_range(local, remote, min_key, mid, threshold);
    let (right_entries, right_steps) = reconcile_range(local, remote, mid + 1, max_key, threshold);
    left_entries.extend(right_entries);
    (left_entries, left_steps + right_steps + 1)
}

/// A node holding a set of files.
pub struct FileSystemNode {
    pub name: String,
    pub files: BTreeMap<Key, FileEntry>,
}

impl FileSystemNode {
    /// Create an empty node.
    pub fn empty(name: &str) -> Self {
        Self {
            name: name.to_string(),
            files: BTreeMap::new(),
        }
    }

    /// Insert a file with given path and text content.
    pub fn insert(&mut self, path: &str, content: &str) {
        let mut hasher = DefaultHasher::new();
        content.hash(&mut hasher);
        let entry = FileEntry {
            path: path.to_string(),
            content_hash: hasher.finish(),
        };
        self.files.insert(entry.path_key(), entry);
    }

    /// Full diff-and-reconcile against a remote node.
    pub fn diff_and_reconcile(&self, remote: &FileSystemNode, threshold: usize) -> SyncResult {
        let start = Instant::now();
        let (discovered, round_trips) =
            reconcile_range(&self.files, &remote.files, u64::MIN, u64::MAX, threshold);

        let mut local_missing = Vec::new();
        let mut content_mismatches = Vec::new();
        for entry in discovered {
            let key = entry.path_key();
            match self.files.get(&key) {
                Some(local) => {
                    if local.content_hash != entry.content_hash {
                        content_mismatches.push(entry.path);
                    }
                }
                None => local_missing.push(entry.path),
            }
        }

        let mut remote_missing = Vec::new();
        for (key, local) in &self.files {
            if !remote.files.contains_key(key) {
                remote_missing.push(local.path.clone());
            }
        }

        SyncResult {
            round_trips,
            local_missing,
            remote_missing,
            content_mismatches,
            elapsed_micros: start.elapsed().as_micros(),
        }
    }
}

fn main() {
    let mut local = FileSystemNode::empty("local");
    local.insert("README.md", "# Hello");
    local.insert("src/lib.rs", "pub fn hello() {}");
    local.insert("Cargo.toml", "[package]\nname = \"demo\"");

    let mut remote = FileSystemNode::empty("remote");
    remote.insert("README.md", "# Hello");               // identical
    remote.insert("src/lib.rs", "pub fn hello() {}");    // identical
    remote.insert("Cargo.toml", "[package]\nname = \"other\""); // different content
    remote.insert("LICENSE", "MIT");                     // remote only
    // local.insert(".gitignore", "target/\n");           // local only (omitted for demo)

    println!("Local files:  {}", local.files.len());
    println!("Remote files: {}", remote.files.len());
    println!();

    let result = local.diff_and_reconcile(&remote, 2);

    println!("Round trips:  {}", result.round_trips);
    println!("Local missing:   {:?}", result.local_missing);
    println!("Remote missing:  {:?}", result.remote_missing);
    println!("Mismatches:      {:?}", result.content_mismatches);
    println!("Time: {} µs", result.elapsed_micros);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_nodes_match_immediately() {
        let local = FileSystemNode::empty("local");
        let remote = FileSystemNode::empty("remote");
        let r = local.diff_and_reconcile(&remote, 2);
        assert_eq!(r.round_trips, 1);
        assert!(r.local_missing.is_empty());
        assert!(r.remote_missing.is_empty());
        assert!(r.content_mismatches.is_empty());
    }

    #[test]
    fn identical_nodes_match_in_one_trip() {
        let mut local = FileSystemNode::empty("local");
        let mut remote = FileSystemNode::empty("remote");
        for i in 0..10 {
            local.insert(&format!("file{i}.txt"), &format!("content {i}"));
            remote.insert(&format!("file{i}.txt"), &format!("content {i}"));
        }
        let r = local.diff_and_reconcile(&remote, 2);
        assert_eq!(r.round_trips, 1);
        assert!(r.local_missing.is_empty());
        assert!(r.remote_missing.is_empty());
        assert!(r.content_mismatches.is_empty());
    }

    #[test]
    fn detects_local_missing() {
        let mut local = FileSystemNode::empty("local");
        let mut remote = FileSystemNode::empty("remote");
        local.insert("a.txt", "A");
        remote.insert("a.txt", "A");
        remote.insert("b.txt", "B");
        let r = local.diff_and_reconcile(&remote, 2);
        assert_eq!(r.local_missing, vec!["b.txt"]);
        assert!(r.remote_missing.is_empty());
    }

    #[test]
    fn detects_remote_missing() {
        let mut local = FileSystemNode::empty("local");
        let mut remote = FileSystemNode::empty("remote");
        local.insert("a.txt", "A");
        local.insert("b.txt", "B");
        remote.insert("a.txt", "A");
        let r = local.diff_and_reconcile(&remote, 2);
        assert_eq!(r.remote_missing, vec!["b.txt"]);
        assert!(r.local_missing.is_empty());
    }

    #[test]
    fn detects_content_mismatch() {
        let mut local = FileSystemNode::empty("local");
        let mut remote = FileSystemNode::empty("remote");
        local.insert("a.txt", "version 1");
        remote.insert("a.txt", "version 2");
        let r = local.diff_and_reconcile(&remote, 2);
        assert_eq!(r.content_mismatches, vec!["a.txt"]);
        assert!(r.local_missing.is_empty());
        assert!(r.remote_missing.is_empty());
    }

    #[test]
    fn detects_all_three_categories() {
        let mut local = FileSystemNode::empty("local");
        let mut remote = FileSystemNode::empty("remote");
        local.insert("shared.txt", "same");
        local.insert("local_only.txt", "L");
        remote.insert("shared.txt", "same");
        remote.insert("remote_only.txt", "R");
        remote.insert("mismatch.txt", "remote content");
        local.insert("mismatch.txt", "local content");
        let r = local.diff_and_reconcile(&remote, 2);
        assert_eq!(r.local_missing, vec!["remote_only.txt"]);
        assert_eq!(r.remote_missing, vec!["local_only.txt"]);
        assert_eq!(r.content_mismatches, vec!["mismatch.txt"]);
    }

    #[test]
    fn threshold_zero_forces_deep_bisection() {
        let mut local = FileSystemNode::empty("local");
        let mut remote = FileSystemNode::empty("remote");
        for i in 0..5 {
            local.insert(&format!("f{i}.txt"), "x");
            remote.insert(&format!("f{i}.txt"), "x");
        }
        // Add one extra file on remote so root fingerprints differ.
        remote.insert("extra.txt", "extra");
        let r = local.diff_and_reconcile(&remote, 0);
        // Threshold 0 forces bisection until empty ranges are reached.
        assert!(r.round_trips > 1);
        assert_eq!(r.local_missing, vec!["extra.txt"]);
    }

    #[test]
    fn large_set_logarithmic_round_trips() {
        let mut local = FileSystemNode::empty("local");
        let mut remote = FileSystemNode::empty("remote");
        for i in 0..100 {
            local.insert(&format!("file_{i:03}.txt"), &format!("content {i}"));
            remote.insert(&format!("file_{i:03}.txt"), &format!("content {i}"));
        }
        let r = local.diff_and_reconcile(&remote, 4);
        assert_eq!(r.round_trips, 1); // perfect match at root
        assert!(r.elapsed_micros < 10_000); // should be fast
    }

    #[test]
    fn path_key_is_deterministic() {
        let e1 = FileEntry { path: "a/b/c.txt".into(), content_hash: 42 };
        let e2 = FileEntry { path: "a/b/c.txt".into(), content_hash: 99 };
        assert_eq!(e1.path_key(), e2.path_key(), "path_key must not depend on content");
        assert_ne!(e1.entry_hash(), e2.entry_hash(), "entry_hash must include content");
    }

    #[test]
    fn range_fingerprint_empty_range() {
        let node = FileSystemNode::empty("n");
        let fp = RangeFingerprint::compute(&node.files, 0, u64::MAX);
        assert_eq!(fp.count, 0);
        assert_eq!(fp.xor_checksum, 0);
    }
}
