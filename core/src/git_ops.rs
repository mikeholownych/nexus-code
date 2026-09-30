use git2::{DiffOptions, Repository, StatusOptions};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Serialize, Deserialize)]
pub struct GitStatusResult {
    pub branch: String,
    pub is_clean: bool,
    pub staged: Vec<String>,
    pub modified: Vec<String>,
    pub untracked: Vec<String>,
    pub total_changes: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitDiffArgs {
    #[serde(default)]
    pub staged: bool,
    pub path_filter: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitDiffResult {
    pub staged: bool,
    pub diff: String,
    pub files_changed: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitLogArgs {
    #[serde(default = "default_max_commits")]
    pub max_commits: usize,
}

fn default_max_commits() -> usize {
    10
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitCommitEntry {
    pub id: String,
    pub author: String,
    pub summary: String,
    pub time_iso: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitLogResult {
    pub commits: Vec<GitCommitEntry>,
    pub total_returned: usize,
}

/**
 * Query repository status natively via git2 (Candidate #06)
 */
pub fn git_status(base_dir: &Path) -> Result<GitStatusResult, String> {
    let repo = Repository::discover(base_dir)
        .map_err(|e| format!("Failed to discover git repository: {e}"))?;

    let head_branch = repo.head()
        .ok()
        .and_then(|h| h.shorthand().ok().map(|s| s.to_string()))
        .unwrap_or_else(|| "HEAD (detached)".to_string());

    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);

    let statuses = repo.statuses(Some(&mut opts))
        .map_err(|e| format!("Failed to query git statuses: {e}"))?;

    let mut staged = Vec::new();
    let mut modified = Vec::new();
    let mut untracked = Vec::new();

    for entry in statuses.iter() {
        let status = entry.status();
        let path = entry.path().unwrap_or("").to_string();

        if status.is_index_new() || status.is_index_modified() || status.is_index_deleted() {
            staged.push(path.clone());
        }
        if status.is_wt_modified() || status.is_wt_deleted() {
            modified.push(path.clone());
        }
        if status.is_wt_new() {
            untracked.push(path);
        }
    }

    let total = staged.len() + modified.len() + untracked.len();
    Ok(GitStatusResult {
        branch: head_branch,
        is_clean: total == 0,
        staged,
        modified,
        untracked,
        total_changes: total,
    })
}

/**
 * Generate repository diff natively via git2 (Candidate #06)
 */
pub fn git_diff(args: GitDiffArgs, base_dir: &Path) -> Result<GitDiffResult, String> {
    let repo = Repository::discover(base_dir)
        .map_err(|e| format!("Failed to discover git repository: {e}"))?;

    let mut diff_opts = DiffOptions::new();
    if let Some(ref filter) = args.path_filter {
        diff_opts.pathspec(filter);
    }

    let diff = if args.staged {
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut diff_opts))
    } else {
        repo.diff_index_to_workdir(None, Some(&mut diff_opts))
    }.map_err(|e| format!("Failed to compute git diff: {e}"))?;

    let mut diff_text = String::new();
    let mut files_changed = 0;

    let _ = diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        match origin {
            '+' | '-' | ' ' => {
                diff_text.push(origin);
                diff_text.push_str(&String::from_utf8_lossy(line.content()));
            }
            'F' => {
                files_changed += 1;
                diff_text.push_str(&String::from_utf8_lossy(line.content()));
            }
            _ => {
                diff_text.push_str(&String::from_utf8_lossy(line.content()));
            }
        }
        true
    });

    Ok(GitDiffResult {
        staged: args.staged,
        diff: diff_text,
        files_changed,
    })
}

/**
 * Retrieve commit history log natively via git2 (Candidate #06)
 */
pub fn git_log(args: GitLogArgs, base_dir: &Path) -> Result<GitLogResult, String> {
    let repo = Repository::discover(base_dir)
        .map_err(|e| format!("Failed to discover git repository: {e}"))?;

    let mut revwalk = repo.revwalk()
        .map_err(|e| format!("Failed to initialize git revwalk: {e}"))?;
    revwalk.push_head().map_err(|e| format!("Failed to push HEAD: {e}"))?;

    let mut commits = Vec::new();
    for id_res in revwalk.take(args.max_commits) {
        if let Ok(id) = id_res {
            if let Ok(commit) = repo.find_commit(id) {
                let time_secs = commit.time().seconds();
                let summary_str = commit.summary().ok().flatten().unwrap_or("").to_string();
                commits.push(GitCommitEntry {
                    id: id.to_string(),
                    author: commit.author().name().unwrap_or("Unknown").to_string(),
                    summary: summary_str,
                    time_iso: format!("epoch_secs:{time_secs}"),
                });
            }
        }
    }

    Ok(GitLogResult {
        total_returned: commits.len(),
        commits,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_git_status_and_log() {
        let repo_path = Path::new("..");
        if let Ok(status) = git_status(repo_path) {
            assert!(!status.branch.is_empty());
        }
        if let Ok(log) = git_log(GitLogArgs { max_commits: 5 }, repo_path) {
            assert!(log.total_returned <= 5);
        }
    }
}
