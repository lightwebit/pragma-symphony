use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

// ---------------------------------------------------------------------------
// Lock per working directory
//
// Parallel sessions are allowed only between different projects, and the constraint is a
// must, not a suggestion: two sessions on the same directory fight over the
// session branch checkout and overwrite each other's files.
// The hard guard lives here, in the backend — the only point that *really* sees which
// processes are writing where. The frontend has its own twin guard, which gives the
// message before even trying; this is the net that holds even if the UI
// is wrong or if someone reopens the same dir from another project.
//
// The lock is per session, not per process: the same session can open several
// streams in sequence (VERIFY fix turn, re-review) and counts them with a
// refcount instead of fighting with itself.
// ---------------------------------------------------------------------------

struct Held {
    session_id: String,
    holders: usize,
}

#[derive(Clone, Default)]
pub struct DirLocks(Arc<TokioMutex<HashMap<String, Held>>>);

impl DirLocks {
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes the lock on the directory on behalf of `session_id`.
    /// `Err(other_session)` if the directory is occupied by another session.
    pub async fn claim(&self, key: &str, session_id: &str) -> Result<(), String> {
        let mut map = self.0.lock().await;
        match map.get_mut(key) {
            Some(held) if held.session_id != session_id => Err(held.session_id.clone()),
            Some(held) => {
                held.holders += 1;
                Ok(())
            }
            None => {
                map.insert(
                    key.to_string(),
                    Held {
                        session_id: session_id.to_string(),
                        holders: 1,
                    },
                );
                Ok(())
            }
        }
    }

    pub async fn release(&self, key: &str) {
        let mut map = self.0.lock().await;
        if let Some(held) = map.get_mut(key) {
            held.holders = held.holders.saturating_sub(1);
            if held.holders == 0 {
                map.remove(key);
            }
        }
    }

    /// Session holding the directory, if occupied. Used only by tests and debugging.
    #[cfg(test)]
    pub async fn holder(&self, key: &str) -> Option<String> {
        self.0.lock().await.get(key).map(|h| h.session_id.clone())
    }
}

/// Comparison key between directories: two paths pointing to the same place must
/// collide even if written differently (trailing slash, case on Windows,
/// relative path). `canonicalize` fails on non-existent directories — in that case
/// we fall back to the path as it is, which is still better than no comparison.
pub fn dir_key(dir: &str) -> String {
    let path = std::path::Path::new(dir);
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = resolved.to_string_lossy();
    let trimmed = text.trim_end_matches(['/', '\\']);
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn second_session_on_same_dir_is_refused() {
        let locks = DirLocks::new();
        locks.claim("/repo", "session-a").await.unwrap();
        let err = locks.claim("/repo", "session-b").await.unwrap_err();
        assert_eq!(err, "session-a");
    }

    #[tokio::test]
    async fn different_dirs_run_in_parallel() {
        let locks = DirLocks::new();
        locks.claim("/repo-one", "session-a").await.unwrap();
        assert!(locks.claim("/repo-two", "session-b").await.is_ok());
    }

    #[tokio::test]
    async fn same_session_can_reclaim_and_needs_matching_releases() {
        let locks = DirLocks::new();
        locks.claim("/repo", "session-a").await.unwrap();
        // VERIFY fix turn: same session, second stream on the same dir.
        locks.claim("/repo", "session-a").await.unwrap();
        locks.release("/repo").await;
        assert_eq!(locks.holder("/repo").await.as_deref(), Some("session-a"));
        locks.release("/repo").await;
        assert!(locks.holder("/repo").await.is_none());
    }

    #[tokio::test]
    async fn released_dir_is_free_for_another_session() {
        let locks = DirLocks::new();
        locks.claim("/repo", "session-a").await.unwrap();
        locks.release("/repo").await;
        assert!(locks.claim("/repo", "session-b").await.is_ok());
    }

    #[test]
    fn dir_key_ignores_trailing_separator() {
        assert_eq!(dir_key("/tmp/pragma-x/"), dir_key("/tmp/pragma-x"));
    }

    #[cfg(windows)]
    #[test]
    fn dir_key_is_case_insensitive_on_windows() {
        assert_eq!(dir_key(r"C:\Repo\App"), dir_key(r"c:\repo\app"));
    }
}
