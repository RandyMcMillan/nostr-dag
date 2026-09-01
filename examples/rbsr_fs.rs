//! Complete, copy-and-pasteable implementation of Range-Based Set Reconciliation (RBSR),
//! a Decentralized Mining Pool Partitioning State Machine, and low-level Cryptographic Primitives.
//!
//! # Included Subsystems:
//! - **Range-Based Set Reconciliation (RBSR)**: Efficiently computes missing or mutated file 
//!   entries between distributed nodes using binary bisection of range fingerprints.
//! - **Decentralized Pool Node**: Validates incoming double-SHA256 proof-of-work share submissions.
//! - **Time Network State Machine**: Manages dynamic multi-stage time consensus convergence 
//!   and nonce range partitioning.
//! - **Zero-Dependency Cryptography**: Pure Rust implementations of Git SHA-1 and standard SHA-256.

use std::collections::hash_map::DefaultHasher;
use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
use std::time::{Duration as StdDuration, Instant};

use chrono::{DateTime, Duration, Timelike, Utc};

// =========================================================================
// SECTION 1: RANGE-BASED SET RECONCILIATION (RBSR)
// =========================================================================

/// Primary numerical key type used to map sorted entry ranges within `BTreeMap` structures.
type Key = u64;

/// Represents a discrete file entry within a local or remote file system snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    /// Relative path of the file on disk or virtual storage.
    pub path: String,
    /// 64-bit hash representation of the file's binary/string payload.
    pub content_hash: u64,
}

impl FileEntry {
    /// Computes a deterministically hashed 64-bit key from the file path.
    ///
    /// This key determines the file's position within ordered range queries.
    pub fn path_key(&self) -> Key {
        let mut hasher = DefaultHasher::new();
        self.path.hash(&mut hasher);
        hasher.finish()
    }

    /// Computes a composite 64-bit fingerprint combining both the path and content hash.
    ///
    /// Any structural modification (renaming or altering bytes) changes this hash.
    pub fn entry_hash(&self) -> u64 {
        let mut hasher = DefaultHasher::new();
        self.path.hash(&mut hasher);
        self.content_hash.hash(&mut hasher);
        hasher.finish()
    }
}

/// A succinct checksum representation across an inclusive interval `[min_key, max_key]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeFingerprint {
    /// Lower boundary of the evaluated range (inclusive).
    pub min_key: Key,
    /// Upper boundary of the evaluated range (inclusive).
    pub max_key: Key,
    /// Total count of elements residing within the key boundary.
    pub count: usize,
    /// Cumulative bitwise XOR sum of all entry hashes in the range.
    pub xor_checksum: u64,
}

impl RangeFingerprint {
    /// Constructs a [`RangeFingerprint`] by iterating over entries within the range `[min_key, max_key]`.
    ///
    /// # Arguments
    /// * `entries` - Reference to the map containing all node entries sorted by `Key`.
    /// * `min_key` - Inclusive lower key boundary.
    /// * `max_key` - Inclusive upper key boundary.
    pub fn compute(entries: &BTreeMap<Key, FileEntry>, min_key: Key, max_key: Key) -> Self {
        let mut count = 0;
        let mut xor_checksum = 0u64;

        for (&_key, entry) in entries.range(min_key..=max_key) {
            count += 1;
            xor_checksum ^= entry.entry_hash();
        }

        Self {
            min_key,
            max_key,
            count,
            xor_checksum,
        }
    }
}

/// A named node entity containing a set of files mapped by path keys.
pub struct FileSystemNode {
    /// Identifier for the network/filesystem node.
    pub name: String,
    /// Primary key-value storage mapping path keys to [`FileEntry`] values.
    pub files: BTreeMap<Key, FileEntry>,
}

impl FileSystemNode {
    /// Instantiates an empty [`FileSystemNode`].
    pub fn empty(name: &str) -> Self {
        Self {
            name: name.to_string(),
            files: BTreeMap::new(),
        }
    }

