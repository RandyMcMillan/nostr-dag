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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bft_time_converges_with_damped_median() {
        let mut clock = BFTClock::new(10);
        let base = clock.network_now();

        // Feed 2 samples — window has < 3 items, no recalibration yet.
        clock.update_with_peer_sample(base + 500);
        clock.update_with_peer_sample(base + 1200);
        assert_eq!(clock.local_offset, 0, "no recalibration until 3 samples");

        // Third sample triggers the first recalibration.
        // Median of [500, 1200, -300] sorted = [-300, 500, 1200] → 500.
        // Damping: offset = 0 + 500*0.1 = 50.
        clock.update_with_peer_sample(base - 300);
        assert_eq!(clock.local_offset, 50, "first recalibration applies 10% of median");

        // After the window is warm, every new sample triggers recalibration.
        // Feed the same set again; median stays 500, so each sample adds 50.
        clock.update_with_peer_sample(base + 500);  // +50 → 100
        clock.update_with_peer_sample(base + 1200); // +50 → 150
        clock.update_with_peer_sample(base - 300);  // +50 → 200
        assert_eq!(clock.local_offset, 200, "three more damped steps add 150ms");

        // network_now should reflect the accumulated offset
        assert!(clock.network_now() >= base + 200, "network time should be ahead of base by offset");
    }
}
