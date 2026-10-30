mod category;
mod e2e;
mod events;
mod files;
mod git_branch;
mod live;
mod pipeline;
mod process;
mod protocol;
mod review;
mod runner;
mod scheduler;
mod session_locks;
mod trust;
mod usage;
mod verify;

use events::emit_session;
use files::{do_copy_to_pragmadocs, sanitize_title};
use pragma_parser::{
    settings::{
        detect_claude_binary, load_prompt, load_settings, load_settings_with_autodetect,
        resolve_export_dir, save_settings, Settings,
    },
    storage::{
        create_project as db_create_project, delete_project as db_delete_project,
        delete_session as db_delete_session, duplicate_session as db_duplicate_session,
        export_session_json, get_project as db_get_project, list_pipeline_steps,
        list_projects as db_list_projects, list_sessions_for_project, load_session_atoms,
        load_session_info, replace_pipeline_steps, save_atom as db_save_atom,
        search_sessions_for_project, update_e2e_config as db_update_e2e_config,
        update_live_command as db_update_live_command, update_project as db_update_project,
        update_session_attachments as db_update_session_attachments, write_export_file,
        write_markdown_file, PipelineStep, ProjectInfo, SessionInfo,
    },
    types::Atom,
};
use process::stream_claude;
use protocol::{PRAGMA_PROTOCOL, PRAGMA_STEP_BY_STEP};
use review::{run_review, ReviewFinding};
use session_locks::{dir_key, DirLocks};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex as TokioMutex;
use trust::TrustedDirs;
use usage::get_claude_usage;
use uuid::Uuid;
use verify::run_verify;

struct ActiveSessions(Arc<TokioMutex<HashMap<String, tokio::process::Child>>>);

/// Stop channel of the E2E run in progress. Only one at a time: the button is per
/// project and the run is long — allowing two in parallel would only make
/// them fight over the same working dir.
struct ActiveE2eRun(Arc<TokioMutex<Option<tokio::sync::oneshot::Sender<()>>>>);

/// Same principle as `ActiveE2eRun`, for the Live button — one run at a time,
/// same reason (shared working dir).
struct ActiveLiveRun(Arc<TokioMutex<Option<tokio::sync::oneshot::Sender<()>>>>);

/// Idem per la pipeline locale.
struct ActivePipelineRun(Arc<TokioMutex<Option<tokio::sync::oneshot::Sender<()>>>>);

/// Message of the one-session-per-directory guard — never a silent start: whoever pressed "run" must
/// know which session is occupying the directory and why two cannot start.
fn busy_dir_message(dir: &str, holder_session: &str) -> String {
    let short: String = holder_session.chars().take(8).collect();
    format!(
        "Working directory busy: session {short} is already active in {dir}. \
         Parallel sessions are allowed only across different projects — \
         two sessions on the same directory would fight over the session branch \
         and overwrite each other's files."
    )
}

/// Arguments of a continuation turn. The message stays last: it is the positional
/// prompt of `claude`.
fn control_args(session_id: &str, message: &str, model_id: Option<&str>) -> Vec<String> {
    let mut args = vec!["--resume".to_string(), session_id.to_string()];
    if let Some(id) = model_id {
        args.push("--model".to_string());
        args.push(id.to_string());
    }
    args.push(message.to_string());
    args
}

#[cfg(test)]
mod control_args_tests {
    use super::control_args;

    #[test]
    fn passes_model_before_message() {
        assert_eq!(
            control_args("abc", "CONTINUE", Some("claude-opus-4-8")),
            ["--resume", "abc", "--model", "claude-opus-4-8", "CONTINUE"]
        );
    }

    #[test]
    fn no_model_flag_without_model_id() {
        assert_eq!(
            control_args("abc", "CONTINUE", None),
            ["--resume", "abc", "CONTINUE"]
        );
    }
}

// ---------------------------------------------------------------------------
// Session commands
// ---------------------------------------------------------------------------

/// Start parameters of a session, identical between the manual Run (command
/// `run_pragma`) and the firing of a scheduled session (`scheduler.rs`). They exist
/// because the body of `run_pragma` could not be called from anywhere else:
/// it was welded to the arguments injected by the Tauri command.
pub(crate) struct StartSessionParams {
    pub prompt: String,
    pub binary: String,
    pub project_id: String,
    pub config_dir: Option<String>,
    pub working_dir: Option<String>,
    pub profile_label: Option<String>,
    pub title: Option<String>,
    pub model: Option<String>,
    pub attachments: Option<Vec<String>>,
    pub existing_session_id: Option<String>,
    pub new_session_id: Option<String>,
    pub step_by_step: Option<bool>,
}

/// Error outcome of `start_session_core` — distinct from a `String` because the
/// scheduler must be able to decide "put back in the queue" (directory busy) without
/// comparing text, which is fragile and breaks at the first refactor of the message.
pub(crate) enum StartSessionError {
    DirBusy { holder: String, dir: String },
    Other(String),
}

impl std::fmt::Display for StartSessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // Text identical to busy_dir_message: session.test.ts and the E2E specs
            // compare it by regex on the manual Run's error message.
            Self::DirBusy { holder, dir } => write!(f, "{}", busy_dir_message(dir, holder)),
            Self::Other(m) => write!(f, "{m}"),
        }
    }
}

/// Does the session already have a live `claude` process? Two turns on the same session (an Approve
/// from the desktop and one from the web almost together, or a frontend bug) would both start: the
/// directory lock is per session and the same session resumes it. The frontend already prevents this;
/// this is the second line, in the backend. A process killed with Stop and not yet
/// removed from the map does not count: `try_wait` already reports it as exited.
async fn has_live_process(sessions: &ActiveSessions, session_id: &str) -> bool {
    let mut map = sessions.0.lock().await;
    match map.get_mut(session_id) {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    }
}

