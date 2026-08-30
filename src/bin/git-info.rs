//! CLI helper for git log and blame using the native `git2` wrapper.
//!
//! Thin wrapper around `nostr_dag::native_cli::run_git_info`.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    nostr_dag::run_git_info(args)
}
