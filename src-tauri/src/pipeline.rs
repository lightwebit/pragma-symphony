use crate::runner::{self, RunMode, RunSpec};
use pragma_parser::storage::{PipelineStep, ProjectInfo};
use serde::Serialize;

// ---------------------------------------------------------------------------
// Local pipeline.
//
// An ordered sequence of commands (build → test → publish) run locally
// before commit/push: no external provider, no credentials, no CI
// minutes. The remote-CI mode (triggering/monitoring a CI through its API) is out
// of scope.
//
// It is not a second executor: every step goes through runner.rs, exactly like
// VERIFY, E2E and Live. Only the *sequencing* logic lives here — fail-fast,
// aggregated outcome — which is the real additional code.
//
// The delicate point is the `verify` step: it delegates to verify::compute_verify, and so
// to the baseline of pre-existing failures. Without it, on a project with tests already red
// the pipeline would be permanently red and therefore useless — and there would be
// two different notions of "the tests pass", the divergence this design set out to avoid.
// ---------------------------------------------------------------------------

pub const PIPELINE_OUTPUT_EVENT: &str = "pragma:pipeline-output";

/// Ceiling per step. Generous: `npm install` or `dotnet publish` on a
/// big project take minutes, but a stuck step must not be able to keep the
/// pipeline blocked forever.
pub const DEFAULT_STEP_TIMEOUT_SECS: u64 = 900;

pub const KIND_VERIFY: &str = "verify";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepOutcome {
    pub id: String,
    pub label: String,
    pub kind: String,
    /// The command actually run. For a `verify` step it is the project's `test_command`,
    /// not the `command` column (ignored).
    pub command: String,
    pub passed: bool,
    pub skipped: bool,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub duration_ms: u64,
    pub output: String,
    /// Only for `verify` steps: the *new* failures compared with the baseline. A
    /// project with pre-existing reds stays green until it adds new ones.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub new_failures: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineOutcome {
    pub passed: bool,
    pub steps: Vec<StepOutcome>,
    pub duration_ms: u64,
    /// True if the sequence stopped before the end (fail-fast or manual
    /// stop): the following steps show up as `skipped`.
    pub stopped_early: bool,
}

// ---------------------------------------------------------------------------
// Catalogue of templates per stack
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepTemplate {
    pub label: String,
    pub command: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineTemplate {
    /// Substring searched in the project's stack (case-insensitive).
    pub stack_match: &'static str,
    pub steps: Vec<StepTemplate>,
}

fn step(label: &str, command: &str) -> StepTemplate {
    StepTemplate {
        label: label.to_string(),
        command: command.to_string(),
        kind: "command".to_string(),
    }
}

/// The test step is always `verify`, never an exit-code command: the command is
/// taken from the project and the outcome goes through the baseline. This is why the
/// pipeline is usable on a repo with pre-existing reds.
fn verify_step() -> StepTemplate {
    StepTemplate {
        label: "Test (VERIFY)".to_string(),
        command: String::new(),
        kind: KIND_VERIFY.to_string(),
    }
}

pub fn pipeline_templates() -> Vec<PipelineTemplate> {
    vec![
        PipelineTemplate {
            stack_match: "vue",
            steps: vec![
                step("Install", "npm install"),
                step("Build", "npm run build"),
                verify_step(),
            ],
        },
        PipelineTemplate {
            stack_match: ".net",
            steps: vec![
                step("Restore", "dotnet restore"),
                step("Build", "dotnet build"),
                verify_step(),
                step("Publish", "dotnet publish -c Release"),
            ],
        },
        PipelineTemplate {
            stack_match: "rust",
            steps: vec![
                step("Build", "cargo build"),
                verify_step(),
                step("Clippy", "cargo clippy --workspace -- -D warnings"),
            ],
        },
        PipelineTemplate {
            stack_match: "python",
            steps: vec![
                step("Install", "pip install -r requirements.txt"),
                verify_step(),
            ],
        },
    ]
}

/// Template proposed for a project's stack. `None` when the stack is empty
/// or outside the catalogue — a legitimate case: the steps are written
/// by hand, no invented default.
pub fn template_for_stack(stack: Option<&str>) -> Option<Vec<StepTemplate>> {
    let stack = stack?.to_lowercase();
    pipeline_templates()
        .into_iter()
        .find(|t| stack.contains(t.stack_match))
        .map(|t| t.steps)
}

// ---------------------------------------------------------------------------
// Passive detection of an existing remote CI
//
// File reads only — no API calls, no token, neither of the two
// things a remote-CI mode would require. It only prevents the user from not
// noticing that the repo already has a GitHub Actions or Azure DevOps pipeline: an
// informational flag, not a feature that manages that CI. The behaviour
// "if there is a remote CI, the local pipeline does not publish" is deferred until
// a publish step really exists — today the pipeline does not
// deploy anyway, so the rule would have nothing to protect.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCiDetection {
    pub github_actions: bool,
    pub azure_pipelines: bool,
}

