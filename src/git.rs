//! Native git2 wrapper — available only with the `native` feature.
//!
//! Provides lightweight access to a local Git repository for the log and blame
//! operations already surfaced by the demo Git viewer pages.

#[cfg(feature = "native")]
pub mod native {
    use git2::{BlameOptions, Repository};
    use serde::{Deserialize, Serialize};

    /// A single commit summary returned by [`log`].
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct CommitInfo {
        /// Full 40-hex object id.
        pub oid: String,
        /// Author name.
        pub author: String,
        /// Author e-mail.
        pub email: String,
        /// Commit message (first line only).
        pub message: String,
        /// Unix timestamp (seconds since epoch).
        pub timestamp: i64,
    }

    /// A single blame hunk returned by [`blame`].
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct BlameHunk {
        /// Full 40-hex object id of the originating commit.
        pub oid: String,
        /// Author name.
        pub author: String,
        /// Unix timestamp of the originating commit.
        pub timestamp: i64,
        /// 1-based starting line in the final file.
        pub start_line: usize,
        /// Number of lines covered by this hunk.
        pub lines: usize,
    }

    /// Open a [`Repository`] rooted at `path`.
    pub fn open_repo(path: &str) -> Result<Repository, git2::Error> {
        Repository::open(path)
    }

    /// Return up to `limit` commits reachable from HEAD, newest first.
    pub fn log(repo: &Repository, limit: usize) -> Result<Vec<CommitInfo>, git2::Error> {
        let mut revwalk = repo.revwalk()?;
        revwalk.push_head()?;
        revwalk.set_sorting(git2::Sort::TIME)?;

        let mut commits = Vec::new();
        for oid_result in revwalk.take(limit) {
            let oid = oid_result?;
            let commit = repo.find_commit(oid)?;
            let author = commit.author();
            commits.push(CommitInfo {
                oid: oid.to_string(),
                author: author.name().unwrap_or("").to_string(),
                email: author.email().unwrap_or("").to_string(),
                message: commit
                    .message()
                    .unwrap_or("")
                    .lines()
                    .next()
                    .unwrap_or("")
                    .to_string(),
                timestamp: author.when().seconds(),
            });
        }
        Ok(commits)
    }

    /// Return blame hunks for `file_path` at the commit identified by `commit_ish`
    /// (a branch name, tag, or full/abbreviated OID string).
    ///
    /// Pass `"HEAD"` to blame the working-tree tip.
    pub fn blame(
        repo: &Repository,
        file_path: &str,
        commit_ish: &str,
    ) -> Result<Vec<BlameHunk>, git2::Error> {
        let obj = repo.revparse_single(commit_ish)?;
        let spec_oid = obj.id();

        let mut opts = BlameOptions::new();
        opts.newest_commit(spec_oid);

        let blame = repo.blame_file(std::path::Path::new(file_path), Some(&mut opts))?;
        let mut hunks = Vec::new();
        for hunk in blame.iter() {
            let sig = hunk.orig_signature();
            hunks.push(BlameHunk {
                oid: hunk.orig_commit_id().to_string(),
                author: sig.name().unwrap_or("").to_string(),
                timestamp: sig.when().seconds(),
                start_line: hunk.final_start_line(),
                lines: hunk.lines_in_hunk(),
            });
        }
        Ok(hunks)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Opens the repository that contains this very source file and checks
        /// that `log` returns at least one commit with a non-empty OID.
        #[test]
        fn test_log_self_repo() {
            // The repo root is two levels above src/git.rs.
            let repo_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
            let repo = open_repo(repo_path.to_str().unwrap()).expect("open repo");
            let commits = log(&repo, 5).expect("log");
            assert!(!commits.is_empty(), "expected at least one commit");
            assert_eq!(commits[0].oid.len(), 40, "OID must be full 40-hex");
        }

        /// Verify that blame on this source file returns at least one hunk.
        #[test]
        fn test_blame_self() {
            let repo_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
            let repo = open_repo(repo_path.to_str().unwrap()).expect("open repo");
            let hunks = blame(&repo, "src/git.rs", "HEAD").expect("blame");
            assert!(!hunks.is_empty(), "expected at least one blame hunk");
        }
    }
}
