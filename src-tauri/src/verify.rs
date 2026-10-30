use crate::events::emit_session;
use pragma_parser::storage::{update_verify_baseline, ProjectInfo};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::AppHandle;

// ---------------------------------------------------------------------------
// VERIFY phase — deterministic execution of the project's tests/lint after the REPORT,
// with a baseline of pre-existing failures (only *new* failures block the gate).
// It is not part of the pragma protocol (no marker in protocol.rs): the outcome
// comes from a real subprocess + a one-shot classification, not from text
// written by the development session.
// ---------------------------------------------------------------------------

const MAX_CLASSIFIER_INPUT_CHARS: usize = 20_000;
const MAX_EVENT_OUTPUT_CHARS: usize = 4_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyOutcome {
    pub passed: bool,
    pub new_failures: Vec<String>,
    pub healed: Vec<String>,
    pub preexisting: Vec<String>,
    pub lint_output: Option<String>,
    /// true if running or classifying the tests did not produce a
    /// reliable result — it does not block but does not pretend a green either.
    pub undetermined: bool,
    pub raw_test_output: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClassifiedResult {
    passed: bool,
    #[serde(default)]
    failed_tests: Vec<String>,
}

pub(crate) fn cap(s: &str, limit: usize) -> String {
    if s.chars().count() <= limit {
        return s.to_string();
    }
    let truncated: String = s.chars().take(limit).collect();
    format!("{truncated}\n… (output troncato)")
}

// ---------------------------------------------------------------------------
// Shell execution of the project command — delegated to the single executor
// ---------------------------------------------------------------------------

/// `RunMode::Unbounded` and not a timeout: VERIFY never had one, and
/// introducing it here would change the gate's behaviour inside a refactor.
/// The known defect remains — a stuck test suite keeps VERIFY hanging with no
/// remedy — to be tackled as an explicit choice, not on the side.
///
/// No `on_line`: VERIFY never showed output while running, and turning it on
/// here would mean designing where to show it.
async fn run_shell_command(working_dir: &str, command: &str) -> Result<String, String> {
    let spec = crate::runner::RunSpec {
        command,
        working_dir,
        mode: crate::runner::RunMode::Unbounded,
        on_line: None,
    };
    crate::runner::run(spec, None).await.map(|r| r.output)
}

// ---------------------------------------------------------------------------
// One-shot classification of the raw output — isolated Claude call,
// no protocol markers, no interactive session. The agent's default
// model (Sonnet) — no --model passed on purpose.
// ---------------------------------------------------------------------------

pub(crate) fn strip_markdown_fences(text: &str) -> String {
    let t = text.trim();
    let t = t
        .strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))
        .unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t);
    t.trim().to_string()
}

