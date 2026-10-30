use crate::runner::{self, RunMode, RunOutcome, RunSpec};
use pragma_parser::storage::ProjectInfo;

// ---------------------------------------------------------------------------
// On-demand "Live" button — build/start of the project command, with an
// output panel.
//
// Much thinner than e2e.rs: no catalogue, no discovery, no classification
// of the outcome — the command is chosen by the user (proposed from the
// category→stack in the form, or by hand), and the outcome is the exit code, not a
// pass/fail judged by a model. All the real execution lives in runner.rs;
// this module only chooses one-shot vs unbounded and passes the command.
//
// The long-running/one-shot distinction is NOT automatic
// in v1: the user declares it in the UI, not a stack classifier — that
// stays a "later phase".
// ---------------------------------------------------------------------------

/// Event on which the live command output streams, line by line. Same scheme
/// as E2E_OUTPUT_EVENT in e2e.rs (`runId`/`line`/`stderr`) — see `runner::LineSink`.
pub const LIVE_OUTPUT_EVENT: &str = "pragma:live-output";

/// Default duration ceiling for a one-shot run (build/publish). It does not apply
/// at all when `unbounded` is true: a dev server has no ceiling, only the manual
/// stop.
pub const DEFAULT_TIMEOUT_SECS: u64 = 600;

/// Runs the project's live command.
///
/// No `AppHandle` here on purpose — see the note in `runner.rs`: a module
/// that takes one becomes dependent on the webview and a test that touches it stops
/// loading the binary (`STATUS_ENTRYPOINT_NOT_FOUND`). The caller builds the
/// `LineSink` if it wants streaming in the UI; here there is only the execution.
pub async fn run_live(
    project: &ProjectInfo,
    working_dir: &str,
    unbounded: bool,
    timeout_secs: u64,
    on_line: Option<runner::LineSink>,
    cancel: Option<tokio::sync::oneshot::Receiver<()>>,
) -> Result<RunOutcome, String> {
    let command = project
        .live_command
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "no live command configured for this project".to_string())?;

    let mode = if unbounded {
        RunMode::Unbounded
    } else {
        RunMode::OneShot { timeout_secs }
    };

    let spec = RunSpec {
        command,
        working_dir,
        mode,
        on_line,
    };

    runner::run(spec, cancel).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project_with_live_command(cmd: Option<&str>) -> ProjectInfo {
        ProjectInfo {
            id: "p1".into(),
            title: "P".into(),
            slug: "p".into(),
            description: None,
            working_dir: None,
            color: None,
            test_command: None,
            lint_command: None,
            coverage_command: None,
            verify_baseline: None,
            review_invariants: None,
            e2e_command: None,
            e2e_precondition: None,
            e2e_runner: None,
            sensitive_paths: None,
            project_category: None,
            project_stack: None,
            live_command: cmd.map(str::to_string),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            session_count: 0,
        }
    }

    fn never_ending_command() -> &'static str {
        if cfg!(windows) {
            "for /l %i in (0,0,1) do @rem"
        } else {
            "while true; do :; done"
        }
    }

    #[tokio::test]
    async fn errors_without_a_configured_command() {
        let project = project_with_live_command(None);
        let result = run_live(&project, ".", false, 30, None, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn errors_when_the_command_is_only_whitespace() {
        // Same treatment as e2e_command: a blank is not a configured command.
        let project = project_with_live_command(Some("   "));
        let result = run_live(&project, ".", false, 30, None, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn runs_the_configured_command_one_shot() {
        let project = project_with_live_command(Some("echo pragma-live-ok"));
        let outcome = run_live(&project, ".", false, 30, None, None)
            .await
            .unwrap();
        assert!(outcome.output.contains("pragma-live-ok"));
        assert_eq!(outcome.exit_code, Some(0));
        assert!(!outcome.timed_out);
    }

    #[tokio::test]
    async fn unbounded_ignores_the_timeout_and_only_stops_on_cancel() {
        // The only logic of this module is the one-shot/unbounded choice — the rest
        // is done by runner::run. With unbounded=true, a tiny timeout_secs (1s) must
        // not interrupt anything: the command must stay alive until the explicit
        // cancel arrives.
        let project = project_with_live_command(Some(never_ending_command()));
        let (tx, rx) = tokio::sync::oneshot::channel();
        let handle =
            tokio::spawn(async move { run_live(&project, ".", true, 1, None, Some(rx)).await });
        tokio::time::sleep(std::time::Duration::from_millis(1300)).await;
        let _ = tx.send(());

        let outcome = handle.await.unwrap().unwrap();
        assert!(outcome.cancelled, "the explicit cancel must stop it");
        assert!(
            !outcome.timed_out,
            "unbounded=true must not apply timeout_secs"
        );
    }
}