    /// Inserts a new file path and text content into the node's local dataset.
    pub fn insert(&mut self, path: &str, content: &str) {
        let mut hasher = DefaultHasher::new();
        content.hash(&mut hasher);
        let content_hash = hasher.finish();

        let entry = FileEntry {
            path: path.to_string(),
            content_hash,
        };
        self.files.insert(entry.path_key(), entry);
    }

    /// Recursively bisects and reconciles a target remote fingerprint against the local file mapping.
    ///
    /// # Returns
    /// A tuple containing:
    /// 1. `Vec<FileEntry>`: All entries identified in the target range when the entry count is below `threshold`.
    /// 2. `usize`: Total range-query steps (round trips) performed during bisection.
    pub fn reconcile_range(
        &self,
        remote_fp: &RangeFingerprint,
        threshold: usize,
    ) -> (Vec<FileEntry>, usize) {
        let local_fp = RangeFingerprint::compute(&self.files, remote_fp.min_key, remote_fp.max_key);

        // Subtree matches completely; zero differences in this range segment.
        if local_fp == *remote_fp {
            return (vec![], 1);
        }

        // Base case: Range contains few enough items to resolve directly without further bisection.
        if local_fp.count <= threshold && remote_fp.count <= threshold {
            let local_entries: Vec<FileEntry> = self
                .files
                .range(remote_fp.min_key..=remote_fp.max_key)
                .map(|(_, entry)| entry.clone())
                .collect();
            return (local_entries, 1);
        }

        // Divide step: Split key space evenly across the midpoint.
        let mid = remote_fp.min_key + (remote_fp.max_key - remote_fp.min_key) / 2;

        let left_remote_fp = RangeFingerprint::compute(&self.files, remote_fp.min_key, mid);
        let right_remote_fp = RangeFingerprint::compute(&self.files, mid + 1, remote_fp.max_key);

        let (mut left_entries, left_steps) = self.reconcile_range(&left_remote_fp, threshold);
        let (right_entries, right_steps) = self.reconcile_range(&right_remote_fp, threshold);

        left_entries.extend(right_entries);
        (left_entries, left_steps + right_steps + 1)
    }

