// ---------------------------------------------------------------------------
// Git around a session — at the start of a session, in versioned working dirs, Pragma records
// the commit it starts from, so the diff for REVIEW is exactly what the session changed.
// Optionally it also creates a `pragma/<session-id>` branch, which makes discarding a session
// trivial (discard the branch). No judgement involved: mechanical git commands, no Claude
// session involved.
// ---------------------------------------------------------------------------

use std::process::Stdio;
use tokio::process::Command;

/// Outcome of creating the session branch: the branch name and the SHA of the
/// commit it was forked from — the latter is the base of the diff fed to
/// the REVIEW phase.
pub struct SessionBranch {
    pub branch: String,
    pub base: String,
}

async fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("could not run git: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

pub async fn is_git_repo(dir: &str) -> bool {
    Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Creates and switches to the branch `pragma/<session_id>` in `dir`, recording the
/// starting SHA. Returns git's error (branch already exists, repo without commits,
/// git not installed…) without ever blocking the session: the caller degrades.
pub async fn create_session_branch(dir: &str, session_id: &str) -> Result<SessionBranch, String> {
    // Base of the diff: it must be captured *before* the checkout, otherwise it would already
    // point to the new branch. On a repo without commits there is no HEAD — no branch.
    let base = git(dir, &["rev-parse", "HEAD"]).await?.trim().to_string();
    let branch = format!("pragma/{session_id}");
    git(dir, &["checkout", "-b", &branch]).await?;
    Ok(SessionBranch { branch, base })
}

/// Records where a session starts, without touching the repository: the commit `HEAD`, or,
/// if the working tree has uncommitted changes to tracked files, a snapshot commit of that
/// state (`git stash create`, which writes an object but changes neither the tree, the index
/// nor any ref). The REVIEW diff is then exactly what the session changed, not what was
/// already there. Untracked files that existed before the session cannot be told apart and
/// show up as added. Fails on a repo without commits.
pub async fn capture_base(dir: &str) -> Result<String, String> {
    let head = git(dir, &["rev-parse", "HEAD"]).await?.trim().to_string();
    match git(dir, &["stash", "create"]).await {
        Ok(snapshot) if !snapshot.trim().is_empty() => Ok(snapshot.trim().to_string()),
        _ => Ok(head),
    }
}

/// Full diff of the session: current working tree against the branch base.
/// It includes uncommitted changes — Claude sessions often do not commit —
/// and, thanks to `add -N`, also new files not yet tracked.
pub async fn diff_since(dir: &str, base: &str) -> Result<String, String> {
    // intent-to-add: without it the files created by the session would be invisible
    // to `git diff`. It does not stage the content, it only records the path exists.
    let _ = git(dir, &["add", "-A", "-N"]).await;
    git(dir, &["diff", base]).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pragma_git_{label}_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn init(dir: &std::path::Path) {
        let d = dir.to_str().unwrap();
        git(d, &["init", "-q"]).await.unwrap();
        git(d, &["config", "user.email", "t@example.com"])
            .await
            .unwrap();
        git(d, &["config", "user.name", "Test"]).await.unwrap();
        git(d, &["config", "commit.gpgsign", "false"])
            .await
            .unwrap();
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(d, &["add", "-A"]).await.unwrap();
        git(d, &["commit", "-q", "-m", "init"]).await.unwrap();
    }

    #[tokio::test]
    async fn base_on_a_clean_tree_is_head() {
        let dir = temp_repo("clean");
        init(&dir).await;
        let d = dir.to_str().unwrap();
        let head = git(d, &["rev-parse", "HEAD"])
            .await
            .unwrap()
            .trim()
            .to_string();
        assert_eq!(capture_base(d).await.unwrap(), head);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn the_diff_holds_only_what_the_session_changed_on_a_dirty_tree() {
        let dir = temp_repo("dirty");
        init(&dir).await;
        let d = dir.to_str().unwrap();
        // Work already there before the session starts.
        std::fs::write(dir.join("a.txt"), "one\nbefore\n").unwrap();
        let base = capture_base(d).await.unwrap();
        // The session adds a line and a new file.
        std::fs::write(dir.join("a.txt"), "one\nbefore\nduring\n").unwrap();
        std::fs::write(dir.join("b.txt"), "new\n").unwrap();

        let diff = diff_since(d, &base).await.unwrap();
        assert!(
            diff.contains("+during"),
            "the session change must be in the diff"
        );
        assert!(
            diff.contains("b.txt"),
            "a file created by the session must be in the diff"
        );
        assert!(
            !diff.contains("+before"),
            "work done before the session must not be in the diff"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn base_fails_outside_a_repo_and_without_commits() {
        let dir = temp_repo("none");
        let d = dir.to_str().unwrap();
        assert!(capture_base(d).await.is_err());
        git(d, &["init", "-q"]).await.unwrap();
        assert!(capture_base(d).await.is_err(), "no commit, no HEAD");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn capturing_the_base_leaves_the_repository_untouched() {
        let dir = temp_repo("untouched");
        init(&dir).await;
        let d = dir.to_str().unwrap();
        std::fs::write(dir.join("a.txt"), "one\nedited\n").unwrap();
        capture_base(d).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "one\nedited\n"
        );
        assert!(git(d, &["stash", "list"]).await.unwrap().trim().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
