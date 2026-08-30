//! Print demo federation keys for local development.
//!
//! Thin wrapper around `nostr_dag::native_cli::run_keygen`.

fn main() {
    nostr_dag::run_keygen();
}