const ALREADY_RUNNING: &str = "This session is already running.";

#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn run_pragma(
    app: AppHandle,
    prompt: String,
    binary: String,
    project_id: String,
    config_dir: Option<String>,
    working_dir: Option<String>,
    profile_label: Option<String>,
    title: Option<String>,
    model: Option<String>,
    attachments: Option<Vec<String>>,
    existing_session_id: Option<String>,
    new_session_id: Option<String>,
    step_by_step: Option<bool>,
    sessions: tauri::State<'_, ActiveSessions>,
    trusted_dirs: tauri::State<'_, TrustedDirs>,
    dir_locks: tauri::State<'_, DirLocks>,
) -> Result<String, String> {
    if let Some(ref id) = existing_session_id {
        if has_live_process(&sessions, id).await {
            return Err(ALREADY_RUNNING.to_string());
        }
    }
    start_session_core(
        app,
        StartSessionParams {
            prompt,
            binary,
            project_id,
            config_dir,
            working_dir,
            profile_label,
            title,
            model,
            attachments,
            existing_session_id,
            new_session_id,
            step_by_step,
        },
        &sessions,
        &trusted_dirs,
        &dir_locks,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Shared core of starting a session — manual Run (`run_pragma`) and scheduled firing
/// (`scheduler::fire_one`) walk exactly this path: same
/// directory lock, same session branch, same VERIFY/REVIEW.
/// Neither has a parallel path bound to drift from the other.
pub(crate) async fn start_session_core(
    app: AppHandle,
    p: StartSessionParams,
    sessions: &ActiveSessions,
    trusted_dirs: &TrustedDirs,
    dir_locks: &DirLocks,
) -> Result<String, StartSessionError> {
    let StartSessionParams {
        prompt,
        binary,
        project_id,
        config_dir,
        working_dir,
        profile_label,
        title,
        model,
        attachments,
        existing_session_id,
        new_session_id,
        step_by_step,
    } = p;

    let (session_id, session_id_str, resume) = if let Some(ref existing) = existing_session_id {
        let uuid = existing
            .parse::<Uuid>()
            .map_err(|e| StartSessionError::Other(format!("invalid session_id: {e}")))?;
        (uuid, existing.clone(), true)
    } else {
        // The id of a new session may come from the frontend: the record
        // in the sessions map must exist *before* the invoke, otherwise
        // the events emitted between the spawn and this function returning would
        // find nobody to be delivered to.
        let uuid = match new_session_id {
            Some(ref given) => given
                .parse::<Uuid>()
                .map_err(|e| StartSessionError::Other(format!("invalid session_id: {e}")))?,
            None => Uuid::new_v4(),
        };
        let s = uuid.to_string();
        (uuid, s, false)
    };

    // Guard: one session per working directory. See session_locks.rs.
    let lock_key = working_dir.as_deref().map(dir_key);
    if let Some(ref key) = lock_key {
        if let Err(holder) = dir_locks.claim(key, &session_id_str).await {
            return Err(StartSessionError::DirBusy {
                holder,
                dir: working_dir.as_deref().unwrap_or_default().to_string(),
            });
        }
    }
    let locks_for_task = dir_locks.clone();
    let lock_key_for_task = lock_key.clone();

    let settings = pragma_parser::settings::load_settings().unwrap_or_default();

    let mut extra_args: Vec<String> = if resume {
        vec!["--resume".to_string(), session_id_str.clone()]
    } else {
        vec!["--session-id".to_string(), session_id_str.clone()]
    };

    if let Some(model_id) = settings.models.resolve(model.as_deref()) {
        extra_args.push("--model".to_string());
        extra_args.push(model_id.to_string());
    }
    // Normalized alias for sessions.model — explicit 'sonnet' instead of None,
    // so a NULL row unambiguously stays "created before this field".
    let model_label = model
        .as_deref()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or("sonnet")
        .to_string();

    extra_args.push("--append-system-prompt".to_string());
    let protocol_text = if step_by_step.unwrap_or(false) {
        format!("{}\n{}", PRAGMA_PROTOCOL.trim(), PRAGMA_STEP_BY_STEP.trim())
    } else {
        PRAGMA_PROTOCOL.trim().to_string()
    };
    extra_args.push(protocol_text);

    if let Some(ref label) = profile_label {
        if let Some(sp) = load_prompt(label) {
            extra_args.push("--append-system-prompt".to_string());
            extra_args.push(sp);
        }
        if let Some(profile) = settings.profiles.iter().find(|p| &p.label == label) {
            let lang = profile
                .language
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("English");
            extra_args.push("--append-system-prompt".to_string());
            extra_args.push(format!("Always respond in: {lang}."));
        }
    }

    let wrapped_prompt = if resume {
        prompt.clone()
    } else {
        format!(
            "<pragma>\n\
             MANDATORY: Follow the Pragma protocol for your ENTIRE response.\n\
             - Start with ANALYSIS: (required, always)\n\
             - If unclear: QUESTIONS: / AWAITING_ANSWERS → stop\n\
             - If clear: PLAN: (numbered steps) / AWAITING_CONFIRMATION → stop, do NOT execute yet\n\
             - After confirmation: STEP_COMPLETE: N for each step, then REPORT:, TESTS:, CLOSING: / AWAITING_CLOSE\n\
             - Write ALL marker keywords in English (ANALYSIS:, PLAN:, etc.) even if you reply in another language\n\
             </pragma>\n\n\
             {prompt}"
        )
    };
    extra_args.push(wrapped_prompt);

    let skip_permissions = match &working_dir {
        None => true,
        Some(dir) => {
            if !trusted_dirs.contains(dir) {
                trusted_dirs.insert(dir.clone());
            }
            true
        }
    };

    let debug_args: Vec<String> = extra_args
        .iter()
        .enumerate()
        .map(|(i, a)| {
            if a.len() > 120 {
                format!("[arg{}] {}…", i, &a[..80])
            } else {
                format!("[arg{}] {}", i, a)
            }
        })
        .collect();
    let _ = app.emit(
        "session:debug",
        format!("[run_pragma] args: {}", debug_args.join(" | ")),
    );

    let app2 = app.clone();
    let sid_str = session_id_str.clone();
    let sessions_arc = Arc::clone(&sessions.0);
    let session_branch_enabled = settings.session_branch_enabled;
    let review_enabled = settings.review_enabled;
    // Whoever writes does not review themselves, and the model follows the ambiguity of the
    // task: the diff review runs on Opus, independently of the model
    // chosen for development.
    let review_model_id: Option<String> = settings.models.resolve(Some("opus")).map(str::to_string);

    // Clones used only after the REPORT, for the optional VERIFY phase — binary/project_id/
    // working_dir/config_dir below are moved into stream_claude.
    let binary_for_verify = binary.clone();
    let project_id_for_verify = project_id.clone();
    let working_dir_for_verify = working_dir.clone();
    let config_dir_for_verify = config_dir.clone();
    let sessions_arc_for_verify = Arc::clone(&sessions_arc);

    tauri::async_runtime::spawn(async move {
        // Session branch: only on new sessions, versioned working dirs,
        // option on. No judgement involved — a mechanical git operation, never
        // handed to a Claude session. See git_branch.rs.
        let session_branch: Option<git_branch::SessionBranch> = if !resume && session_branch_enabled
        {
            match working_dir.as_deref() {
                Some(dir) if git_branch::is_git_repo(dir).await => {
                    match git_branch::create_session_branch(dir, &sid_str).await {
                        Ok(sb) => {
                            emit_session(
                                &app2,
                                "session:git_branch",
                                &sid_str,
                                serde_json::json!({ "branch": sb.branch }),
                            );
                            Some(sb)
                        }
                        Err(e) => {
                            let _ = app2.emit(
                                "session:debug",
                                format!("[git_branch] creation failed: {e}"),
                            );
                            None
                        }
                    }
                }
                _ => None,
            }
        } else {
            None
        };
        let git_branch_name = session_branch.as_ref().map(|sb| sb.branch.clone());
        // The base of the REVIEW diff: the session branch's fork point, or, without a branch, the
        // commit (and uncommitted state) the session starts from. A resumed session keeps the
        // one stored when it began.
        let git_base = match session_branch.as_ref() {
            Some(sb) => Some(sb.base.clone()),
            None if !resume && review_enabled => match working_dir.as_deref() {
                Some(dir) if git_branch::is_git_repo(dir).await => {
                    git_branch::capture_base(dir).await.ok()
                }
                _ => None,
            },
            None => None,
        };

        let report_emitted = stream_claude(
            app2,
            session_id,
            binary,
            project_id,
            extra_args,
            working_dir,
            config_dir,
            if resume { None } else { Some(prompt) },
            if resume {
                None
            } else {
                title.as_deref().map(sanitize_title)
            },
            if resume {
                None
            } else {
                Some(model_label.clone())
            },
            attachments.unwrap_or_default(),
            resume,
            skip_permissions,
            sessions_arc,
            git_branch_name,
            git_base.clone(),
        )
        .await;
        let _ = app.emit("session:debug", format!("[run_pragma] done: {sid_str}"));

        // VERIFY → REVIEW phases: only if *this* call actually closed
        // with a REPORT. For a task with a plan this almost never happens here — it happens
        // in the continuation via `send_control`, which calls the same
        // shared function (see `run_verify_and_review`).
        if report_emitted {
            if let Some(wd) = working_dir_for_verify.clone() {
                run_verify_and_review(
                    &app,
                    session_id,
                    &sid_str,
                    &project_id_for_verify,
                    &wd,
                    &binary_for_verify,
                    config_dir_for_verify.as_deref(),
                    git_base.as_deref(),
                    review_model_id.as_deref(),
                    review_enabled,
                    &sessions_arc_for_verify,
                )
                .await;
            }
        }

        // The lock is released only here: VERIFY and REVIEW keep writing and reading
        // in the working dir after the stream ends: freeing it earlier would open
        // the door to a second session right during the diff.
        if let Some(key) = lock_key_for_task {
            locks_for_task.release(&key).await;
        }
    });

    Ok(session_id_str)
}

/// VERIFY → REVIEW phases — shared between `run_pragma` and `send_control`.
///
/// The protocol requires always stopping at AWAITING_CONFIRMATION after the PLAN
/// for any real task, so the REPORT almost never arrives in the first
/// call to `stream_claude` (the one from `run_pragma`): it arrives in the
/// continuation turn, triggered by auto-confirm or the manual click on "Continue",
/// which goes through `send_control`. It must be called from both places every time
/// a stream_claude (initial or continuation) closes with `report_emitted`.
///
/// Field-test bug: before this function VERIFY/REVIEW lived
/// only inside `run_pragma`, so they were in practice unreachable for any
/// task that required a plan — that is, almost all of them.
#[allow(clippy::too_many_arguments)]
async fn run_verify_and_review(
    app: &AppHandle,
    session_id: Uuid,
    sid_str: &str,
    project_id: &str,
    working_dir: &str,
    binary: &str,
    config_dir: Option<&str>,
    git_base: Option<&str>,
    review_model_id: Option<&str>,
    review_enabled: bool,
    sessions_arc: &Arc<TokioMutex<HashMap<String, tokio::process::Child>>>,
) {
    let Ok(project) = pragma_parser::storage::get_project(project_id) else {
        let _ = app.emit(
            "session:debug",
            format!("[verify/review] get_project failed for {project_id}"),
        );
        return;
    };

    // VERIFY phase: requires a configured test_command. Up to 2 automatic fix
    // turns on the same session before leaving the word to the user.
    // `verify_ok` stays true if the phase was skipped (no test_command).
    let has_test_command = project
        .test_command
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let mut verify_ok = true;
    if has_test_command {
        const MAX_FIX_ATTEMPTS: u32 = 2;
        for attempt in 0..=MAX_FIX_ATTEMPTS {
            let outcome = run_verify(app, sid_str, &project, working_dir, binary, config_dir).await;
            verify_ok = outcome.passed;
            if outcome.passed || attempt == MAX_FIX_ATTEMPTS {
                break;
            }
            let fix_msg = format!(
                "VERIFY_FAILED:\nThe following tests are failing and were not \
                 failing before your changes:\n{}\n\nFix these before reporting \
                 again.",
                outcome.new_failures.join("\n")
            );
            let fix_args = vec!["--resume".to_string(), sid_str.to_string(), fix_msg];
            let report_emitted_2 = stream_claude(
                app.clone(),
                session_id,
                binary.to_string(),
                String::new(),
                fix_args,
                Some(working_dir.to_string()),
                config_dir.map(str::to_string),
                None,
                None,
                None,
                vec![],
                true,
                true,
                Arc::clone(sessions_arc),
                None,
                None,
            )
            .await;
            if !report_emitted_2 {
                break;
            }
        }
    }

    // REVIEW phase: separate session on the session branch's diff.
    // It does not start if VERIFY is still red — there the ball is already with the user
    // (two distinct gates, they do not override each other).
    if verify_ok && review_enabled {
        run_review(
            app,
            sid_str,
            &project,
            working_dir,
            git_base,
            binary,
            config_dir,
            review_model_id,
            &[],
            0,
        )
        .await;
    }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn send_control(
    app: AppHandle,
    session_id: String,
    message: String,
    binary: String,
    config_dir: Option<String>,
    working_dir: Option<String>,
    model: Option<String>,
    sessions: tauri::State<'_, ActiveSessions>,
    dir_locks: tauri::State<'_, DirLocks>,
) -> Result<(), String> {
    let uuid = session_id
        .parse::<Uuid>()
        .map_err(|e| format!("invalid session_id: {e}"))?;
    if has_live_process(&sessions, &session_id).await {
        return Err(ALREADY_RUNNING.to_string());
    }

    let settings = load_settings().unwrap_or_default();
    let extra_args = control_args(
        &session_id,
        &message,
        settings.models.resolve(model.as_deref()),
    );

    let sessions_arc = Arc::clone(&sessions.0);

    // Same guard as run_pragma: a paused session can restart only if
    // no other has meanwhile occupied its working dir.
    let lock_key = working_dir.as_deref().map(dir_key);
    if let Some(ref key) = lock_key {
        if let Err(holder) = dir_locks.claim(key, &session_id).await {
            return Err(busy_dir_message(
                working_dir.as_deref().unwrap_or_default(),
                &holder,
            ));
        }
    }
    let locks_for_task = (*dir_locks).clone();

    let review_model_id: Option<String> = settings.models.resolve(Some("opus")).map(str::to_string);
    let review_enabled = settings.review_enabled;

    // VERIFY/REVIEW: the turn that really completes a task with a plan
    // goes through here — see `run_verify_and_review`. project_id and git_base are not
    // arguments of this command (the session is already in the DB on resume), so they are
    // recovered from the session record.
    let session_info = load_session_info(&session_id).ok();
    let project_id_for_verify = session_info.as_ref().map(|s| s.project_id.clone());
    let git_base = session_info.as_ref().and_then(|s| s.git_base.clone());

    let binary_for_verify = binary.clone();
    let config_dir_for_verify = config_dir.clone();
    let working_dir_for_verify = working_dir.clone();
    let sessions_arc_for_verify = Arc::clone(&sessions_arc);

    tauri::async_runtime::spawn(async move {
        let report_emitted = stream_claude(
            app.clone(),
            uuid,
            binary,
            String::new(), // project_id not needed on resume — session already in the DB
            extra_args,
            working_dir,
            config_dir,
            None,
            None,
            None,
            vec![],
            true,
            true,
            sessions_arc,
            None,
            None,
        )
        .await;

        if report_emitted {
            if let (Some(project_id), Some(wd)) = (project_id_for_verify, working_dir_for_verify) {
                run_verify_and_review(
                    &app,
                    uuid,
                    &session_id,
                    &project_id,
                    &wd,
                    &binary_for_verify,
                    config_dir_for_verify.as_deref(),
                    git_base.as_deref(),
                    review_model_id.as_deref(),
                    review_enabled,
                    &sessions_arc_for_verify,
                )
                .await;
            }
        }

        if let Some(key) = lock_key {
            locks_for_task.release(&key).await;
        }
    });

    Ok(())
}

/// "Fix" action of the ReviewCard: sends the findings back to the development session as a
/// corrective turn, then re-runs the review on the result. The convergence rule
/// (max 2 Fix→Review rounds) is applied by the UI, which hides the button after the
/// second round — beyond that, the user decides.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn review_fix(
    app: AppHandle,
    session_id: String,
    findings: Vec<ReviewFinding>,
    binary: String,
    config_dir: Option<String>,
    working_dir: String,
    project_id: String,
    round: u32,
    sessions: tauri::State<'_, ActiveSessions>,
    dir_locks: tauri::State<'_, DirLocks>,
) -> Result<(), String> {
    let uuid = session_id
        .parse::<Uuid>()
        .map_err(|e| format!("invalid session_id: {e}"))?;
    if has_live_process(&sessions, &session_id).await {
        return Err(ALREADY_RUNNING.to_string());
    }

    let settings = load_settings().unwrap_or_default();
    let review_model_id: Option<String> = settings.models.resolve(Some("opus")).map(str::to_string);
    let git_base = load_session_info(&session_id).ok().and_then(|s| s.git_base);
    let sessions_arc = Arc::clone(&sessions.0);

    let lock_key = dir_key(&working_dir);
    if let Err(holder) = dir_locks.claim(&lock_key, &session_id).await {
        return Err(busy_dir_message(&working_dir, &holder));
    }
    let locks_for_task = (*dir_locks).clone();

    tauri::async_runtime::spawn(async move {
        let mut fix_msg = String::from(
            "REVIEW_FINDINGS:\nA separate review session found the following issues in your \
             diff. Fix them, then report again:\n",
        );
        for f in &findings {
            fix_msg.push_str(&format!(
                "- [{}] {}{}: {}\n",
                f.severity,
                f.file.as_deref().unwrap_or("?"),
                f.line.map(|l| format!(":{l}")).unwrap_or_default(),
                f.summary
            ));
            if let Some(d) = &f.detail {
                fix_msg.push_str(&format!("  {d}\n"));
            }
        }

        let fix_args = vec!["--resume".to_string(), session_id.clone(), fix_msg];
        let report_emitted = stream_claude(
            app.clone(),
            uuid,
            binary.clone(),
            String::new(),
            fix_args,
            Some(working_dir.clone()),
            config_dir.clone(),
            None,
            None,
            None,
            vec![],
            true,
            true,
            sessions_arc,
            None,
            None,
        )
        .await;

        // Re-review on the result of the fix: the original findings travel in the prompt
        // so the second pass checks they are really resolved.
        if report_emitted {
            if let Ok(project) = pragma_parser::storage::get_project(&project_id) {
                run_review(
                    &app,
                    &session_id,
                    &project,
                    &working_dir,
                    git_base.as_deref(),
                    &binary,
                    config_dir.as_deref(),
                    review_model_id.as_deref(),
                    &findings,
                    round + 1,
                )
                .await;
            }
        }
        locks_for_task.release(&lock_key).await;
    });

    Ok(())
}

#[tauri::command]
async fn kill_session(
    session_id: String,
    sessions: tauri::State<'_, ActiveSessions>,
) -> Result<(), String> {
    let mut map = sessions.0.lock().await;
    if let Some(child) = map.get_mut(&session_id) {
        let _ = child.kill().await;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Project commands
// ---------------------------------------------------------------------------

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn create_project(
    title: String,
    description: Option<String>,
    working_dir: Option<String>,
    color: Option<String>,
    test_command: Option<String>,
    lint_command: Option<String>,
    coverage_command: Option<String>,
    review_invariants: Option<String>,
    sensitive_paths: Option<String>,
    project_category: Option<String>,
    project_stack: Option<String>,
) -> Result<ProjectInfo, String> {
    db_create_project(
        &title,
        description.as_deref(),
        working_dir.as_deref(),
        color.as_deref(),
        test_command.as_deref(),
        lint_command.as_deref(),
        coverage_command.as_deref(),
        review_invariants.as_deref(),
        sensitive_paths.as_deref(),
        project_category.as_deref(),
        project_stack.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_projects() -> Result<Vec<ProjectInfo>, String> {
    db_list_projects().map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_project(id: String) -> Result<ProjectInfo, String> {
    db_get_project(&id).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn update_project(
    id: String,
    title: String,
    description: Option<String>,
    working_dir: Option<String>,
    color: Option<String>,
    test_command: Option<String>,
    lint_command: Option<String>,
    coverage_command: Option<String>,
    review_invariants: Option<String>,
    sensitive_paths: Option<String>,
    project_category: Option<String>,
    project_stack: Option<String>,
) -> Result<(), String> {
    db_update_project(
        &id,
        &title,
        description.as_deref(),
        working_dir.as_deref(),
        color.as_deref(),
        test_command.as_deref(),
        lint_command.as_deref(),
        coverage_command.as_deref(),
        review_invariants.as_deref(),
        sensitive_paths.as_deref(),
        project_category.as_deref(),
        project_stack.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_project(id: String) -> Result<(), String> {
    db_delete_project(&id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Scheduled sessions commands — see scheduler.rs for the tick and the firing.
// ---------------------------------------------------------------------------

/// `run_at` must be RFC3339 and in the future — same rule both at creation and at
/// reschedule, so a schedule in the past never silently enters the queue.
fn validate_run_at(run_at: &str) -> Result<(), String> {
    let parsed = chrono::DateTime::parse_from_rfc3339(run_at)
        .map_err(|e| format!("run_at is not a valid RFC3339 date: {e}"))?;
    if parsed.with_timezone(&chrono::Utc) <= chrono::Utc::now() {
        return Err("run_at must be in the future".to_string());
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn create_scheduled_session(
    project_id: String,
    prompt: String,
    run_at: String,
    working_dir: Option<String>,
    profile_label: Option<String>,
    model: Option<String>,
    attachments: Option<Vec<String>>,
    title: Option<String>,
    step_by_step: Option<bool>,
    auto_confirm: Option<bool>,
) -> Result<pragma_parser::storage::ScheduledSession, String> {
    validate_run_at(&run_at)?;
    pragma_parser::storage::create_scheduled_session(
        &project_id,
        &prompt,
        &run_at,
        working_dir.as_deref(),
        profile_label.as_deref(),
        model.as_deref(),
        &attachments.unwrap_or_default(),
        title.as_deref(),
        step_by_step.unwrap_or(false),
        auto_confirm.unwrap_or(true),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_scheduled_sessions(
    project_id: String,
) -> Result<Vec<pragma_parser::storage::ScheduledSession>, String> {
    pragma_parser::storage::list_scheduled_sessions(&project_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn cancel_scheduled_session(id: String) -> Result<(), String> {
    pragma_parser::storage::cancel_scheduled_session(&id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn reschedule_scheduled_session(id: String, run_at: String) -> Result<(), String> {
    validate_run_at(&run_at)?;
    pragma_parser::storage::reschedule_scheduled_session(&id, &run_at).map_err(|e| e.to_string())
}

/// Fires a scheduled session right away, without waiting for the tick — used by the
/// "Run now" button of the "missed" dialog.
#[tauri::command]
async fn run_scheduled_session_now(
    app: AppHandle,
    id: String,
    sessions: tauri::State<'_, ActiveSessions>,
    trusted_dirs: tauri::State<'_, TrustedDirs>,
    dir_locks: tauri::State<'_, DirLocks>,
) -> Result<(), String> {
    let row = pragma_parser::storage::get_scheduled_session(&id).map_err(|e| e.to_string())?;
    scheduler::fire_one(app, row, &sessions, &trusted_dirs, &dir_locks).await;
    Ok(())
}

// ── Todos (checklist utente, per progetto) ──────────────────────────────────

/// Maximum text of an item. A checklist is not a notepad: beyond this
/// threshold you are writing a prompt, and the right place is the composer.
const TODO_MAX_LEN: usize = 500;

fn clean_todo_text(text: &str) -> Result<String, String> {
    let t = text.trim();
    if t.is_empty() {
        return Err("Empty to-do.".into());
    }
    if t.chars().count() > TODO_MAX_LEN {
        return Err(format!("To-do too long (max {TODO_MAX_LEN} characters)."));
    }
    Ok(t.to_string())
}

#[tauri::command]
async fn list_todos(project_id: String) -> Result<Vec<pragma_parser::storage::Todo>, String> {
    pragma_parser::storage::list_todos(&project_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_todo(
    project_id: String,
    text: String,
) -> Result<pragma_parser::storage::Todo, String> {
    let text = clean_todo_text(&text)?;
    pragma_parser::storage::create_todo(&project_id, &text).map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_todo_done(id: String, done: bool) -> Result<(), String> {
    pragma_parser::storage::set_todo_done(&id, done).map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_todo_text(id: String, text: String) -> Result<(), String> {
    let text = clean_todo_text(&text)?;
    pragma_parser::storage::update_todo_text(&id, &text).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_todo(id: String) -> Result<(), String> {
    pragma_parser::storage::delete_todo(&id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn clear_done_todos(project_id: String) -> Result<usize, String> {
    pragma_parser::storage::clear_done_todos(&project_id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// E2E commands — outside the session cycle, never a gate.
// ---------------------------------------------------------------------------

#[tauri::command]
fn e2e_runner_catalog() -> Vec<e2e::RunnerEntry> {
    e2e::runner_catalog()
}

#[tauri::command]
fn project_category_catalog() -> Vec<category::CategoryEntry> {
    category::category_catalog()
}

#[tauri::command]
async fn discover_project_category(
    binary: String,
    config_dir: Option<String>,
    working_dir: String,
) -> Result<category::CategoryDiscovery, String> {
    category::discover(&binary, config_dir.as_deref(), &working_dir).await
}

#[tauri::command]
async fn discover_e2e_runner(
    binary: String,
    config_dir: Option<String>,
    working_dir: String,
) -> Result<e2e::E2eDiscovery, String> {
    e2e::discover(&binary, config_dir.as_deref(), &working_dir).await
}

#[tauri::command]
async fn update_e2e_config(
    project_id: String,
    e2e_command: Option<String>,
    e2e_precondition: Option<String>,
    e2e_runner: Option<String>,
) -> Result<(), String> {
    let clean = |s: Option<String>| s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    db_update_e2e_config(
        &project_id,
        clean(e2e_command).as_deref(),
        clean(e2e_precondition).as_deref(),
        clean(e2e_runner).as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn read_e2e_spec(working_dir: String) -> String {
    e2e::read_spec(&working_dir)
}

#[tauri::command]
fn save_e2e_spec(working_dir: String, text: String) -> Result<String, String> {
    e2e::save_spec(&working_dir, &text)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct E2eGenerationPrompt {
    prompt: String,
    prompt_file: String,
    spec_file: String,
}

/// Prepares script generation: saves the spec, builds the prompt and archives
/// a copy under `.autoTest/prompts/`. It launches nothing — the prompt
/// goes back to the frontend, which puts it in the composer and runs it as a normal Pragma
/// session (visible atoms, iteration possible, VERIFY/REVIEW applicable).
#[tauri::command]
fn prepare_e2e_generation(
    working_dir: String,
    runner_name: String,
    spec: String,
    precondition: Option<String>,
    command: String,
) -> Result<E2eGenerationPrompt, String> {
    let spec_file = e2e::save_spec(&working_dir, &spec)?;
    let prompt =
        e2e::build_generation_prompt(&runner_name, &command, &spec, precondition.as_deref());
    let prompt_file = e2e::write_prompt_artifact(&working_dir, "generate", &prompt)?;
    Ok(E2eGenerationPrompt {
        prompt,
        prompt_file,
        spec_file,
    })
}

#[tauri::command]
async fn run_e2e_suite(
    app: AppHandle,
    project_id: String,
    working_dir: String,
    binary: String,
    config_dir: Option<String>,
    timeout_secs: Option<u64>,
    active_run: tauri::State<'_, ActiveE2eRun>,
) -> Result<e2e::E2eOutcome, String> {
    let project = db_get_project(&project_id).map_err(|e| e.to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut slot = active_run.0.lock().await;
        if slot.is_some() {
            return Err("an E2E run is already in progress".to_string());
        }
        *slot = Some(tx);
    }

    let outcome = e2e::run_e2e(
        &app,
        &project,
        &working_dir,
        &binary,
        config_dir.as_deref(),
        timeout_secs.unwrap_or(e2e::DEFAULT_TIMEOUT_SECS),
        rx,
    )
    .await;

    *active_run.0.lock().await = None;
    Ok(outcome)
}

#[tauri::command]
async fn stop_e2e_run(active_run: tauri::State<'_, ActiveE2eRun>) -> Result<(), String> {
    if let Some(tx) = active_run.0.lock().await.take() {
        let _ = tx.send(());
    }
    Ok(())
}

#[tauri::command]
async fn update_live_command(
    project_id: String,
    live_command: Option<String>,
) -> Result<(), String> {
    let clean = live_command
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    db_update_live_command(&project_id, clean.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_live_command(
    app: AppHandle,
    project_id: String,
    working_dir: String,
    unbounded: bool,
    timeout_secs: Option<u64>,
    active_run: tauri::State<'_, ActiveLiveRun>,
) -> Result<runner::RunOutcome, String> {
    let project = db_get_project(&project_id).map_err(|e| e.to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut slot = active_run.0.lock().await;
        if slot.is_some() {
            return Err("a live run is already in progress".to_string());
        }
        *slot = Some(tx);
    }

    let emitter = app.clone();
    let run_id = project_id.clone();
    let on_line: runner::LineSink = Arc::new(move |l: runner::RunLine| {
        let _ = emitter.emit(
            live::LIVE_OUTPUT_EVENT,
            serde_json::json!({ "runId": run_id, "line": l.line, "stderr": l.stderr }),
        );
    });

    let result = live::run_live(
        &project,
        &working_dir,
        unbounded,
        timeout_secs.unwrap_or(live::DEFAULT_TIMEOUT_SECS),
        Some(on_line),
        Some(rx),
    )
    .await;

    *active_run.0.lock().await = None;
    result
}

#[tauri::command]
async fn stop_live_run(active_run: tauri::State<'_, ActiveLiveRun>) -> Result<(), String> {
    if let Some(tx) = active_run.0.lock().await.take() {
        let _ = tx.send(());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Pipeline locale
// ---------------------------------------------------------------------------

#[tauri::command]
fn pipeline_template_for_stack(stack: Option<String>) -> Option<Vec<pipeline::StepTemplate>> {
    pipeline::template_for_stack(stack.as_deref())
}

#[tauri::command]
fn detect_remote_ci(working_dir: String) -> pipeline::RemoteCiDetection {
    pipeline::detect_remote_ci(&working_dir)
}

#[tauri::command]
async fn get_pipeline_steps(project_id: String) -> Result<Vec<PipelineStep>, String> {
    list_pipeline_steps(&project_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_pipeline_steps(project_id: String, steps: Vec<PipelineStep>) -> Result<(), String> {
    replace_pipeline_steps(&project_id, &steps).map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_project_pipeline(
    app: AppHandle,
    project_id: String,
    working_dir: String,
    binary: String,
    config_dir: Option<String>,
    step_timeout_secs: Option<u64>,
    active_run: tauri::State<'_, ActivePipelineRun>,
) -> Result<pipeline::PipelineOutcome, String> {
    let project = db_get_project(&project_id).map_err(|e| e.to_string())?;
    let steps = list_pipeline_steps(&project_id).map_err(|e| e.to_string())?;
    if steps.iter().all(|s| !s.enabled) {
        return Err("no enabled pipeline steps for this project".to_string());
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut slot = active_run.0.lock().await;
        if slot.is_some() {
            return Err("a pipeline run is already in progress".to_string());
        }
        *slot = Some(tx);
    }

    let emitter = app.clone();
    let run_id = project_id.clone();
    let on_line: Arc<dyn Fn(usize, runner::RunLine) + Send + Sync> =
        Arc::new(move |index: usize, l: runner::RunLine| {
            let _ = emitter.emit(
                pipeline::PIPELINE_OUTPUT_EVENT,
                serde_json::json!({
                    "runId": run_id,
                    "stepIndex": index,
                    "line": l.line,
                    "stderr": l.stderr,
                }),
            );
        });

    let outcome = pipeline::run_pipeline(
        &project,
        &working_dir,
        &steps,
        &binary,
        config_dir.as_deref(),
        step_timeout_secs.unwrap_or(pipeline::DEFAULT_STEP_TIMEOUT_SECS),
        Some(rx),
        Some(on_line),
    )
    .await;

    *active_run.0.lock().await = None;
    Ok(outcome)
}

#[tauri::command]
async fn stop_pipeline_run(active_run: tauri::State<'_, ActivePipelineRun>) -> Result<(), String> {
    if let Some(tx) = active_run.0.lock().await.take() {
        let _ = tx.send(());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Storage commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_sessions(project_id: String) -> Result<Vec<SessionInfo>, String> {
    list_sessions_for_project(&project_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_local_atom(atom: Atom) -> Result<(), String> {
    db_save_atom(&atom).map_err(|e| e.to_string())
}

#[tauri::command]
async fn search_sessions(project_id: String, query: String) -> Result<Vec<SessionInfo>, String> {
    search_sessions_for_project(&project_id, &query).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_session(session_id: String) -> Result<Vec<Atom>, String> {
    load_session_atoms(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_session(session_id: String) -> Result<(), String> {
    db_delete_session(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn duplicate_session(session_id: String) -> Result<String, String> {
    db_duplicate_session(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_session(session_id: String) -> Result<String, String> {
    export_session_json(&session_id).map_err(|e| e.to_string())
}

/// Export subfolder dedicated to the session's project, so that
/// exports of different projects do not end up mixed in the same dir.
fn export_dir_for_session(base: &std::path::Path, session_id: &str) -> std::path::PathBuf {
    let slug = load_session_info(session_id)
        .and_then(|s| db_get_project(&s.project_id))
        .map(|p| p.slug)
        .unwrap_or_else(|_| "misc".to_string());
    base.join(slug)
}

#[tauri::command]
async fn export_session_to_file(session_id: String) -> Result<String, String> {
    let settings = load_settings().map_err(|e| e.to_string())?;
    let base = resolve_export_dir(&settings).map_err(|e| e.to_string())?;
    let dir = export_dir_for_session(&base, &session_id);
    write_export_file(&session_id, &dir)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_session_to_markdown(session_id: String, content: String) -> Result<String, String> {
    let settings = load_settings().map_err(|e| e.to_string())?;
    let base = resolve_export_dir(&settings).map_err(|e| e.to_string())?;
    let dir = export_dir_for_session(&base, &session_id);
    write_markdown_file(&session_id, &content, &dir)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Settings commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn get_settings() -> Result<Settings, String> {
    load_settings_with_autodetect().map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_settings_cmd(settings: Settings) -> Result<(), String> {
    save_settings(&settings).map_err(|e| e.to_string())
}

#[tauri::command]
async fn detect_claude() -> Option<String> {
    detect_claude_binary()
}

// ---------------------------------------------------------------------------
// File/directory picker commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn pick_directory() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .pick_folder()
        .await
        .map(|f| f.path().to_string_lossy().into_owned())
}

#[tauri::command]
async fn pick_file() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .pick_file()
        .await
        .map(|f| f.path().to_string_lossy().into_owned())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(format!("URI scheme not allowed: {url}"));
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", url.as_str()])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn copy_to_pragmadocs(src: String, working_dir: String) -> Result<String, String> {
    do_copy_to_pragmadocs(&src, &working_dir)
}

#[tauri::command]
async fn save_session_attachments(
    session_id: String,
    filenames: Vec<String>,
) -> Result<(), String> {
    db_update_session_attachments(&session_id, &filenames).map_err(|e| e.to_string())
}

#[tauri::command]
async fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

// ---------------------------------------------------------------------------
// Trust store commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn trust_directory(dir: String, state: tauri::State<TrustedDirs>) -> Result<(), String> {
    state.insert(dir);
    Ok(())
}

#[tauri::command]
fn get_trusted_dirs(state: tauri::State<TrustedDirs>) -> Vec<String> {
    state.list()
}

#[tauri::command]
fn remove_trusted_dir(dir: String, state: tauri::State<TrustedDirs>) -> Result<(), String> {
    state.remove(&dir);
    Ok(())
}

/// Non-blocking warning if the profile has an `outputStyle` different from the default —
/// see `pragma_parser::settings::output_style_warning`.
#[tauri::command]
fn check_output_style(config_dir: Option<String>) -> Option<String> {
    pragma_parser::settings::output_style_warning(config_dir.as_deref())
}

// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // E2E harness (.autotest/wdio/). Compiled in only under `--features e2e`:
    // the embedded WebDriver server would otherwise be a remote-control surface
    // in the shipped app.
    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .manage(ActiveSessions(Arc::new(TokioMutex::new(HashMap::new()))))
        .manage(ActiveE2eRun(Arc::new(TokioMutex::new(None))))
        .manage(ActiveLiveRun(Arc::new(TokioMutex::new(None))))
        .manage(ActivePipelineRun(Arc::new(TokioMutex::new(None))))
        .manage(DirLocks::new())
        .manage(TrustedDirs::load())
        .setup(|app| {
            // Sessioni programmate (§ scheduler): sweep di avvio + tick da 20s.
            scheduler::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_pragma,
            send_control,
            review_fix,
            kill_session,
            create_project,
            list_projects,
            get_project,
            update_project,
            delete_project,
            e2e_runner_catalog,
            project_category_catalog,
            discover_project_category,
            discover_e2e_runner,
            update_e2e_config,
            read_e2e_spec,
            save_e2e_spec,
            prepare_e2e_generation,
            run_e2e_suite,
            stop_e2e_run,
            update_live_command,
            run_live_command,
            stop_live_run,
            pipeline_template_for_stack,
            detect_remote_ci,
            get_pipeline_steps,
            save_pipeline_steps,
            run_project_pipeline,
            stop_pipeline_run,
            list_sessions,
            search_sessions,
            load_session,
            delete_session,
            duplicate_session,
            export_session,
            export_session_to_file,
            export_session_to_markdown,
            get_settings,
            save_settings_cmd,
            detect_claude,
            pick_directory,
            pick_file,
            copy_to_pragmadocs,
            save_session_attachments,
            file_exists,
            open_url,
            get_claude_usage,
            save_local_atom,
            trust_directory,
            get_trusted_dirs,
            remove_trusted_dir,
            check_output_style,
            create_scheduled_session,
            list_scheduled_sessions,
            cancel_scheduled_session,
            reschedule_scheduled_session,
            run_scheduled_session_now,
            list_todos,
            create_todo,
            set_todo_done,
            update_todo_text,
            delete_todo,
            clear_done_todos,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
