//! CLI helper for git log and blame using the native `git2` wrapper.
//!
//! Usage:
//!   git-info log  <repo-path> [limit]
//!   git-info blame <repo-path> <file-path> [commit-ish]

use nostr_dag::git::native::{blame, log, open_repo};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage:");
        eprintln!("  git-info log   <repo-path> [limit]");
        eprintln!("  git-info blame <repo-path> <file-path> [commit-ish]");
        std::process::exit(1);
    }

    let subcommand = args[1].as_str();
    let repo_path = &args[2];

    let repo = open_repo(repo_path)?;

    match subcommand {
        "log" => {
            let limit: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(20);
            let commits = log(&repo, limit)?;
            println!("{}", serde_json::to_string_pretty(&commits)?);
        }
        "blame" => {
            let file_path = args.get(3).ok_or("blame requires a file-path argument")?;
            let commit_ish = args.get(4).map(String::as_str).unwrap_or("HEAD");
            let hunks = blame(&repo, file_path, commit_ish)?;
            println!("{}", serde_json::to_string_pretty(&hunks)?);
        }
        other => {
            eprintln!("Unknown subcommand: {other}");
            std::process::exit(1);
        }
    }

    Ok(())
}
