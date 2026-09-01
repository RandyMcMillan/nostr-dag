// p2p/src/time_sync.rs
// A verbose example of BFT-influenced time synchronization 
// conceptually bridging Gnostr gossip and Bitcoin recalibration logic.

use std::time::{SystemTime, UNIX_EPOCH};
use std::collections::VecDeque;

#[derive(Debug)]
pub struct BFTClock {
    local_offset: i64,      // Offset in milliseconds from system clock
    peer_samples: VecDeque<i64>, 
    sample_window: usize,
    difficulty_recalibration_threshold: f64,
}

impl BFTClock {
    pub fn new(window: usize) -> Self {
        Self {
            local_offset: 0,
            peer_samples: VecDeque::with_capacity(window),
            sample_window: window,
            difficulty_recalibration_threshold: 0.05, // 5% drift triggers "recalibration"
        }
    }

    /// Returns the current BFT Network Time
    pub fn network_now(&self) -> u64 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        (now + self.local_offset) as u64
    }

    /// Process time data received from libp2p gossip/request-response
    /// This is where the BFT "Ebb and Flow" is managed.
    pub fn update_with_peer_sample(&mut self, peer_time: u64) {
        let current_local = self.network_now() as i64;
        let delta = peer_time as i64 - current_local;

        // Add to peer sample history
        if self.peer_samples.len() >= self.sample_window {
            self.peer_samples.pop_front();
        }
        self.peer_samples.push_back(delta);

        self.recalibrate();
    }

    /// Conceptual Recalibration (Mirroring Bitcoin's Difficulty Adjustment logic)
    /// Instead of adjusting hashrate, we adjust our local perception of 'now'
    /// based on the collective median of the swarm.
    fn recalibrate(&mut self) {
        if self.peer_samples.len() < 3 { return; }

        let mut sorted_deltas: Vec<i64> = self.peer_samples.iter().cloned().collect();
        sorted_deltas.sort();

        // Use the Median to resist Byzantine (outlier) nodes
        let median_delta = sorted_deltas[sorted_deltas.len() / 2];

        // Apply a damping factor similar to Bitcoin's MAX_ADJUSTMENT
        // We don't jump to the peer time instantly; we correct the drift.
        self.local_offset += (median_delta as f64 * 0.1) as i64;

        println!("[BFT-CLOCK] Recalibrated. New Offset: {}ms | Median Delta: {}ms", 
                 self.local_offset, median_delta);
    }
}

fn main() {
    let mut gnostr_clock = BFTClock::new(10);

    println!("Initial Network Time: {}", gnostr_clock.network_now());

    // Simulate receiving gossip from peers with slightly different clocks
    let peer_clocks = vec![
        gnostr_clock.network_now() + 500,  // Peer A is fast
        gnostr_clock.network_now() + 1200, // Peer B is very fast (Byzantine?)
        gnostr_clock.network_now() - 300,  // Peer C is slow
    ];

    for (i, p_time) in peer_clocks.iter().enumerate() {
        println!("Receiving Sample from Peer {}...", i);
        gnostr_clock.update_with_peer_sample(*p_time);
    }

    println!("Final Synced Network Time: {}", gnostr_clock.network_now());
}
