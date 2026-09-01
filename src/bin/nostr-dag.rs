//! Unified `nostr-dag` CLI with subcommands.
//!
//! Replaces the individual binaries with a single entry point that calls
//! library functions directly (no child-process spawning).
//!
//!   nostr-dag server          # Run the static-file server
//!   nostr-dag p2p             # Run the native libp2p peer
//!   nostr-dag federation      # Run a federation daemon
//!   nostr-dag relay           # Run the embedded Nostr relay
//!   nostr-dag keygen          # Generate deterministic keys
//!   nostr-dag git-info        # Git repository introspection
//!   nostr-dag db-viewer       # TUI database explorer

use clap::{Parser, Subcommand};

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
        /// Additional directory to serve static files from
        #[arg(long)]
        path: Option<String>,
        /// Allow serving subdirectories of --path
        #[arg(long)]
        recursive: bool,
        /// Maximum path depth for --path (default: 3)
        #[arg(long, default_value = "3")]
        depth: usize,
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
    Keygen,

    /// Git repository introspection helpers
    #[cfg(feature = "native")]
    GitInfo {
        /// Subcommand (log or blame)
        #[arg(required = true)]
        subcommand: String,
        /// Repository path
        #[arg(required = true)]
        repo_path: String,
        /// Optional limit (for log) or file path (for blame)
        arg3: Option<String>,
        /// Optional commit-ish (for blame)
        arg4: Option<String>,
    },

    /// TUI database explorer
    #[cfg(feature = "db-viewer")]
    DbViewer {
        /// SQLite database path
        #[arg(long, default_value = "nostr-dag.db", env = "DB_PATH")]
        db_path: String,
    },
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
            path,
            recursive,
            depth,
        } => {
            nostr_dag::server::run_server(&host, port, &site_dir, &db_path, p2p, path.as_deref(), recursive, depth).await
        }

        #[cfg(feature = "p2p")]
        Commands::P2p => nostr_dag::run_native_p2p_node().await.map_err(|e| e as Box<dyn std::error::Error>),

        #[cfg(feature = "native")]
        Commands::Federation => nostr_dag::run_federation().await,

        #[cfg(feature = "relay")]
        Commands::Relay { port } => {
            std::env::set_var("PORT", port.to_string());
            nostr_dag::run_local_relay().await
        }

        #[cfg(feature = "native")]
        Commands::Keygen => {
            nostr_dag::run_keygen();
            Ok(())
        }

        #[cfg(feature = "native")]
        Commands::GitInfo {
            subcommand,
            repo_path,
            arg3,
            arg4,
        } => {
            let mut args = vec!["git-info".to_string(), subcommand, repo_path];
            if let Some(a3) = arg3 {
                args.push(a3);
            }
            if let Some(a4) = arg4 {
                args.push(a4);
            }
            nostr_dag::run_git_info(args)
        }

        #[cfg(feature = "db-viewer")]
        Commands::DbViewer { db_path } => {
            nostr_dag::run_db_viewer(&db_path)
        }
    }
}
