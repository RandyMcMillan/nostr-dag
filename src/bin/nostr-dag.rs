//! Unified `nostr-dag` CLI with subcommands.
//!
//!   nostr-dag server          # Run the static-file server
//!   nostr-dag p2p             # Run the native libp2p peer
//!   nostr-dag federation      # Run a federation daemon
//!   nostr-dag relay           # Run the embedded Nostr relay
//!   nostr-dag keygen          # Generate deterministic keys
//!   nostr-dag git-info        # Git repository introspection
//!   nostr-dag db-viewer       # TUI database explorer

use clap::{Parser, Subcommand};
use std::process::{Command, Stdio};

#[derive(Parser)]
#[command(name = "nostr-dag")]
#[command(about = "DAG-based optimistic consensus for Nostr")]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Serve the built demo site locally
    #[cfg(feature = "native")]
    Server {
        /// Host to bind on
        #[arg(long, default_value = "127.0.0.1", env = "HOST")]
        host: String,
        /// Port to listen on (0 = system-assigned)
        #[arg(long, default_value = "3000", env = "PORT")]
        port: u16,
        /// Directory containing the built site
        #[arg(long, default_value = "site", env = "SITE_DIR")]
        site_dir: String,
        /// SQLite database path
        #[arg(long, default_value = "nostr-dag.db", env = "DB_PATH")]
        db_path: String,
        /// Also start the embedded libp2p peer
        #[arg(long, env = "P2P_ENABLE")]
        p2p: bool,
    },

    /// Run the native libp2p peer
    #[cfg(feature = "p2p")]
    P2p,

    /// Run a federation daemon
    #[cfg(feature = "native")]
    Federation,

    /// Run the embedded Nostr relay
    #[cfg(feature = "relay")]
    Relay {
        /// Port to listen on
        #[arg(long, default_value = "8080", env = "PORT")]
        port: u16,
    },

    /// Generate deterministic keys and config
    #[cfg(feature = "native")]
    Keygen {
        /// Output format
        #[arg(long, default_value = "toml")]
        format: String,
    },

    /// Git repository introspection helpers
    #[cfg(feature = "native")]
    GitInfo,

    /// TUI database explorer
    #[cfg(feature = "db-viewer")]
    DbViewer,
}

fn cargo_target_dir() -> String {
    std::env::var("CARGO_TARGET_DIR").unwrap_or_else(|_| "target".into())
}

fn find_binary(name: &str) -> Option<std::path::PathBuf> {
    let target_dir = cargo_target_dir();
    let candidates = [
        format!("{}/release/{}", target_dir, name),
        format!("{}/debug/{}", target_dir, name),
    ];
    for path in &candidates {
        let p = std::path::Path::new(path);
        if p.is_file() {
            return Some(p.to_path_buf());
        }
    }
    // Try PATH via `command -v`
    if let Ok(output) = Command::new("sh").arg("-c").arg(format!("command -v {}", name)).output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(std::path::PathBuf::from(path));
            }
        }
    }
    None
}

fn run_binary(name: &str, envs: Vec<(&str, String)>) -> Result<(), Box<dyn std::error::Error>> {
    let bin_path = find_binary(name)
        .ok_or_else(|| format!("binary '{}' not found. Build it first with: cargo build --bin {}", name, name))?;

    let mut cmd = Command::new(&bin_path);
    cmd.stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    for (key, value) in envs {
        cmd.env(key, value);
    }

    let status = cmd.status()?;
    if !status.success() {
        std::process::exit(status.code().unwrap_or(1));
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    match cli.command {
        #[cfg(feature = "native")]
        Commands::Server {
            host,
            port,
            site_dir,
            db_path,
            p2p,
        } => {
            let mut envs = vec![
                ("HOST", host),
                ("PORT", port.to_string()),
                ("SITE_DIR", site_dir),
                ("DB_PATH", db_path),
            ];
            if p2p {
                envs.push(("P2P_ENABLE", "1".into()));
            }
            run_binary("nostr-dag-server", envs)
        }

        #[cfg(feature = "p2p")]
        Commands::P2p => run_binary("p2p-node", vec![]),

        #[cfg(feature = "native")]
        Commands::Federation => run_binary("federation", vec![]),

        #[cfg(feature = "relay")]
        Commands::Relay { port } => {
            run_binary("relay", vec![("PORT", port.to_string())])
        }

        #[cfg(feature = "native")]
        Commands::Keygen { format } => {
            run_binary("keygen", vec![("FORMAT", format)])
        }

        #[cfg(feature = "native")]
        Commands::GitInfo => run_binary("git-info", vec![]),

        #[cfg(feature = "db-viewer")]
        Commands::DbViewer => run_binary("db-viewer", vec![]),
    }
}