    /// Conducts a full root reconciliation pass comparing the local node to a target remote node.
    pub fn diff_and_reconcile(&self, remote_node: &FileSystemNode, threshold: usize) -> SyncResult {
        let start = Instant::now();
        let local_root_fp = RangeFingerprint::compute(&self.files, u64::MIN, u64::MAX);

        let (discovered_local_entries, round_trips) =
            remote_node.reconcile_range(&local_root_fp, threshold);

        let mut remote_missing = Vec::new();
        let mut content_mismatches = Vec::new();

        for entry in discovered_local_entries {
            let key = entry.path_key();
            match self.files.get(&key) {
                Some(local_entry) => {
                    if local_entry.content_hash != entry.content_hash {
                        content_mismatches.push(entry.path);
                    }
                }
                None => {
                    remote_missing.push(entry.path);
                }
            }
        }

        let mut local_missing = Vec::new();
        for (key, local_entry) in &self.files {
            if !remote_node.files.contains_key(key) {
                local_missing.push(local_entry.path.clone());
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

/// Diagnostics outcome generated by a set reconciliation procedure.
pub struct SyncResult {
    /// Total recursive bisection passes executed.
    pub round_trips: usize,
    /// List of file paths absent on the local node.
    pub local_missing: Vec<String>,
    /// List of file paths absent on the remote node.
    pub remote_missing: Vec<String>,
    /// List of file paths present on both nodes but possessing unequal hashes.
    pub content_mismatches: Vec<String>,
    /// Total execution duration in microseconds.
    pub elapsed_micros: u128,
}

// =========================================================================
// SECTION 2: DECENTRALIZED POOL & TIME NETWORK STATE MACHINE
// =========================================================================

/// Constant SHA-256 round keys used during transformation loops.
const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// Computes a standard 160-bit SHA-1 digest formatted as a 40-character hexadecimal string.
fn git_sha1(data: &[u8]) -> String {
    let mut h0: u32 = 0x67452301;
    let mut h1: u32 = 0xEFCDAB89;
    let mut h2: u32 = 0x98BADCFE;
    let mut h3: u32 = 0x10325476;
    let mut h4: u32 = 0xC3D2E1F0;
    let mut padded = data.to_vec();
    let bit_len = (padded.len() as u64) * 8;
    padded.push(0x80);
    while (padded.len() * 8) % 512 != 448 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in padded.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h0, h1, h2, h3, h4);
        for i in 0..80 {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(w[i]);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }
    format!("{:08x}{:08x}{:08x}{:08x}{:08x}", h0, h1, h2, h3, h4)
}

/// Computes a standard 256-bit SHA-256 digest formatted as a 64-character hexadecimal string.
fn sha256(data: &[u8]) -> String {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    let mut padded = data.to_vec();
    let bit_len = (padded.len() as u64) * 8;
    padded.push(0x80);
    while (padded.len() * 8) % 512 != 448 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in padded.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h_val] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h_val
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            h_val = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        h = [
            h[0].wrapping_add(a),
            h[1].wrapping_add(b),
            h[2].wrapping_add(c),
            h[3].wrapping_add(d),
            h[4].wrapping_add(e),
            h[5].wrapping_add(f),
            h[6].wrapping_add(g),
            h[7].wrapping_add(h_val),
        ];
    }
    h.iter().map(|x| format!("{:08x}", x)).collect()
}

/// Metadata structure holding current block headers for decentralized mining tasks.
pub struct BlockTemplate {
    /// Consensus block version number.
    pub version: u32,
    /// Hex string of the previous block hash.
    pub prev_block: String,
    /// Hex string of the merkle tree root.
    pub merkle_root: String,
    /// Prefix string target required for valid proof-of-work share acceptance (e.g., "00").
    pub pool_target: String,
}

/// Mining pool partition node managing block template state and share verification.
pub struct DecentralizedPoolNode {
    /// Unique miner identifier.
    pub miner_id: String,
    /// Shared, thread-safe access to active block template metadata.
    pub current_template: Arc<Mutex<BlockTemplate>>,
    /// Counter tracking verified valid shares submitted to this pool node.
    pub shares_submitted: u64,
}

impl DecentralizedPoolNode {
    /// Instantiates a new [`DecentralizedPoolNode`].
    pub fn new(miner_id: &str, initial_template: BlockTemplate) -> Self {
        Self {
            miner_id: miner_id.to_string(),
            current_template: Arc::new(Mutex::new(initial_template)),
            shares_submitted: 0,
        }
    }

    /// Validates an incoming nonce by executing double-SHA256 (`SHA256(SHA256(header))`).
    ///
    /// Increments `shares_submitted` if the result matches `pool_target`.
    pub fn verify_incoming_share(&mut self, nonce: u64) -> bool {
        let template = self.current_template.lock().unwrap();
        let payload = format!(
            "{}{}{}{}",
            template.version, template.prev_block, template.merkle_root, nonce
        );

        let intermediate_hash = sha256(payload.as_bytes());
        let final_hash = sha256(intermediate_hash.as_bytes());

        if final_hash.starts_with(&template.pool_target) {
            self.shares_submitted += 1;
            true
        } else {
            false
        }
    }
}

/// Cascading convergence phases for clock synchronization and proof-of-work state machines.
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
pub enum SyncStage {
    /// Coarse hour-level synchronization pass.
    Hour,
    /// Minute-level synchronization pass.
    Minute,
    /// Exact second-level synchronization pass.
    Second,
    /// Initial proof-of-work stage requiring a 1-bit zero prefix match ("0").
    NonceGrind1Bit,
    /// Final consensus proof-of-work stage requiring a 2-bit zero prefix match ("00").
    NonceGrind2Bit,
}

/// Individual participant node inside the distributed time consensus network.
pub struct SyncNode {
    /// Zero-based node identifier.
    pub id: usize,
    /// Clock skew adjustment applied to system time.
    pub adjustment: Duration,
    /// Current synchronization state machine stage.
    pub stage: SyncStage,
    /// Initial base nonce assigned based on total node partitioning.
    pub start_nonce: u64,
    /// Current nonce being incremented during proof-of-work mining passes.
    pub nonce: u64,
    /// Flag indicating if the node met the current stage's hashing target.
    pub success: bool,
    /// Last generated hash string produced by this node.
    pub last_hash: String,
}

impl SyncNode {
    /// Creates a new [`SyncNode`] with partitioned nonce search space.
    pub fn new(id: usize, offset_sec: i64, total_nodes: usize) -> Self {
        let stride = u64::MAX / (total_nodes as u64);
        let start_nonce = (id as u64) * stride;

        Self {
            id,
            adjustment: Duration::seconds(offset_sec),
            stage: SyncStage::Hour,
            start_nonce,
            nonce: start_nonce,
            success: false,
            last_hash: String::from("0000000000000000000000000000000000000000"),
        }
    }