/// Is there a `.github/workflows/` with at least one `.yml`/`.yaml` file, or an
/// `azure-pipelines.yml` at the root? An empty `.github/workflows/` directory
/// (created but with no workflow in it) does not count: it is not CI, it is a folder.
pub fn detect_remote_ci(working_dir: &str) -> RemoteCiDetection {
    let base = std::path::Path::new(working_dir);

    let github_actions = std::fs::read_dir(base.join(".github").join("workflows"))
        .map(|entries| {
            entries.filter_map(Result::ok).any(|entry| {
                matches!(
                    entry.path().extension().and_then(|e| e.to_str()),
                    Some("yml") | Some("yaml")
                )
            })
        })
        .unwrap_or(false);

    let azure_pipelines = base.join("azure-pipelines.yml").is_file();

    RemoteCiDetection {
        github_actions,
        azure_pipelines,
    }
}

// ---------------------------------------------------------------------------
// Esecuzione
// ---------------------------------------------------------------------------

fn skipped_outcome(step: &PipelineStep) -> StepOutcome {
    StepOutcome {
        id: step.id.clone(),
        label: step.label.clone(),
        kind: step.kind.clone(),
        command: step.command.clone(),
        passed: false,
        skipped: true,
        exit_code: None,
        timed_out: false,
        cancelled: false,
        duration_ms: 0,
        output: String::new(),
        new_failures: vec![],
    }
}

/// Runs the project's pipeline, fail-fast.
///
/// Like `live.rs` and `runner.rs`: no `AppHandle`. `on_line` receives each step's
/// lines together with the step index, so the UI knows which box to write
/// them in; the caller decides whether and how to emit them.
#[allow(clippy::too_many_arguments)]
pub async fn run_pipeline(
    project: &ProjectInfo,
    working_dir: &str,
    steps: &[PipelineStep],
    binary: &str,
    config_dir: Option<&str>,
    step_timeout_secs: u64,
    mut cancel: Option<tokio::sync::oneshot::Receiver<()>>,
    on_line: Option<std::sync::Arc<dyn Fn(usize, runner::RunLine) + Send + Sync>>,
) -> PipelineOutcome {
    let started = std::time::Instant::now();
    let mut outcomes: Vec<StepOutcome> = Vec::new();
    let mut stopped_early = false;

    let active: Vec<&PipelineStep> = steps.iter().filter(|s| s.enabled).collect();

    for (index, step) in active.iter().enumerate() {
        if stopped_early {
            outcomes.push(skipped_outcome(step));
            continue;
        }

        let outcome = if step.kind == KIND_VERIFY {
            run_verify_step(step, project, working_dir, binary, config_dir).await
        } else {
            let sink = on_line.clone().map(|f| {
                let f = f.clone();
                std::sync::Arc::new(move |line: runner::RunLine| f(index, line)) as runner::LineSink
            });
            run_command_step(step, working_dir, step_timeout_secs, &mut cancel, sink).await
        };

        let failed = !outcome.passed;
        outcomes.push(outcome);
        // Fail-fast: at the first red the rest does not run. On a local pre-commit
        // pipeline continuing would give no extra information — the following steps
        // would start from a state that does not compile or does not pass anyway.
        if failed {
            stopped_early = true;
        }
    }

    PipelineOutcome {
        passed: outcomes.iter().all(|o| o.passed),
        steps: outcomes,
        duration_ms: started.elapsed().as_millis() as u64,
        stopped_early,
    }
}