async fn classify_output(
    binary: &str,
    config_dir: Option<&str>,
    raw_output: &str,
) -> Option<ClassifiedResult> {
    let truncated = cap(raw_output, MAX_CLASSIFIER_INPUT_CHARS);
    let prompt = format!(
        "You are classifying the raw output of a test suite run. Respond with ONLY a JSON \
         object matching exactly this shape — no prose, no markdown fences:\n\
         {{\"passed\": boolean, \"failedTests\": string[]}}\n\
         \"passed\" is true only if the suite ran with zero failing tests. \"failedTests\" is \
         the list of individual failing test names/identifiers you can find in the output \
         (best effort — if the format doesn't name individual tests, return an empty array and \
         still set \"passed\" accurately based on the overall result).\n\n\
         --- RAW OUTPUT ---\n{truncated}"
    );

    let mut cmd = tokio::process::Command::new(binary);
    cmd.args(["-p", &prompt, "--output-format", "json"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    if let Some(dir) = config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }

    let output = cmd.output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let envelope: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
    let result_text = envelope["result"].as_str()?;
    let cleaned = strip_markdown_fences(result_text);
    serde_json::from_str::<ClassifiedResult>(&cleaned).ok()
}

// ---------------------------------------------------------------------------
// Baseline diff — pure function, testable without a subprocess.
// ---------------------------------------------------------------------------

pub struct BaselineDiff {
    pub passed: bool,
    pub new_failures: Vec<String>,
    pub healed: Vec<String>,
    pub preexisting: Vec<String>,
    /// Some(...) when the saved baseline must be updated (first activation or
    /// reduction because tests were fixed) — None when it stays unchanged.
    pub next_baseline: Option<Vec<String>>,
}

pub fn evaluate_baseline(baseline: Option<&[String]>, current_failed: &[String]) -> BaselineDiff {
    match baseline {
        None => BaselineDiff {
            passed: true,
            new_failures: vec![],
            healed: vec![],
            preexisting: current_failed.to_vec(),
            next_baseline: Some(current_failed.to_vec()),
        },
        Some(base) => {
            let base_set: HashSet<&String> = base.iter().collect();
            let current_set: HashSet<&String> = current_failed.iter().collect();

            let new_failures: Vec<String> = current_failed
                .iter()
                .filter(|t| !base_set.contains(t))
                .cloned()
                .collect();
            let healed: Vec<String> = base
                .iter()
                .filter(|t| !current_set.contains(t))
                .cloned()
                .collect();
            let preexisting: Vec<String> = current_failed
                .iter()
                .filter(|t| base_set.contains(t))
                .cloned()
                .collect();

            let next_baseline = if healed.is_empty() {
                None
            } else {
                Some(
                    base.iter()
                        .filter(|t| current_set.contains(t))
                        .cloned()
                        .collect(),
                )
            };

            BaselineDiff {
                passed: new_failures.is_empty(),
                new_failures,
                healed,
                preexisting,
                next_baseline,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Orchestration — run by run_pragma after a REPORT (see lib.rs)
// ---------------------------------------------------------------------------

/// Computes the VERIFY outcome without emitting anything.
///
/// Separate from `run_verify` because the local pipeline (pipeline.rs) must be able to
/// include VERIFY as a step without inventing a second baseline logic —
/// which is exactly the divergence the design set out to avoid. No
/// `AppHandle` here, for the same reason as `runner.rs`: whoever computes must not
/// depend on the webview.
pub async fn compute_verify(
    project: &ProjectInfo,
    working_dir: &str,
    binary: &str,
    config_dir: Option<&str>,
) -> VerifyOutcome {
    let Some(test_command) = project
        .test_command
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    else {
        // No test command configured: nothing to verify, no event emitted.
        return VerifyOutcome {
            passed: true,
            new_failures: vec![],
            healed: vec![],
            preexisting: vec![],
            lint_output: None,
            undetermined: false,
            raw_test_output: String::new(),
        };
    };

    let mut outcome = match run_shell_command(working_dir, test_command).await {
        Err(spawn_err) => VerifyOutcome {
            passed: false,
            new_failures: vec![],
            healed: vec![],
            preexisting: vec![],
            lint_output: None,
            undetermined: true,
            raw_test_output: spawn_err,
        },
        Ok(raw_test_output) => match classify_output(binary, config_dir, &raw_test_output).await {
            None => VerifyOutcome {
                passed: false,
                new_failures: vec![],
                healed: vec![],
                preexisting: vec![],
                lint_output: None,
                undetermined: true,
                raw_test_output: cap(&raw_test_output, MAX_EVENT_OUTPUT_CHARS),
            },
            Some(classified) => {
                // A suite that fails without naming individual tests (crash, broken setup,
                // etc.) still goes into the baseline as a sentinel entry — otherwise
                // "passed: false, failedTests: []" would seed an empty baseline and
                // look green on the next run.
                let failed_tests = if !classified.passed && classified.failed_tests.is_empty() {
                    vec!["<suite failed — see raw output>".to_string()]
                } else {
                    classified.failed_tests
                };
                let stored_baseline: Option<Vec<String>> = project
                    .verify_baseline
                    .as_deref()
                    .and_then(|j| serde_json::from_str(j).ok());
                let diff = evaluate_baseline(stored_baseline.as_deref(), &failed_tests);
                if let Some(next) = &diff.next_baseline {
                    if let Ok(json) = serde_json::to_string(next) {
                        let _ = update_verify_baseline(&project.id, &json);
                    }
                }
                VerifyOutcome {
                    passed: diff.passed,
                    new_failures: diff.new_failures,
                    healed: diff.healed,
                    preexisting: diff.preexisting,
                    lint_output: None,
                    undetermined: false,
                    raw_test_output: cap(&raw_test_output, MAX_EVENT_OUTPUT_CHARS),
                }
            }
        },
    };

    if let Some(lint_cmd) = project
        .lint_command
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        outcome.lint_output = Some(match run_shell_command(working_dir, lint_cmd).await {
            Ok(raw) => cap(&raw, MAX_EVENT_OUTPUT_CHARS),
            Err(e) => e,
        });
    }

    outcome
}

/// VERIFY in the session cycle: computes and notifies the UI. The pipeline instead uses
/// `compute_verify` directly — same computation, same baseline, one event
/// fewer (the outcome there is part of the pipeline's aggregate).
pub async fn run_verify(
    app: &AppHandle,
    session_id: &str,
    project: &ProjectInfo,
    working_dir: &str,
    binary: &str,
    config_dir: Option<&str>,
) -> VerifyOutcome {
    let outcome = compute_verify(project, working_dir, binary, config_dir).await;
    emit_session(app, "pragma:verify", session_id, &outcome);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_activation_seeds_baseline_and_passes() {
        let diff = evaluate_baseline(None, &["test_a".to_string(), "test_b".to_string()]);
        assert!(diff.passed);
        assert!(diff.new_failures.is_empty());
        assert_eq!(diff.preexisting, vec!["test_a", "test_b"]);
        assert_eq!(
            diff.next_baseline,
            Some(vec!["test_a".to_string(), "test_b".to_string()])
        );
    }

    #[test]
    fn new_failure_outside_baseline_blocks() {
        let baseline = vec!["test_a".to_string()];
        let current = vec!["test_a".to_string(), "test_c".to_string()];
        let diff = evaluate_baseline(Some(&baseline), &current);
        assert!(!diff.passed);
        assert_eq!(diff.new_failures, vec!["test_c"]);
        assert_eq!(diff.preexisting, vec!["test_a"]);
        assert!(diff.healed.is_empty());
        assert_eq!(diff.next_baseline, None);
    }

    #[test]
    fn healed_test_shrinks_baseline() {
        let baseline = vec!["test_a".to_string(), "test_b".to_string()];
        let current = vec!["test_a".to_string()];
        let diff = evaluate_baseline(Some(&baseline), &current);
        assert!(diff.passed, "no new failure, only one fixed");
        assert_eq!(diff.healed, vec!["test_b"]);
        assert_eq!(diff.next_baseline, Some(vec!["test_a".to_string()]));
    }

    #[test]
    fn no_new_no_healed_baseline_untouched() {
        let baseline = vec!["test_a".to_string()];
        let current = vec!["test_a".to_string()];
        let diff = evaluate_baseline(Some(&baseline), &current);
        assert!(diff.passed);
        assert!(diff.new_failures.is_empty());
        assert!(diff.healed.is_empty());
        assert_eq!(diff.next_baseline, None);
    }

    #[test]
    fn strip_fences_removes_json_markdown_wrapper() {
        let wrapped = "```json\n{\"passed\": true}\n```";
        assert_eq!(strip_markdown_fences(wrapped), "{\"passed\": true}");
    }
}
