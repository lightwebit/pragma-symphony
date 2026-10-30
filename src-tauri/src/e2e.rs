use pragma_parser::storage::ProjectInfo;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------
// On-demand E2E run — outside the session cycle. Key rule: E2E is NEVER a gate.
// It does not block VERIFY, does not block REVIEW, does not block the development
// cycle: it is slow, depends on environment/data/a running app, and a flake
// must not stop anything. Outcomes are informational.
//
// The module covers three distinct things, deliberately kept separate:
//   1. the catalogue of runners per stack, with trust levels;
//   2. the one-off discovery that proposes runner + command by reading manifests;
//   3. running the command with a timeout, and summarising the output.
//
// *Generating* the scripts is not here: it goes through a real Pragma session
// (prompt prefilled by build_generation_prompt), because writing an E2E suite
// is development work and should be seen scrolling by, not done blind in a one-shot.
// ---------------------------------------------------------------------------

/// Directory of the E2E artefacts, in the root of the *target* project.
pub const AUTOTEST_DIR: &str = ".autoTest";

const MAX_CLASSIFIER_INPUT_CHARS: usize = 20_000;
const MAX_EVENT_OUTPUT_CHARS: usize = 8_000;
/// Ceiling beyond which an E2E run is killed. A stuck E2E suite (browser
/// that does not start, waiting for an environment never launched) would otherwise hang
/// with no remedy: the timeout is the difference between a red outcome and a blocked app.
pub const DEFAULT_TIMEOUT_SECS: u64 = 600;

/// Event on which the E2E run output streams, line by line. The `runId` that
/// accompanies each line is the project id: only one E2E run goes at a time.
pub const E2E_OUTPUT_EVENT: &str = "pragma:e2e-output";

// ---------------------------------------------------------------------------
// 1. Catalogo runner per stack
// ---------------------------------------------------------------------------

/// Declared trust level: `standard` = validated by direct experience and
/// proposed as default; `suggestion` = reasonable recommendation never validated
/// in the field, discovery proposes it but **the user decides**; `avoid` = tried and
/// does not work, kept in the catalogue only because it is the path the official
/// documentation points to and must be defused before someone loses a day on it.
/// The distinction must stay visible in the UI too: it is an explicit choice, not a
/// detail.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerEntry {
    pub id: &'static str,
    pub name: &'static str,
    pub stack: &'static str,
    pub confidence: &'static str,
    pub note: &'static str,
}

pub fn runner_catalog() -> Vec<RunnerEntry> {
    vec![
        RunnerEntry {
            id: "playwright",
            name: "Playwright",
            stack: "Web",
            confidence: "standard",
            note: "Solid and reliable from direct experience. Default for the web.",
        },
        RunnerEntry {
            id: "playwright-electron",
            name: "Playwright (Electron)",
            stack: "Electron",
            confidence: "standard",
            note: "Native Electron support, same Playwright base.",
        },
        RunnerEntry {
            id: "appium",
            name: "Appium · Maestro",
            stack: "Mobile",
            confidence: "suggestion",
            note: "Appium standardises the WebDriver protocol on mobile and desktop.",
        },
        RunnerEntry {
            id: "flaui",
            name: "FlaUI",
            stack: "Desktop WPF / WinForms",
            confidence: "suggestion",
            note: "UIA3 wrapper for .NET, active project.",
        },
        RunnerEntry {
            id: "assertj-swing",
            name: "AssertJ Swing",
            stack: "Desktop Java Swing",
            confidence: "suggestion",
            note: "",
        },
        RunnerEntry {
            id: "testfx",
            name: "TestFX",
            stack: "Desktop JavaFX",
            confidence: "suggestion",
            note: "",
        },
        RunnerEntry {
            id: "wdio-tauri-embedded",
            name: "WebdriverIO + @wdio/tauri-service (provider embedded)",
            stack: "Desktop Tauri",
            confidence: "standard",
            note: "Validated in the field: Pragma tests itself this way. The WebDriver server \
                   runs inside the app (tauri-plugin-wdio-webdriver, behind a Cargo feature, \
                   never in release) and talks to the webview's native APIs. Cross-platform, \
                   macOS included.",
        },
        RunnerEntry {
            id: "tauri-driver",
            name: "tauri-driver + msedgedriver (not recommended)",
            stack: "Desktop Tauri",
            confidence: "avoid",
            note: "Does not work on Windows: msedgedriver drives WebView2 via CDP and \
                   requires --remote-debugging-port, which current WebView2 runtimes \
                   ignore in any form (the WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS env var \
                   or additionalBrowserArgs compiled into the app). Every session dies with \
                   'DevToolsActivePort file doesn't exist'. No macOS support. \
                   Use the embedded provider.",
        },
        RunnerEntry {
            id: "appium-desktop",
            name: "Appium (Windows / Mac2 Driver)",
            stack: "Desktop Qt / native / other",
            confidence: "suggestion",
            note: "Goes through the operating system's accessibility tree (UIA, AT-SPI, AX).",
        },
        RunnerEntry {
            id: "image-based",
            name: "Image-based (e.g. SikuliX)",
            stack: "Any app — last resort",
            confidence: "suggestion",
            note: "Fragile by definition (themes, DPI, fonts). Not recommended if an alternative exists.",
        },
    ]
}