async fn run_command_step(
    step: &PipelineStep,
    working_dir: &str,
    timeout_secs: u64,
    cancel: &mut Option<tokio::sync::oneshot::Receiver<()>>,
    on_line: Option<runner::LineSink>,
) -> StepOutcome {
    // The stop channel is one for the whole pipeline: the first step that runs consumes
    // it, and if it fires there the sequence stops. The following steps no longer have
    // one — but they do not need one, because they will not start.
    let step_cancel = cancel.take();

    let spec = RunSpec {
        command: &step.command,
        working_dir,
        mode: RunMode::OneShot { timeout_secs },
        on_line,
    };

    match runner::run(spec, step_cancel).await {
        Err(spawn_err) => StepOutcome {
            id: step.id.clone(),
            label: step.label.clone(),
            kind: step.kind.clone(),
            command: step.command.clone(),
            passed: false,
            skipped: false,
            exit_code: None,
            timed_out: false,
            cancelled: false,
            duration_ms: 0,
            output: spawn_err,
            new_failures: vec![],
        },
        Ok(run) => StepOutcome {
            id: step.id.clone(),
            label: step.label.clone(),
            kind: step.kind.clone(),
            command: step.command.clone(),
            passed: run.success(),
            skipped: false,
            exit_code: run.exit_code,
            timed_out: run.timed_out,
            cancelled: run.cancelled,
            duration_ms: run.duration_ms,
            output: run.output,
            new_failures: vec![],
        },
    }
}

