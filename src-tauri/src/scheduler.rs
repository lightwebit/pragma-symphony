//! Scheduled sessions: a prompt + an instant in the future, waiting to
//! fire by themselves. It lives entirely inside the app — there is no integration with the
//! system scheduler — so it only covers the case "the app is open when the
//! time comes"; the case "the app was closed" is handled separately as a `missed` state (see
//! `mark_overdue_as_missed` in pragma-parser/src/storage.rs) and left to the
//! user's choice at restart, never to an automatic decision.
//!
//! The module is split into two layers because of a constraint already paid for in the past: a module
//! that calls `AppHandle` becomes untestable under `cargo test` (`STATUS_ENTRYPOINT_NOT_FOUND`).
//! Here `plan_tick` is pure — no DB, no `AppHandle`, no process — and all the
//! rest (`tick`, `fire_one`, `spawn`) is the impure shell that is not unit-tested.

use crate::session_locks::{dir_key, DirLocks};
use crate::{
    start_session_core, ActiveSessions, StartSessionError, StartSessionParams, TrustedDirs,
};
use pragma_parser::settings::load_settings;
use pragma_parser::storage::ScheduledSession;
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

const TICK: Duration = Duration::from_secs(20);

/// What to do, in a tick, for each overdue row.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TickAction {
    /// Start this row now.
    Fire(String),
    /// Another overdue row in this same tick already holds the same working
    /// dir — this one waits for the next tick, there is no point even
    /// trying: it would only get a `DirBusy` and go back in the queue.
    SkipSameDir(String),
}

/// Decides the actions of a tick, given the list of overdue rows (already ordered by
/// `run_at` ASC by `list_due_scheduled`). Pure: no call to "impure" Rust.
///
/// Two overdue rows on the same working dir cannot start in the same tick:
/// the oldest wins, the other waits. Rows with `working_dir: None` never collide
/// with each other (no directory to contend for).
pub(crate) fn plan_tick(due: &[ScheduledSession]) -> Vec<TickAction> {
    let mut claimed: HashSet<String> = HashSet::new();
    due.iter()
        .map(|row| match row.working_dir.as_deref() {
            Some(dir) => {
                let key = dir_key(dir);
                if claimed.insert(key) {
                    TickAction::Fire(row.id.clone())
                } else {
                    TickAction::SkipSameDir(row.id.clone())
                }
            }
            None => TickAction::Fire(row.id.clone()),
        })
        .collect()
}

/// Starts the scheduler loop. Called once from `lib.rs::run()`,
/// inside `.setup()`.
pub(crate) fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Gives the webview time to install its listeners before the initial sweep:
        // in Tauri's `setup` the frontend may not be ready yet, and emitting
        // `scheduler:missed` too early would lose it in the void. The frontend
        // re-reads the state with `list_scheduled_sessions` at its own start anyway
        // (source of truth) — this event is only a confirmation for an app already open.
        tokio::time::sleep(Duration::from_secs(2)).await;
        sweep_missed(&app).await;

        loop {
            tokio::time::sleep(TICK).await;
            tick(&app).await;
        }
    });
}

async fn sweep_missed(app: &AppHandle) {
    let now = chrono::Utc::now().to_rfc3339();
    match pragma_parser::storage::mark_overdue_as_missed(&now) {
        Ok(missed) if !missed.is_empty() => {
            let _ = app.emit("scheduler:missed", &missed);
        }
        Ok(_) => {}
        Err(e) => {
            let _ = app.emit(
                "session:debug",
                format!("[scheduler] mark_overdue_as_missed failed: {e}"),
            );
        }
    }
}

async fn tick(app: &AppHandle) {
    let now = chrono::Utc::now().to_rfc3339();
    let due = match pragma_parser::storage::list_due_scheduled(&now) {
        Ok(rows) => rows,
        Err(e) => {
            let _ = app.emit(
                "session:debug",
                format!("[scheduler] list_due_scheduled failed: {e}"),
            );
            return;
        }
    };
    if due.is_empty() {
        return;
    }

    let by_id: HashMap<String, ScheduledSession> =
        due.iter().map(|r| (r.id.clone(), r.clone())).collect();

    let sessions = app.state::<ActiveSessions>();
    let trusted_dirs = app.state::<TrustedDirs>();
    let dir_locks = app.state::<DirLocks>();

    for action in plan_tick(&due) {
        let TickAction::Fire(id) = action else {
            continue;
        };
        let Some(row) = by_id.get(&id) else { continue };
        fire_one(
            app.clone(),
            row.clone(),
            &sessions,
            &trusted_dirs,
            &dir_locks,
        )
        .await;
    }
}