fn catalog_as_prompt_table() -> String {
    runner_catalog()
        .iter()
        .map(|r| {
            format!(
                "- id `{}` — {} — stack: {} — level: {}{}",
                r.id,
                r.name,
                r.stack,
                r.confidence,
                if r.note.is_empty() {
                    String::new()
                } else {
                    format!(" — {}", r.note)
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------------------------------------------------------------------------
// 2. .autoTest/ layout and artefact I/O
// ---------------------------------------------------------------------------

pub fn autotest_root(working_dir: &str) -> PathBuf {
    Path::new(working_dir).join(AUTOTEST_DIR)
}

fn spec_path(working_dir: &str) -> PathBuf {
    autotest_root(working_dir).join("SPEC.md")
}

/// `.gitignore` written inside `.autoTest/` on creation. `SPEC.md` and `scripts/`
/// are the suite and must be versioned; `runs/` is per-execution output — without this
/// file the target project accumulates an unversionable JSON on every E2E run.
const AUTOTEST_GITIGNORE: &str = "\
# Generated by Pragma Symphony. SPEC.md and scripts/ are the suite: version them.
# Only per-execution artefacts below.
runs/
";

/// Crea `.autoTest/` con le sottodirectory previste. Idempotente.
pub fn ensure_autotest_dirs(working_dir: &str) -> Result<PathBuf, String> {
    let root = autotest_root(working_dir);
    for sub in ["scripts", "prompts", "runs"] {
        std::fs::create_dir_all(root.join(sub))
            .map_err(|e| format!("creating {}/{}: {e}", AUTOTEST_DIR, sub))?;
    }
    // Only if missing: once written it belongs to the target project, and the user may
    // have edited it (e.g. to version the runs too).
    let gitignore = root.join(".gitignore");
    if !gitignore.exists() {
        std::fs::write(&gitignore, AUTOTEST_GITIGNORE)
            .map_err(|e| format!("creating {}/.gitignore: {e}", AUTOTEST_DIR))?;
    }
    Ok(root)
}

/// Scenario specifications in natural language. Empty string if they do not exist
/// yet — the absence of the file is not an error, it is the starting case.
pub fn read_spec(working_dir: &str) -> String {
    std::fs::read_to_string(spec_path(working_dir)).unwrap_or_default()
}

pub fn save_spec(working_dir: &str, text: &str) -> Result<String, String> {
    ensure_autotest_dirs(working_dir)?;
    let path = spec_path(working_dir);
    std::fs::write(&path, text).map_err(|e| format!("writing SPEC.md: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

fn timestamp_slug() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H-%M-%SZ").to_string()
}

/// Archives on disk the prompt actually used. It makes what was asked of the model
/// repeatable and inspectable: without it, the prompt lives only in the session
/// and vanishes.
pub fn write_prompt_artifact(working_dir: &str, kind: &str, body: &str) -> Result<String, String> {
    ensure_autotest_dirs(working_dir)?;
    let path = autotest_root(working_dir).join("prompts").join(format!(
        "{}-{}.md",
        timestamp_slug(),
        kind
    ));
    std::fs::write(&path, body).map_err(|e| format!("writing prompt: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// 3. Runner discovery (one-off, Sonnet)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eDiscovery {
    /// Id in the catalogue. May match no entry if the model proposes one
    /// outside the list: the UI shows it anyway, the user decides.
    pub runner_id: String,
    pub command: String,
    #[serde(default)]
    pub precondition: Option<String>,
    #[serde(default)]
    pub rationale: Option<String>,
    /// Stack rilevato dai manifest, a titolo informativo.
    #[serde(default)]
    pub detected_stack: Option<String>,
}

fn build_discovery_prompt() -> String {
    format!(
        "You are configuring end-to-end (E2E) testing for the project in the current working \
         directory. Inspect the manifests present (package.json, Cargo.toml, *.sln, *.csproj, \
         pyproject.toml, go.mod, pom.xml, build.gradle, tauri.conf.json…) to identify the stack.\n\n\
         Then pick the most appropriate E2E runner from this catalog:\n\n{}\n\n\
         Respond with ONLY a JSON object matching exactly this shape — no prose, no markdown \
         fences:\n\
         {{\"runnerId\": string, \"command\": string, \"precondition\": string, \
         \"rationale\": string, \"detectedStack\": string}}\n\n\
         Rules:\n\
         - \"runnerId\" must be an id from the catalog above when one fits the stack.\n\
         - Never pick an entry marked `avoid`: it has been tried and does not work. Its \
         note says what to use instead.\n\
         - \"command\" is the shell command that runs the E2E suite from the project root. If \
         the project has no E2E setup yet, propose the command it WOULD use once the suite \
         exists (e.g. `npx playwright test`) — it will be created in a later step.\n\
         - \"precondition\" describes what must already be running or available before the \
         command works (e.g. \"dev server on localhost:5173\", \"app binary built\"). Empty \
         string if there is no precondition.\n\
         - \"rationale\" is one or two sentences on why this runner fits this project.\n\
         - Report what you actually find. Do not invent a stack that is not there.",
        catalog_as_prompt_table()
    )
}

/// Runs discovery as an isolated Claude call (no interactive session,
/// no protocol markers). Default agent model = Sonnet: it is mechanical
/// reconnaissance of manifests, not judgement.
pub async fn discover(
    binary: &str,
    config_dir: Option<&str>,
    working_dir: &str,
) -> Result<E2eDiscovery, String> {
    let prompt = build_discovery_prompt();

    let mut cmd = tokio::process::Command::new(binary);
    cmd.args(["-p", &prompt, "--output-format", "json"])
        .current_dir(working_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    if let Some(dir) = config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("could not start discovery: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("discovery failed: {err}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_discovery(&stdout).ok_or_else(|| discovery_error_message(&stdout))
}

/// The earlier fallback did not say *what* the model had answered, only that it
/// could not be understood — useless for correcting by hand, and for telling
/// whether it is a rare case or a systematic one. The raw answer (or the whole envelope,
/// if even "result" cannot be read) helps judge.
fn discovery_error_message(stdout: &str) -> String {
    let snippet = serde_json::from_str::<serde_json::Value>(stdout.trim())
        .ok()
        .and_then(|v| v["result"].as_str().map(str::to_string))
        .unwrap_or_else(|| stdout.trim().to_string());
    format!(
        "discovery did not return a usable proposal — configure the command by \
         hand.\n\nThe model's answer:\n{}",
        crate::verify::cap(&snippet, 800)
    )
}

fn parse_discovery(claude_json_envelope: &str) -> Option<E2eDiscovery> {
    let envelope: serde_json::Value = serde_json::from_str(claude_json_envelope.trim()).ok()?;
    let result_text = envelope["result"].as_str()?;
    let cleaned = crate::verify::strip_markdown_fences(result_text);
    let mut d: E2eDiscovery = serde_json::from_str(&cleaned).ok()?;
    // An empty command would make the proposal unusable: better no
    // proposal than one the UI cannot start from.
    if d.command.trim().is_empty() {
        return None;
    }
    d.precondition = d.precondition.filter(|s| !s.trim().is_empty());
    d.rationale = d.rationale.filter(|s| !s.trim().is_empty());
    d.detected_stack = d.detected_stack.filter(|s| !s.trim().is_empty());
    Some(d)
}

// ---------------------------------------------------------------------------
// 4. Script generation prompt (goes into a real Pragma session)
// ---------------------------------------------------------------------------

pub fn build_generation_prompt(
    runner_name: &str,
    command: &str,
    spec: &str,
    precondition: Option<&str>,
) -> String {
    let mut p = String::new();
    p.push_str(&format!(
        "Write the end-to-end test suite of this project using {runner_name}.\n\n\
         Non-negotiable constraints:\n\
         - Everything you produce goes under `{AUTOTEST_DIR}/scripts/` in the project root: \
         runner configuration, test specs, helpers, fixtures. Do not scatter files elsewhere.\n\
         - The suite must be runnable with exactly this command from the root: \
         `{command}`. If the runner needs configuration for that command to work, \
         create it.\n\
         - Add the necessary dependencies to the project manifest if they are missing, but do not \
         update or reorganise unrelated dependencies.\n"
    ));

    if let Some(pre) = precondition.map(str::trim).filter(|s| !s.is_empty()) {
        p.push_str(&format!(
            "- Environment prerequisite declared for this project: {pre}. Assume it \
             is satisfied at run time; do not try to start it from the tests.\n"
        ));
    }

    p.push_str(
        "\nQuality rules:\n\
         - Cover the complete user flows described below, not implementation details.\n\
         - Stable selectors (roles, text, test ids), never fragile CSS hierarchies.\n\
         - No fixed-time sleeps: use the runner's explicit waits.\n\
         - Each test must be able to run alone and in any order.\n\n",
    );

    let spec = spec.trim();
    if spec.is_empty() {
        p.push_str(
            "--- SCENARIOS ---\n\
             No scenario specification has been written yet. Survey the project, \
             propose in ANALYSIS the user flows worth an E2E test and ask for confirmation \
             before writing the code.\n",
        );
    } else {
        p.push_str("--- SCENARIOS TO COVER ---\n");
        p.push_str(spec);
        p.push('\n');
    }

    p
}

// ---------------------------------------------------------------------------
// 5. Running
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eOutcome {
    pub passed: bool,
    pub failed_scenarios: Vec<String>,
    /// true when the outcome is not reliable (spawn failed, classification not
    /// interpretable, timeout). It blocks nothing — E2E is not a gate — but it does not
    /// pretend a green either.
    pub undetermined: bool,
    pub timed_out: bool,
    pub command: String,
    pub duration_ms: u64,
    pub raw_output: String,
    /// Path of the archived outcome file under `.autoTest/runs/`, if written.
    pub run_file: Option<String>,
}

impl E2eOutcome {
    fn failure(command: &str, note: String, duration_ms: u64, timed_out: bool) -> Self {
        Self {
            passed: false,
            failed_scenarios: vec![],
            undetermined: true,
            timed_out,
            command: command.to_string(),
            duration_ms,
            raw_output: note,
            run_file: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClassifiedE2e {
    passed: bool,
    #[serde(default)]
    failed_scenarios: Vec<String>,
}

fn build_classifier_prompt(raw_output: &str) -> String {
    let truncated = crate::verify::cap(raw_output, MAX_CLASSIFIER_INPUT_CHARS);
    format!(
        "You are classifying the raw output of an end-to-end test run. Respond with ONLY a JSON \
         object matching exactly this shape — no prose, no markdown fences:\n\
         {{\"passed\": boolean, \"failedScenarios\": string[]}}\n\
         \"passed\" is true only if the run completed with zero failing scenarios. \
         \"failedScenarios\" lists the failing test/scenario names you can find (best effort — \
         empty array if the format does not name them, but still set \"passed\" accurately). \
         Treat a run that crashed or never started as passed=false.\n\n\
         --- RAW OUTPUT ---\n{truncated}"
    )
}

async fn classify_output(
    binary: &str,
    config_dir: Option<&str>,
    raw_output: &str,
) -> Option<ClassifiedE2e> {
    let prompt = build_classifier_prompt(raw_output);

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
    serde_json::from_str::<ClassifiedE2e>(&crate::verify::strip_markdown_fences(result_text)).ok()
}

fn archive_run(working_dir: &str, outcome: &E2eOutcome) -> Option<String> {
    ensure_autotest_dirs(working_dir).ok()?;
    let path = autotest_root(working_dir)
        .join("runs")
        .join(format!("{}.json", timestamp_slug()));
    let body = serde_json::to_string_pretty(outcome).ok()?;
    std::fs::write(&path, body).ok()?;
    Some(path.to_string_lossy().into_owned())
}

/// Entry point of the E2E button. Emits `pragma:e2e` and archives the outcome under
/// `.autoTest/runs/`, from which the trend (durations included) comes for free.
pub async fn run_e2e(
    app: &AppHandle,
    project: &ProjectInfo,
    working_dir: &str,
    binary: &str,
    config_dir: Option<&str>,
    timeout_secs: u64,
    cancel: tokio::sync::oneshot::Receiver<()>,
) -> E2eOutcome {
    let Some(command) = project
        .e2e_command
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        let outcome = E2eOutcome::failure(
            "",
            "no E2E command configured for this project".to_string(),
            0,
            false,
        );
        let _ = app.emit("pragma:e2e", &outcome);
        return outcome;
    };

    let started = std::time::Instant::now();

    // The E2E run output streams into the UI while it runs: before, it was visible only
    // at the end, and a slow suite looked like a hung app. The emission lives
    // here and not in the executor — see the comment on `LineSink` in runner.rs.
    let emitter = app.clone();
    let run_id = project.id.clone();
    let spec = crate::runner::RunSpec {
        command,
        working_dir,
        mode: crate::runner::RunMode::OneShot { timeout_secs },
        on_line: Some(std::sync::Arc::new(move |l: crate::runner::RunLine| {
            let _ = emitter.emit(
                E2E_OUTPUT_EVENT,
                serde_json::json!({
                    "runId": run_id,
                    "line": l.line,
                    "stderr": l.stderr,
                }),
            );
        })),
    };

    let mut outcome = match crate::runner::run(spec, Some(cancel)).await {
        Err(spawn_err) => E2eOutcome::failure(
            command,
            spawn_err,
            started.elapsed().as_millis() as u64,
            false,
        ),
        Ok(run) if run.cancelled => E2eOutcome::failure(
            command,
            "run E2E interrotto dall'utente".to_string(),
            run.duration_ms,
            false,
        ),
        Ok(run) if run.timed_out => E2eOutcome::failure(
            command,
            format!("the E2E run exceeded the {timeout_secs}s ceiling and was stopped"),
            run.duration_ms,
            true,
        ),
        Ok(run) => match classify_output(binary, config_dir, &run.output).await {
            None => E2eOutcome {
                passed: false,
                failed_scenarios: vec![],
                undetermined: true,
                timed_out: false,
                command: command.to_string(),
                duration_ms: run.duration_ms,
                raw_output: crate::verify::cap(&run.output, MAX_EVENT_OUTPUT_CHARS),
                run_file: None,
            },
            Some(c) => E2eOutcome {
                passed: c.passed,
                failed_scenarios: c.failed_scenarios,
                undetermined: false,
                timed_out: false,
                command: command.to_string(),
                duration_ms: run.duration_ms,
                raw_output: crate::verify::cap(&run.output, MAX_EVENT_OUTPUT_CHARS),
                run_file: None,
            },
        },
    };

    outcome.run_file = archive_run(working_dir, &outcome);
    let _ = app.emit("pragma:e2e", &outcome);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("pragma_e2e_{label}_{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn scaffolding_ignores_run_artifacts_but_not_the_suite() {
        // `runs/` is per-execution output: without a .gitignore every E2E run leaves a
        // dirty JSON in the target project. SPEC.md and scripts/ are instead the suite
        // and must stay versionable.
        let tmp = temp_dir("gitignore");
        let working_dir = tmp.to_string_lossy().into_owned();
        ensure_autotest_dirs(&working_dir).unwrap();

        let body = std::fs::read_to_string(autotest_root(&working_dir).join(".gitignore")).unwrap();
        // Only the rule lines count: the comments name scripts/ and SPEC.md
        // precisely to say they must NOT be ignored.
        let rules: Vec<&str> = body
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .collect();
        assert_eq!(rules, vec!["runs/"]);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn scaffolding_never_clobbers_an_existing_gitignore() {
        // Once written the file belongs to the target project: if the user adapts it
        // (e.g. to version the runs too), the idempotent creation of the dirs
        // must not roll it back.
        let tmp = temp_dir("gitignore_keep");
        let working_dir = tmp.to_string_lossy().into_owned();
        ensure_autotest_dirs(&working_dir).unwrap();

        let path = autotest_root(&working_dir).join(".gitignore");
        std::fs::write(&path, "# mio\n").unwrap();
        ensure_autotest_dirs(&working_dir).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# mio\n");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn only_field_validated_runners_are_marked_standard() {
        // The only runners promoted to "standard" are those we have actually seen
        // run: Playwright on the web, and WebdriverIO with the embedded provider on Tauri
        // (Pragma tests itself this way). Everything else stays "suggestion" or, if
        // tried and failed, "avoid" — no silent promotion.
        const FIELD_VALIDATED: [&str; 3] =
            ["playwright", "playwright-electron", "wdio-tauri-embedded"];

        for entry in runner_catalog() {
            let expected_standard = FIELD_VALIDATED.contains(&entry.id);
            if expected_standard {
                assert_eq!(
                    entry.confidence, "standard",
                    "{} is field-validated and must stay standard",
                    entry.id
                );
            } else {
                assert!(
                    entry.confidence == "suggestion" || entry.confidence == "avoid",
                    "{} must not be promoted to standard without field validation",
                    entry.id
                );
            }
        }
    }

    #[test]
    fn tauri_driver_is_marked_as_a_dead_end() {
        // Deliberate regression test: the official Tauri documentation points to tauri-driver +
        // msedgedriver, which cannot work on Windows (WebView2 ignores
        // --remote-debugging-port). If someone promotes it again, this test says so.
        let catalog = runner_catalog();
        let dead_end = catalog.iter().find(|r| r.id == "tauri-driver").unwrap();
        assert_eq!(dead_end.confidence, "avoid");

        let embedded = catalog
            .iter()
            .find(|r| r.id == "wdio-tauri-embedded")
            .expect("the working alternative must stay in the catalogue");
        assert_eq!(embedded.confidence, "standard");
    }

    #[test]
    fn discovery_prompt_lists_every_runner_with_its_confidence() {
        let prompt = build_discovery_prompt();
        for entry in runner_catalog() {
            assert!(
                prompt.contains(entry.id),
                "{} is missing from the prompt",
                entry.id
            );
        }
        assert!(prompt.contains("standard"));
        assert!(prompt.contains("suggestion"));
    }

    #[test]
    fn parse_discovery_reads_a_well_formed_envelope() {
        let envelope = r#"{"result":"{\"runnerId\":\"playwright\",\"command\":\"npx playwright test\",\"precondition\":\"dev server on :5173\",\"rationale\":\"vite app\",\"detectedStack\":\"Vue 3 + Vite\"}"}"#;
        let d = parse_discovery(envelope).unwrap();
        assert_eq!(d.runner_id, "playwright");
        assert_eq!(d.command, "npx playwright test");
        assert_eq!(d.precondition.as_deref(), Some("dev server on :5173"));
        assert_eq!(d.detected_stack.as_deref(), Some("Vue 3 + Vite"));
    }

    #[test]
    fn parse_discovery_strips_markdown_fences() {
        let envelope = r#"{"result":"```json\n{\"runnerId\":\"playwright\",\"command\":\"npx playwright test\"}\n```"}"#;
        let d = parse_discovery(envelope).unwrap();
        assert_eq!(d.command, "npx playwright test");
        assert_eq!(d.precondition, None);
    }

    #[test]
    fn parse_discovery_rejects_an_empty_command() {
        // A proposal without a command is not usable: better to say "I did not understand"
        // than to hand the UI an empty line to execute.
        let envelope = r#"{"result":"{\"runnerId\":\"playwright\",\"command\":\"   \"}"}"#;
        assert!(parse_discovery(envelope).is_none());
    }

    #[test]
    fn parse_discovery_rejects_non_json_result() {
        let envelope = r#"{"result":"I could not determine the stack."}"#;
        assert!(parse_discovery(envelope).is_none());
    }

    #[test]
    fn discovery_error_surfaces_what_the_model_actually_said() {
        let envelope = r#"{"result":"I could not determine the stack."}"#;
        let msg = discovery_error_message(envelope);
        assert!(msg.contains("I could not determine the stack."));
    }

    #[test]
    fn discovery_error_falls_back_to_the_whole_envelope_if_result_is_unreadable() {
        let not_json = "connection refused";
        let msg = discovery_error_message(not_json);
        assert!(msg.contains("connection refused"));
    }

    #[test]
    fn generation_prompt_pins_scripts_to_autotest_and_the_run_command() {
        let p = build_generation_prompt(
            "Playwright",
            "npx playwright test",
            "The user opens Settings and changes the export dir.",
            Some("dev server on :5173"),
        );
        assert!(p.contains(".autoTest/scripts/"));
        assert!(p.contains("npx playwright test"));
        assert!(p.contains("dev server on :5173"));
        assert!(p.contains("The user opens Settings"));
    }

    #[test]
    fn generation_prompt_without_spec_asks_before_writing_code() {
        // Without scenarios the model must not invent a suite: it proposes first and asks.
        let p = build_generation_prompt("Playwright", "npx playwright test", "  \n ", None);
        assert!(p.contains("ANALYSIS"));
        assert!(p.contains("ask for confirmation"));
        assert!(!p.contains("Environment prerequisite"));
    }

    // The tests on timeout, manual stop and output capture now live in
    // runner.rs together with the executor that implements them — only the
    // E2E's own rules remain here (catalogue, discovery, prompt).

    #[test]
    fn archive_run_writes_the_outcome_under_runs() {
        let tmp = temp_dir("archive");
        let working_dir = tmp.to_string_lossy().into_owned();
        let outcome = E2eOutcome {
            passed: true,
            failed_scenarios: vec![],
            undetermined: false,
            timed_out: false,
            command: "npx playwright test".to_string(),
            duration_ms: 1234,
            raw_output: "2 passed".to_string(),
            run_file: None,
        };

        let path = archive_run(&working_dir, &outcome).expect("archive_run wrote nothing");
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("npx playwright test"));
        assert!(path.contains("runs"));

        std::fs::remove_dir_all(&tmp).ok();
    }
}