async fn run_verify_step(
    step: &PipelineStep,
    project: &ProjectInfo,
    working_dir: &str,
    binary: &str,
    config_dir: Option<&str>,
) -> StepOutcome {
    let started = std::time::Instant::now();
    let verify = crate::verify::compute_verify(project, working_dir, binary, config_dir).await;

    StepOutcome {
        id: step.id.clone(),
        label: step.label.clone(),
        kind: step.kind.clone(),
        command: project.test_command.clone().unwrap_or_default(),
        // Same rule as the session gate: only *new* failures block. An
        // indeterminate outcome is not a green but is not an invented red either —
        // VerifyOutcome's `passed` already accounts for it.
        passed: verify.passed,
        skipped: false,
        exit_code: None,
        timed_out: false,
        cancelled: false,
        duration_ms: started.elapsed().as_millis() as u64,
        output: verify.raw_test_output.clone(),
        new_failures: verify.new_failures.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> ProjectInfo {
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
            live_command: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            session_count: 0,
        }
    }

    fn cmd_step(id: &str, label: &str, command: &str) -> PipelineStep {
        PipelineStep {
            id: id.into(),
            label: label.into(),
            command: command.into(),
            kind: "command".into(),
            enabled: true,
        }
    }

    #[tokio::test]
    async fn runs_every_step_in_order_when_all_pass() {
        let steps = vec![
            cmd_step("1", "One", "echo one"),
            cmd_step("2", "Two", "echo due"),
        ];
        let outcome = run_pipeline(&project(), ".", &steps, "claude", None, 30, None, None).await;

        assert!(outcome.passed);
        assert!(!outcome.stopped_early);
        assert_eq!(outcome.steps.len(), 2);
        assert!(outcome.steps[0].output.contains("one"));
        assert!(outcome.steps[1].output.contains("due"));
    }

    #[tokio::test]
    async fn fail_fast_skips_the_remaining_steps() {
        // The second step fails: the third must not run, but must still
        // appear in the outcome as `skipped` — a pipeline that hides the steps
        // not executed cannot be understood.
        let steps = vec![
            cmd_step("1", "One", "echo one"),
            cmd_step("2", "Boom", "exit 1"),
            cmd_step("3", "Three", "echo tre"),
        ];
        let outcome = run_pipeline(&project(), ".", &steps, "claude", None, 30, None, None).await;

        assert!(!outcome.passed);
        assert!(outcome.stopped_early);
        assert!(outcome.steps[0].passed);
        assert!(!outcome.steps[1].passed);
        assert_eq!(outcome.steps[1].exit_code, Some(1));
        assert!(outcome.steps[2].skipped, "the third step must not run");
        assert!(
            !outcome.steps[2].output.contains("tre"),
            "a skipped step must have no output"
        );
    }

    #[tokio::test]
    async fn disabled_steps_never_run() {
        let mut disabled = cmd_step("2", "Skipped", "exit 1");
        disabled.enabled = false;
        let steps = vec![cmd_step("1", "One", "echo one"), disabled];

        let outcome = run_pipeline(&project(), ".", &steps, "claude", None, 30, None, None).await;

        // A disabled step is excluded entirely: if it were only "skipped"
        // it would make the pipeline fail despite having been switched off on purpose.
        assert!(outcome.passed);
        assert_eq!(outcome.steps.len(), 1);
    }

    #[tokio::test]
    async fn streams_lines_tagged_with_their_step_index() {
        use std::sync::{Arc, Mutex};
        let seen: Arc<Mutex<Vec<(usize, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);

        let steps = vec![
            cmd_step("1", "One", "echo line-a"),
            cmd_step("2", "Two", "echo line-b"),
        ];
        run_pipeline(
            &project(),
            ".",
            &steps,
            "claude",
            None,
            30,
            None,
            Some(Arc::new(move |i, l: runner::RunLine| {
                sink.lock().unwrap().push((i, l.line));
            })),
        )
        .await;

        let lines = seen.lock().unwrap().clone();
        // Without the index the UI would not know which box to write in: this is
        // why the pipeline's sink is not a normal LineSink.
        assert!(lines.iter().any(|(i, l)| *i == 0 && l.contains("line-a")));
        assert!(lines.iter().any(|(i, l)| *i == 1 && l.contains("line-b")));
    }

    #[tokio::test]
    async fn a_verify_step_without_test_command_passes_without_running_anything() {
        // No test_command configured = nothing to verify: compute_verify
        // returns passed without running anything, and the pipeline must not turn it
        // into a red.
        let steps = vec![PipelineStep {
            id: "v".into(),
            label: "Test".into(),
            command: "ignorato".into(),
            kind: KIND_VERIFY.into(),
            enabled: true,
        }];
        let outcome = run_pipeline(&project(), ".", &steps, "claude", None, 30, None, None).await;

        assert!(outcome.passed);
        assert_eq!(outcome.steps[0].kind, KIND_VERIFY);
    }

    #[test]
    fn template_matches_a_stack_case_insensitively() {
        let steps = template_for_stack(Some("Rust/Tauri + CI/CD")).unwrap();
        assert!(steps.iter().any(|s| s.command == "cargo build"));
    }

    #[test]
    fn every_template_routes_tests_through_verify_not_a_bare_command() {
        // Deliberate regression test: if someone replaced the verify step with an
        // exit-code `npm test`, the pipeline would be red forever on
        // projects with pre-existing failures — the reason KIND_VERIFY exists.
        for template in pipeline_templates() {
            let has_verify = template.steps.iter().any(|s| s.kind == KIND_VERIFY);
            assert!(
                has_verify,
                "the template for `{}` must go through VERIFY for the tests",
                template.stack_match
            );
        }
    }

    #[test]
    fn an_unknown_stack_gets_no_template() {
        // Bypassable constraint: outside the catalogue nothing is invented.
        assert!(template_for_stack(Some("Kotlin + Ktor")).is_none());
        assert!(template_for_stack(None).is_none());
    }

    fn temp_dir(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("pragma_pipeline_{label}_{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn detects_github_actions_workflow() {
        let tmp = temp_dir("gh");
        let workflows = tmp.join(".github").join("workflows");
        std::fs::create_dir_all(&workflows).unwrap();
        std::fs::write(workflows.join("ci.yml"), "name: ci").unwrap();

        let detection = detect_remote_ci(tmp.to_str().unwrap());
        assert!(detection.github_actions);
        assert!(!detection.azure_pipelines);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn an_empty_workflows_directory_does_not_count_as_ci() {
        // Created but with no files in it: an empty folder, not a pipeline.
        let tmp = temp_dir("gh_empty");
        std::fs::create_dir_all(tmp.join(".github").join("workflows")).unwrap();

        assert!(!detect_remote_ci(tmp.to_str().unwrap()).github_actions);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn detects_azure_pipelines_file() {
        let tmp = temp_dir("azure");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("azure-pipelines.yml"), "trigger: main").unwrap();

        let detection = detect_remote_ci(tmp.to_str().unwrap());
        assert!(!detection.github_actions);
        assert!(detection.azure_pipelines);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn no_ci_config_detects_nothing() {
        let tmp = temp_dir("none");
        std::fs::create_dir_all(&tmp).unwrap();

        let detection = detect_remote_ci(tmp.to_str().unwrap());
        assert!(!detection.github_actions);
        assert!(!detection.azure_pipelines);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_nonexistent_working_dir_detects_nothing_rather_than_erroring() {
        // The popup may open before the user has chosen a valid working dir:
        // it must not panic, just say "no CI found".
        let detection = detect_remote_ci("Z:\\__pragma_dir_che_non_esiste__");
        assert!(!detection.github_actions);
        assert!(!detection.azure_pipelines);
    }
}