    /// Evaluates current UTC time modified by node-specific clock adjustment.
    pub fn get_logical_utc(&self) -> DateTime<Utc> {
        Utc::now() + self.adjustment
    }

    /// Transitions the state machine based on network timing spread and consensus signals.
    pub fn update_stage(&mut self, spread: i64, all_same_minute: bool, global_1bit_reached: bool) {
        match self.stage {
            SyncStage::Hour => {
                if spread < 3600 {
                    self.stage = SyncStage::Minute;
                }
            }
            SyncStage::Minute => {
                if spread < 60 {
                    self.stage = SyncStage::Second;
                }
            }
            SyncStage::Second => {
                if spread == 0 && all_same_minute {
                    self.stage = SyncStage::NonceGrind1Bit;
                }
            }
            SyncStage::NonceGrind1Bit => {
                if spread > 0 || !all_same_minute {
                    self.stage = SyncStage::Second;
                    self.success = false;
                    self.nonce = self.start_nonce;
                } else if global_1bit_reached {
                    self.stage = SyncStage::NonceGrind2Bit;
                    self.success = false;
                }
            }
            SyncStage::NonceGrind2Bit => {
                if spread > 0 || !all_same_minute {
                    self.stage = SyncStage::Second;
                    self.success = false;
                    self.nonce = self.start_nonce;
                }
            }
        }
    }