/// Fires a scheduled session: resolves the profile, calls the same
/// `start_session_core` as the manual Run, and updates the row's status according to
/// the outcome. Called both by the tick and by the `run_scheduled_session_now` command
/// ("Run now" button of the "missed" dialog).
pub(crate) async fn fire_one(
    app: AppHandle,
    row: ScheduledSession,
    sessions: &ActiveSessions,
    trusted_dirs: &TrustedDirs,
    dir_locks: &DirLocks,
) {
    let settings = load_settings().unwrap_or_default();
    let profile = row
        .profile_label
        .as_deref()
        .and_then(|label| settings.profiles.iter().find(|p| p.label == label))
        .or_else(|| settings.profiles.first());

    let Some(profile) = profile else {
        let _ = pragma_parser::storage::set_scheduled_status(
            &row.id,
            "missed",
            None,
            Some("No Claude profile configured"),
        );
        let _ = app.emit(
            "scheduler:failed",
            serde_json::json!({ "id": row.id, "error": "No Claude profile configured" }),
        );
        return;
    };

    let binary = profile.binary.clone();
    let config_dir = profile.config_dir.clone();
    let profile_label = Some(profile.label.clone());
    let new_session_id = Uuid::new_v4().to_string();

    let params = StartSessionParams {
        prompt: row.prompt.clone(),
        binary: binary.clone(),
        project_id: row.project_id.clone(),
        config_dir: config_dir.clone(),
        working_dir: row.working_dir.clone(),
        profile_label,
        title: row.title.clone(),
        model: row.model.clone(),
        attachments: Some(row.attachments.clone()),
        existing_session_id: None,
        new_session_id: Some(new_session_id.clone()),
        step_by_step: Some(row.step_by_step),
    };

    match start_session_core(app.clone(), params, sessions, trusted_dirs, dir_locks).await {
        Ok(session_id) => {
            let _ = pragma_parser::storage::set_scheduled_status(
                &row.id,
                "fired",
                Some(&session_id),
                None,
            );
            let _ = app.emit(
                "scheduler:fired",
                serde_json::json!({
                    "scheduled": row,
                    "sessionId": session_id,
                    "binary": binary,
                    "configDir": config_dir,
                }),
            );
        }
        Err(StartSessionError::DirBusy { .. }) => {
            // Re-emitting on every tick would make a toast flicker every 20s until
            // the dir frees up: it is emitted only on the first transition to
            // `queued`, rows already in the queue stay silent until they start or
            // until the DirBusy goes away.
            if row.status != "queued" {
                let _ = pragma_parser::storage::set_scheduled_status(&row.id, "queued", None, None);
                let _ = app.emit("scheduler:queued", serde_json::json!({ "id": row.id }));
            }
        }
        Err(StartSessionError::Other(m)) => {
            let _ = pragma_parser::storage::set_scheduled_status(&row.id, "missed", None, Some(&m));
            let _ = app.emit(
                "scheduler:failed",
                serde_json::json!({ "id": row.id, "error": m }),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, run_at: &str, working_dir: Option<&str>) -> ScheduledSession {
        ScheduledSession {
            id: id.to_string(),
            project_id: "p1".to_string(),
            prompt: "do a thing".to_string(),
            run_at: run_at.to_string(),
            working_dir: working_dir.map(str::to_string),
            profile_label: None,
            model: None,
            attachments: vec![],
            title: None,
            step_by_step: false,
            auto_confirm: true,
            status: "pending".to_string(),
            session_id: None,
            last_error: None,
            created_at: run_at.to_string(),
            updated_at: run_at.to_string(),
        }
    }

    #[test]
    fn different_dirs_all_fire() {
        let due = vec![
            row("a", "2026-08-16T10:00:00Z", Some("C:/repo-one")),
            row("b", "2026-08-16T10:01:00Z", Some("C:/repo-two")),
        ];
        assert_eq!(
            plan_tick(&due),
            vec![
                TickAction::Fire("a".to_string()),
                TickAction::Fire("b".to_string()),
            ]
        );
    }

    // dir_key normalizes case only on Windows (session_locks::dir_key): on Linux
    // two paths that differ only by case are truly different directories, so the
    // test — which expects the collision — only holds there. Found by the real CI:
    // `same_dir_written_differently_only_first_fires` failed on Linux because both
    // rows started instead of just one. Same gating as the twin test in
    // session_locks::tests::dir_key_is_case_insensitive_on_windows.
    #[cfg(windows)]
    #[test]
    fn same_dir_written_differently_only_first_fires() {
        // Trailing slash and slash direction: see the comment above for case.
        let due = vec![
            row("a", "2026-08-16T10:00:00Z", Some(r"C:\Repo\App")),
            row("b", "2026-08-16T10:01:00Z", Some(r"c:\repo\app\")),
        ];
        assert_eq!(
            plan_tick(&due),
            vec![
                TickAction::Fire("a".to_string()),
                TickAction::SkipSameDir("b".to_string()),
            ]
        );
    }

    /// The collision itself (not only the case normalization, gated above) must
    /// stay proven on every platform: here with the trailing slash, which `dir_key` normalizes
    /// everywhere (`dir_key_ignores_trailing_separator`).
    #[test]
    fn same_dir_with_trailing_slash_only_first_fires() {
        let due = vec![
            row("a", "2026-08-16T10:00:00Z", Some("/repo/app")),
            row("b", "2026-08-16T10:01:00Z", Some("/repo/app/")),
        ];
        assert_eq!(
            plan_tick(&due),
            vec![
                TickAction::Fire("a".to_string()),
                TickAction::SkipSameDir("b".to_string()),
            ]
        );
    }

    #[test]
    fn rows_without_working_dir_never_collide() {
        let due = vec![
            row("a", "2026-08-16T10:00:00Z", None),
            row("b", "2026-08-16T10:01:00Z", None),
        ];
        assert_eq!(
            plan_tick(&due),
            vec![
                TickAction::Fire("a".to_string()),
                TickAction::Fire("b".to_string()),
            ]
        );
    }
}