    /// Performs proof-of-work iterations searching for hash signatures meeting target prefix conditions.
    pub fn grind_nonce(&mut self, target: &str, template: &BlockTemplate) {
        let time = self.get_logical_utc();
        let minute = time.minute();
        loop {
            let input = format!(
                "BLOCK-{}-{}-{}-{}",
                template.prev_block, template.merkle_root, minute, self.nonce
            );

            let hash = if target == "00" {
                let round1 = sha256(input.as_bytes());
                sha256(round1.as_bytes())
            } else {
                git_sha1(input.as_bytes())
            };

            if target == "00" {
                if hash.starts_with("00") {
                    self.last_hash = hash;
                    self.success = true;
                    break;
                } else if hash.starts_with("0") {
                    self.last_hash = hash;
                    self.nonce += 1;
                    break;
                }
            } else {
                self.last_hash = hash;
                if self.last_hash.starts_with(target) {
                    self.success = true;
                } else {
                    self.nonce += 1;
                }
                break;
            }
            self.nonce += 1;
        }
    }
}

/// Calculates the median offset diff from a collection of peer node timestamps.
fn get_median_diff(timestamps: &[i64], current: i64) -> i64 {
    let mut diffs: Vec<i64> = timestamps.iter().map(|t| t - current).collect();
    diffs.sort();
    diffs[diffs.len() / 2]
}

// =========================================================================
// SECTION 3: ENTRYPOINT & EXECUTIONS
// =========================================================================

fn main() {
    println!("========== RBSR ADVANCED STRESS SIMULATION ==========\n");

    // SCENARIO 1: Large Scale (10,000 files, 5 sparse differences)
    run_large_scale_simulation();

    // SCENARIO 2: Dense Burst Mutations (Git Checkout / Branch Switch Simulation)
    run_git_checkout_burst_simulation();

    // SCENARIO 3: Hash Clustering & Collisions
    run_key_clustering_simulation();

    println!("\n========== TIME CONSENSUS & DISTRIBUTED MINING SIMULATION ==========\n");
    run_time_network_simulation();
}

/// Executes large scale set reconciliation stress test over 10,000 entries.
fn run_large_scale_simulation() {
    println!("--- Scenario 1: Large Scale (10,000 Files, 5 Sparse Diff) ---");

    let mut node_a = FileSystemNode::empty("NodeA");
    let mut node_b = FileSystemNode::empty("NodeB");

    for i in 0..10_000 {
        let path = format!("src/module_{}/file_{}.rs", i / 100, i);
        let content = format!("// Content version 1.0 for file {}", i);
        node_a.insert(&path, &content);
        node_b.insert(&path, &content);
    }

    // Inject 5 sparse differences
    node_a.insert("src/module_0/file_42.rs", "// MODIFIED content in A");
    node_a.insert("src/unique_a_1.rs", "// File only on A");
    node_a.insert("src/unique_a_2.rs", "// File only on A");

    node_b.insert("src/module_99/file_9999.rs", "// MODIFIED content in B");
    node_b.insert("src/unique_b_1.rs", "// File only on B");

    let result = node_a.diff_and_reconcile(&node_b, 4);

    println!("Total Files NodeA: {}", node_a.files.len());
    println!("Total Files NodeB: {}", node_b.files.len());
    println!("Range Fingerprint Round-trips: {}", result.round_trips);
    println!("Discovered Content Mismatches: {}", result.content_mismatches.len());
    println!("Discovered Missing on NodeA:   {}", result.remote_missing.len());
    println!("Discovered Missing on NodeB:   {}", result.local_missing.len());
    println!("Execution Time:                {} µs\n", result.elapsed_micros);
}

/// Simulates high-density modifications occurring across directory structures during VCS branch operations.
fn run_git_checkout_burst_simulation() {
    println!("--- Scenario 2: Git Branch Switch (500 File Burst Mutation) ---");

    let mut node_main = FileSystemNode::empty("MainBranch");
    let mut node_feature = FileSystemNode::empty("FeatureBranch");

    // Shared baseline repo (5,000 files)
    for i in 0..5_000 {
        let path = format!("core/component_{}.rs", i);
        let content = "pub fn execute() { println!(\"base\"); }";
        node_main.insert(&path, content);
        node_feature.insert(&path, content);
    }

    // Feature branch rewrites 500 files inside a single targeted directory
    for i in 0..500 {
        let path = format!("core/component_{}.rs", i);
        let feature_content = format!("pub fn execute() {{ println!(\"feature_v2_{}\"); }}", i);
        node_feature.insert(&path, &feature_content);
    }

    let result = node_main.diff_and_reconcile(&node_feature, 8);

    println!("Total Shared Files:            5000");
    println!("Burst Modified Files:          500");
    println!("Range Fingerprint Round-trips: {}", result.round_trips);
    println!("Discovered Content Mismatches: {}", result.content_mismatches.len());
    println!("Execution Time:                {} µs\n", result.elapsed_micros);
}

/// Evaluates set reconciliation behavior when entries cluster densely within narrow key spaces.
fn run_key_clustering_simulation() {
    println!("--- Scenario 3: Key Clustered Bisection Stress Test ---");

    let mut node_a = FileSystemNode::empty("ClusterA");
    let mut node_b = FileSystemNode::empty("ClusterB");

    // Synthesize paths whose u64 path keys land in narrow ranges
    for i in 0..2_000 {
        let path = format!("assets/vendor_libs/vendor_{}.bin", i);
        let content = "data payload";
        node_a.insert(&path, content);
        node_b.insert(&path, content);
    }

    // Add entries that fall very close to each other in key space
    node_a.insert("assets/vendor_libs/vendor_diff_1.bin", "diff_a1");
    node_a.insert("assets/vendor_libs/vendor_diff_2.bin", "diff_a2");
    node_b.insert("assets/vendor_libs/vendor_diff_3.bin", "diff_b1");

    let result = node_a.diff_and_reconcile(&node_b, 2);

    println!("Total Clustered Keys:          {}", node_a.files.len());
    println!("Range Fingerprint Round-trips: {}", result.round_trips);
    println!("Missing on NodeA:              {:?}", result.remote_missing);
    println!("Missing on NodeB:              {:?}", result.local_missing);
    println!("Execution Time:                {} µs\n", result.elapsed_micros);
}

/// Runs consensus simulation for time synchronization and multi-node proof-of-work share grinding.
fn run_time_network_simulation() {
    let total_nodes = 10;

    let initial_job = BlockTemplate {
        version: 4,
        prev_block: "000000000000000000021c33f24bf7aef12d".to_string(),
        merkle_root: "94b8e19c20cb3ffbb123a".to_string(),
        pool_target: "00".to_string(),
    };

    let mut pool_node = DecentralizedPoolNode::new("pleb_pool_partitioner", initial_job);
    println!("Decentralized Sharded Pool Node Active. ID: {}", pool_node.miner_id);

    let mut nodes: Vec<SyncNode> = (0..total_nodes)
        .map(|i| {
            let offset = match i {
                0..=2 => 10,
                3..=5 => 5,
                _ => 2,
            };
            SyncNode::new(i, offset, total_nodes)
        })
        .collect();

    let mut round = 1;
    loop {
        let current_times: Vec<DateTime<Utc>> = nodes.iter().map(|n| n.get_logical_utc()).collect();
        let timestamps: Vec<i64> = current_times.iter().map(|t| t.timestamp()).collect();
        let spread = (timestamps.iter().max().unwrap() - timestamps.iter().min().unwrap()).abs();
        let all_same_minute = current_times.iter().all(|t| t.minute() == current_times[0].minute());
        let global_1bit_reached = nodes.iter().all(|n| n.stage == SyncStage::NonceGrind1Bit && n.success);

        let has_consensus = {
            let active_template = pool_node.current_template.lock().unwrap();

            println!(
                "\n--- [ROUND {:03}] Spread:{}s | MinSync:{} | Target Template: PrevBlock={}... ---",
                round, spread, all_same_minute, &active_template.prev_block[0..8]
            );

            for i in 0..total_nodes {
                nodes[i].update_stage(spread, all_same_minute, global_1bit_reached);
                match nodes[i].stage {
                    SyncStage::Hour | SyncStage::Minute | SyncStage::Second => {
                        let d = get_median_diff(&timestamps, timestamps[i]);
                        let step = if nodes[i].stage == SyncStage::Second {
                            d.signum()
                        } else {
                            d / 2
                        };
                        nodes[i].adjustment = nodes[i].adjustment + Duration::seconds(step);
                    }
                    SyncStage::NonceGrind1Bit => {
                        if !nodes[i].success {
                            nodes[i].grind_nonce("0", &active_template);
                        }
                    }
                    SyncStage::NonceGrind2Bit => {
                        if !nodes[i].success {
                            nodes[i].grind_nonce("00", &active_template);
                        }
                    }
                };

                let mark = if nodes[i].success { "SOLVED " } else { "MINING" };
                println!(
                    "N{:02} | Stage:{} | ConsensusTime: {} | Nonce Range Base: {:x} -> Curr Nonce: {:x} | {} | HASH: {}",
                    i,
                    nodes[i].stage as u8,
                    current_times[i].format("%H:%M:%S"),
                    nodes[i].start_nonce,
                    nodes[i].nonce,
                    mark,
                    nodes[i].last_hash
                );
            }

            nodes.iter().all(|n| n.stage == SyncStage::NonceGrind2Bit && n.success)
        };

        if has_consensus {
            for i in 0..total_nodes {
                pool_node.verify_incoming_share(nodes[i].nonce);
            }
            println!("\n>>> SUCCESS: ALL ACTIVE INDEPENDENT RANGES ATTAINED CASCADING CONSENSUS <<<");
            println!("Total Distinct Distributed Shares Logged: {}", pool_node.shares_submitted);
            break;
        }

        round += 1;
        std::thread::sleep(StdDuration::from_millis(15));
        if round > 5000 {
            break;
        }
    }
}

// =========================================================================
// SECTION 4: UNIT TESTS
// =========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sha1_golden_vector() {
        assert_eq!(git_sha1(b"hello world"), "2aae6c35c94fcfb415dbe95f408b9ce91ee846ed");
    }

    #[test]
    fn test_sha256_golden_vector() {
        assert_eq!(
            sha256(b"hello world"),
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }
}
