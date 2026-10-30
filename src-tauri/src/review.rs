use crate::events::emit_session;
use pragma_parser::storage::ProjectInfo;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

// ---------------------------------------------------------------------------
// REVIEW phase — after VERIFY, Pragma opens a *separate* Claude session (new process,
// no context shared with development: that is the point) on the full diff
// of the session, with the project's invariants if configured.
// As with VERIFY, the orchestration is Rust's and the outcome arrives as a direct
// Tauri event (`pragma:review`), not through the protocol.rs markers: the text is not
// written by the development session.
// ---------------------------------------------------------------------------

/// Beyond this threshold the diff is truncated: a review of a huge diff is
/// unreliable anyway — it is the case for the DEEP REVIEW.
const MAX_DIFF_CHARS: usize = 60_000;

/// Initial thresholds for the DEEP REVIEW banner — a starting value, not yet
/// validated on real use. Exceeding one is enough: a diff with few files but
/// hundreds of lines is a candidate all the same.
const DEEP_REVIEW_FILES_THRESHOLD: usize = 10;
const DEEP_REVIEW_LINES_THRESHOLD: usize = 400;

/// Default patterns for the security hand-off, used when the project has not declared
/// `sensitive_paths`. They recognise by name the surfaces usually considered sensitive
/// (auth, dynamic queries/commands, filesystem, secrets) in the most common languages —
/// Pragma does not know the stack, so here we are deliberately broad:
/// a false positive costs one extra hand-off in the same prompt, a false
/// negative costs a surface left unwatched.
///
/// They do not replace `sensitive_paths`: as soon as the project configures it,
/// that one wins (the user knows where their surfaces are better than this list).
const DEFAULT_SENSITIVE_PATTERNS: &[&str] = &[
    "**/auth/**",
    "**/*auth*",
    "**/*login*",
    "**/*session*",
    "**/*token*",
    "**/*password*",
    "**/*credential*",
    "**/*secret*",
    "**/*crypt*",
    "**/*permission*",
    "**/*sql*",
    "**/*query*",
    "**/*.sql",
    "**/migrations/**",
    "**/*upload*",
    "**/*exec*",
    "**/*spawn*",
    "**/*shell*",
    "**/*process*",
    "**/.env*",
    "**/*config*",
];

/// Counts files and lines changed in a unified diff (standard `git diff`).
/// A heuristic for the DEEP REVIEW banner — no surgical precision needed, only
/// a "this diff is big" signal. The `+++`/`---` lines (file headers) are
/// excluded from the line count so as not to inflate it by one per file.
fn diff_stats(diff: &str) -> (usize, usize) {
    let files_changed = diff
        .lines()
        .filter(|l| l.starts_with("diff --git "))
        .count();
    let lines_changed = diff
        .lines()
        .filter(|l| {
            (l.starts_with('+') && !l.starts_with("+++"))
                || (l.starts_with('-') && !l.starts_with("---"))
        })
        .count();
    (files_changed, lines_changed)
}

/// Paths of the files touched by the diff, taken from the post-image (`b/…`) of each
/// `diff --git` header — the right one for created or renamed files. Known
/// approximation: a path literally containing " b/" confuses the split, but here
/// a heuristic is enough, not a full git parser.
fn changed_files(diff: &str) -> Vec<String> {
    diff.lines()
        .filter_map(|l| l.strip_prefix("diff --git "))
        .filter_map(|rest| rest.rsplit_once(" b/"))
        .map(|(_, path)| path.trim_matches('"').to_string())
        .collect()
}

/// Minimal glob matcher: `*` (does not cross `/`), `**` (crosses everything), `?`.
/// Hand-written instead of adding a dependency for a handful of patterns —
/// the comparison is case-insensitive because Windows paths are and the default
/// patterns are all lowercase.
fn glob_match(pattern: &str, path: &str) -> bool {
    let p: Vec<char> = pattern.replace('\\', "/").to_lowercase().chars().collect();
    let t: Vec<char> = path.replace('\\', "/").to_lowercase().chars().collect();
    glob_match_from(&p, 0, &t, 0)
}

fn glob_match_from(p: &[char], mut pi: usize, t: &[char], mut ti: usize) -> bool {
    while pi < p.len() {
        match p[pi] {
            '*' => {
                if p.get(pi + 1) == Some(&'*') {
                    // `**` — also crosses `/`. `**/x` must also match with
                    // zero folders in front, so that case is tried first.
                    let after = pi + 2;
                    if p.get(after) == Some(&'/') && glob_match_from(p, after + 1, t, ti) {
                        return true;
                    }
                    return (ti..=t.len()).any(|k| glob_match_from(p, after, t, k));
                }
                // `*` — stops at the first `/`.
                for k in ti..=t.len() {
                    if glob_match_from(p, pi + 1, t, k) {
                        return true;
                    }
                    if t.get(k) == Some(&'/') {
                        break;
                    }
                }
                return false;
            }
            '?' => {
                if t.get(ti).is_none_or(|c| *c == '/') {
                    return false;
                }
                pi += 1;
                ti += 1;
            }
            c => {
                if t.get(ti) != Some(&c) {
                    return false;
                }
                pi += 1;
                ti += 1;
            }
        }
    }
    ti == t.len()
}

/// Files in the diff that touch sensitive surfaces. If the project has
/// declared `sensitive_paths` those win; otherwise it falls back on the default
/// patterns, so the security hand-off exists even on a never-configured
/// project — surfaces are "declared by the project *or* recognised".
/// The second value says which of the two routes was used.
fn sensitive_hits(files: &[String], declared: Option<&str>) -> (Vec<String>, bool) {
    let declared_globs: Vec<&str> = declared
        .map(|s| {
            s.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .collect()
        })
        .unwrap_or_default();

    let from_defaults = declared_globs.is_empty();
    let globs: Vec<&str> = if from_defaults {
        DEFAULT_SENSITIVE_PATTERNS.to_vec()
    } else {
        declared_globs
    };

    let hits = files
        .iter()
        .filter(|f| globs.iter().any(|g| glob_match(g, f)))
        .cloned()
        .collect();
    (hits, from_defaults)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFinding {
    /// "high" | "medium" | "low" — indicativa, decide comunque l'utente.
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
    pub summary: String,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewOutcome {
    /// "pass" | "findings" | "skipped" | "error"
    pub verdict: String,
    pub findings: Vec<ReviewFinding>,
    /// Readable explanation when the review could not/should not be done.
    pub note: Option<String>,
    /// true if the diff was truncated before being passed to the model.
    pub diff_truncated: bool,
    /// Current round of the Fix→Review loop (0 = first pass).
    pub round: u32,
    /// Invarianti di progetto effettivamente iniettati ().
    pub used_invariants: bool,
    /// Files touched by the diff — 0 when not computable (skipped/error).
    #[serde(default)]
    pub files_changed: usize,
    /// Lines added+removed in the diff — 0 when not computable.
    #[serde(default)]
    pub lines_changed: usize,
    /// true if the diff exceeds one of the DEEP_REVIEW_* thresholds: a candidate for a
    /// manual `/code-review ultra` — never automatic, never launched by Pragma.
    #[serde(default)]
    pub deep_review_suggested: bool,
    /// true if the diff touches sensitive surfaces and the review also received the
    /// security hand-off. It is not a gate: it adds a dimension to the judgement,
    /// not a second verdict.
    #[serde(default)]
    pub security_pass: bool,
    /// The files that triggered the security hand-off — shown in the UI because
    /// "I also looked at security" without saying *where* is not verifiable.
    #[serde(default)]
    pub sensitive_files: Vec<String>,
    /// true if the sensitive files were recognised with the default patterns instead
    /// of the project's `sensitive_paths` — the UI uses it to suggest declaring
    /// them, as it already does with the invariants.
    #[serde(default)]
    pub sensitive_from_defaults: bool,
}

impl ReviewOutcome {
    fn skipped(note: impl Into<String>, round: u32) -> Self {
        Self {
            verdict: "skipped".to_string(),
            findings: vec![],
            note: Some(note.into()),
            diff_truncated: false,
            round,
            used_invariants: false,
            files_changed: 0,
            lines_changed: 0,
            deep_review_suggested: false,
            security_pass: false,
            sensitive_files: vec![],
            sensitive_from_defaults: false,
        }
    }

    fn error(note: impl Into<String>, round: u32) -> Self {
        Self {
            verdict: "error".to_string(),
            findings: vec![],
            note: Some(note.into()),
            diff_truncated: false,
            round,
            used_invariants: false,
            files_changed: 0,
            lines_changed: 0,
            deep_review_suggested: false,
            security_pass: false,
            sensitive_files: vec![],
            sensitive_from_defaults: false,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedReview {
    verdict: String,
    #[serde(default)]
    findings: Vec<ReviewFinding>,
}

fn strip_markdown_fences(text: &str) -> String {
    let t = text.trim();
    let t = t
        .strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))
        .unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t);
    t.trim().to_string()
}

fn cap(s: &str, limit: usize) -> (String, bool) {
    if s.chars().count() <= limit {
        return (s.to_string(), false);
    }
    let truncated: String = s.chars().take(limit).collect();
    (
        format!("{truncated}\n… (diff troncato: oltre {limit} caratteri)"),
        true,
    )
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

fn build_prompt(
    diff: &str,
    invariants: Option<&str>,
    previous_findings: &[ReviewFinding],
    sensitive_files: &[String],
) -> String {
    let mut p = String::new();
    p.push_str(
        "You are reviewing a code diff produced by another agent session. You did NOT write \
         this code — review it with fresh eyes.\n\n\
         Respond with ONLY a JSON object matching exactly this shape — no prose, no markdown \
         fences:\n\
         {\"verdict\": \"pass\" | \"findings\", \"findings\": [{\"severity\": \"high\"|\"medium\"|\"low\", \
         \"file\": string, \"line\": number, \"summary\": string, \"detail\": string}]}\n\n\
         Rules:\n\
         - \"pass\" means you found nothing worth blocking on. Use it freely: do not invent \
         findings to seem thorough.\n\
         - Report real defects: correctness bugs, broken contracts, security issues, violated \
         project invariants. Do NOT report style preferences or speculative refactors.\n\
         - You may read files in the working directory for context — the diff alone can mislead.\n",
    );

    if !previous_findings.is_empty() {
        p.push_str(
            "\nThis is a RE-REVIEW after a fix turn. These were the previous findings — verify \
             each one is actually resolved, and report anything the fix broke. Do not re-litigate \
             issues that are now fixed:\n",
        );
        for f in previous_findings {
            p.push_str(&format!(
                "- [{}] {}{}\n",
                f.severity,
                f.file.as_deref().unwrap_or("?"),
                format_args!(": {}", f.summary)
            ));
        }
    }

    if let Some(inv) = invariants {
        p.push_str(
            "\n--- PROJECT INVARIANTS (these are the project's own rules — violations are \
             findings) ---\n",
        );
        p.push_str(inv.trim());
        p.push('\n');
    }

    // Security hand-off: same session, not a second pass — the integrated
    // one was chosen, the dedicated pass stays a user action.
    if !sensitive_files.is_empty() {
        p.push_str(
            "\n--- SECURITY PASS (this diff touches sensitive surfaces) ---\n\
             Review the files below with an attacker's mindset, in addition to the general \
             review above. Report what you find as normal findings, using \"high\" severity \
             for anything exploitable.\n\
             Look specifically for: missing or bypassable authentication and authorization; \
             untrusted input reaching queries, shell commands, filesystem paths or \
             deserialization; secrets, keys or tokens committed in the clear; weak or \
             misused crypto; unsafe defaults and permissive CORS/permissions; sensitive data \
             written to logs or error messages.\n\
             Judge only what this diff actually changes — do not report pre-existing issues \
             it merely sits next to, and do not speculate about code you cannot see.\n\
             Sensitive files in this diff:\n",
        );
        for f in sensitive_files {
            p.push_str(&format!("- {f}\n"));
        }
    }

    p.push_str("\n--- DIFF ---\n");
    p.push_str(diff);
    p
}

// ---------------------------------------------------------------------------
// Orchestrazione
// ---------------------------------------------------------------------------

/// Arguments of the review session. There is no prompt: it arrives on stdin.
fn review_args(model_id: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = ["-p", "--output-format", "json"].map(String::from).to_vec();
    if let Some(m) = model_id {
        args.push("--model".to_string());
        args.push(m.to_string());
    }
    args
}

/// Runs the review on `diff` in a separate Claude session. `model_id` is the
/// model resolved for the review (Opus by default: judging the diff is the
/// core of the value). It emits no events: the caller does.
#[allow(clippy::too_many_arguments)]
pub async fn review_diff(
    binary: &str,
    config_dir: Option<&str>,
    working_dir: &str,
    diff: &str,
    invariants: Option<&str>,
    previous_findings: &[ReviewFinding],
    sensitive_files: &[String],
    model_id: Option<&str>,
    round: u32,
) -> ReviewOutcome {
    let (diff_capped, diff_truncated) = cap(diff, MAX_DIFF_CHARS);
    let prompt = build_prompt(&diff_capped, invariants, previous_findings, sensitive_files);

    // The prompt goes on stdin: as an argument, with the diff inside, it soon exceeds the
    // 32,767-character limit of the Windows command line and the spawn fails
    // precisely on large diffs.
    let mut cmd = tokio::process::Command::new(binary);
    cmd.args(review_args(model_id))
        .current_dir(working_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::piped());
    if let Some(dir) = config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return ReviewOutcome::error(format!("could not start the review: {e}"), round),
    };
    if let Some(mut stdin) = child.stdin.take() {
        // In a separate task: writing everything before reading stdout can deadlock if the
        // process fills the output pipe while it is still receiving the prompt.
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(prompt.as_bytes()).await;
        });
    }
    let output = match child.wait_with_output().await {
        Ok(o) => o,
        Err(e) => return ReviewOutcome::error(format!("could not start the review: {e}"), round),
    };
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return ReviewOutcome::error(format!("the review session failed: {err}"), round);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed = (|| -> Option<ParsedReview> {
        let envelope: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
        let result_text = envelope["result"].as_str()?;
        serde_json::from_str::<ParsedReview>(&strip_markdown_fences(result_text)).ok()
    })();

    match parsed {
        None => ReviewOutcome::error(
            "the review did not return an interpretable outcome — no judgement given",
            round,
        ),
        Some(p) => {
            // Reconciling verdict and list. A "pass" with findings is harmless (the list
            // wins), but "findings" with an empty list is not: it would mean the model
            // saw something and could not write it down. There we do not pretend a green.
            if !p.findings.is_empty() {
                ReviewOutcome {
                    verdict: "findings".to_string(),
                    findings: p.findings,
                    note: None,
                    diff_truncated,
                    round,
                    used_invariants: invariants.is_some(),
                    // Set by the caller (run_review), which has the full diff.
                    files_changed: 0,
                    lines_changed: 0,
                    deep_review_suggested: false,
                    security_pass: !sensitive_files.is_empty(),
                    sensitive_files: sensitive_files.to_vec(),
                    sensitive_from_defaults: false,
                }
            } else if p.verdict.eq_ignore_ascii_case("pass") {
                ReviewOutcome {
                    verdict: "pass".to_string(),
                    findings: vec![],
                    note: None,
                    diff_truncated,
                    round,
                    used_invariants: invariants.is_some(),
                    files_changed: 0,
                    lines_changed: 0,
                    deep_review_suggested: false,
                    security_pass: !sensitive_files.is_empty(),
                    sensitive_files: sensitive_files.to_vec(),
                    sensitive_from_defaults: false,
                }
            } else {
                ReviewOutcome::error(
                    format!(
                        "inconsistent review outcome (verdict \"{}\" with no findings) — \
                         no reliable judgement",
                        p.verdict
                    ),
                    round,
                )
            }
        }
    }
}

/// Entry point of the phase: computes the diff from the session branch and runs the
/// review, emitting `pragma:review` (and the `awaiting_review_decision` phase when
/// there are findings the user must decide Fix/Accept on).
#[allow(clippy::too_many_arguments)]
pub async fn run_review(
    app: &AppHandle,
    session_id: &str,
    project: &ProjectInfo,
    working_dir: &str,
    git_base: Option<&str>,
    binary: &str,
    config_dir: Option<&str>,
    model_id: Option<&str>,
    previous_findings: &[ReviewFinding],
    round: u32,
) -> ReviewOutcome {
    let outcome = match git_base {
        // Without a session branch there is no reliable base for the diff. A fallback
        // on the atoms is possible; until it exists, this is declared and skipped —
        // never pretend a review that was not done.
        None => ReviewOutcome::skipped(
            "no starting commit recorded (not a git repository, or it has no commits): review skipped",
            round,
        ),
        Some(base) => match crate::git_branch::diff_since(working_dir, base).await {
            Err(e) => ReviewOutcome::error(format!("git diff failed: {e}"), round),
            Ok(diff) if diff.trim().is_empty() => {
                ReviewOutcome::skipped("no changes to review", round)
            }
            Ok(diff) => {
                let (files_changed, lines_changed) = diff_stats(&diff);
                let invariants = project
                    .review_invariants
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let declared_sensitive = project
                    .sensitive_paths
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let (sensitive_files, from_defaults) =
                    sensitive_hits(&changed_files(&diff), declared_sensitive);
                let mut outcome = review_diff(
                    binary,
                    config_dir,
                    working_dir,
                    &diff,
                    invariants,
                    previous_findings,
                    &sensitive_files,
                    model_id,
                    round,
                )
                .await;
                outcome.files_changed = files_changed;
                outcome.lines_changed = lines_changed;
                outcome.deep_review_suggested = files_changed > DEEP_REVIEW_FILES_THRESHOLD
                    || lines_changed > DEEP_REVIEW_LINES_THRESHOLD;
                outcome.sensitive_from_defaults = from_defaults && outcome.security_pass;
                outcome
            }
        },
    };

    emit_session(app, "pragma:review", session_id, &outcome);
    if outcome.verdict == "findings" {
        emit_session(
            app,
            "pragma:phase",
            session_id,
            serde_json::Value::String("awaiting_review_decision".to_string()),
        );
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(summary: &str) -> ReviewFinding {
        ReviewFinding {
            severity: "high".to_string(),
            file: Some("src/a.rs".to_string()),
            line: Some(12),
            summary: summary.to_string(),
            detail: None,
        }
    }

    #[test]
    fn diff_stats_counts_files_and_changed_lines() {
        let diff = "diff --git a/src/a.rs b/src/a.rs\n\
                     --- a/src/a.rs\n\
                     +++ b/src/a.rs\n\
                     -old line\n\
                     +new line\n\
                     +another new line\n\
                     diff --git a/src/b.rs b/src/b.rs\n\
                     --- a/src/b.rs\n\
                     +++ b/src/b.rs\n\
                     +one more line\n";
        let (files, lines) = diff_stats(diff);
        assert_eq!(files, 2);
        assert_eq!(lines, 4); // 1 removed + 3 added, header lines excluded
    }

    #[test]
    fn review_args_never_carry_the_prompt() {
        assert_eq!(
            review_args(Some("claude-opus-5")),
            ["-p", "--output-format", "json", "--model", "claude-opus-5"]
        );
        assert_eq!(review_args(None), ["-p", "--output-format", "json"]);
    }

    #[test]
    fn diff_stats_empty_diff_is_zero() {
        assert_eq!(diff_stats(""), (0, 0));
    }

    #[test]
    fn glob_matches_star_within_a_segment_only() {
        assert!(glob_match("src/api/*.rs", "src/api/foo.rs"));
        assert!(
            !glob_match("src/api/*.rs", "src/api/nested/foo.rs"),
            "`*` must not cross /"
        );
    }

    #[test]
    fn glob_double_star_crosses_directories_and_allows_zero() {
        assert!(glob_match("**/auth/**", "src/server/auth/login.rs"));
        assert!(
            glob_match("**/auth/**", "auth/login.rs"),
            "`**/` must also match with no folders in front"
        );
        assert!(glob_match("**/*.sql", "db/migrations/001.sql"));
        assert!(!glob_match("**/*.sql", "db/migrations/001.rs"));
    }

    #[test]
    fn glob_is_case_insensitive() {
        assert!(glob_match("**/*auth*", "src/MyAuthService.ts"));
    }

    #[test]
    fn changed_files_reads_the_post_image_path() {
        let diff = "diff --git a/src/old.rs b/src/new.rs\n\
                     --- a/src/old.rs\n\
                     +++ b/src/new.rs\n\
                     +line\n\
                     diff --git a/README.md b/README.md\n\
                     +doc\n";
        assert_eq!(changed_files(diff), vec!["src/new.rs", "README.md"]);
    }

    #[test]
    fn declared_sensitive_paths_win_over_defaults() {
        let files = vec![
            "src/auth/login.rs".to_string(),
            "src/ui/button.rs".to_string(),
        ];
        // The project declares a surface the defaults would not recognise,
        // and does *not* declare auth: what is declared wins, in both directions.
        let (hits, from_defaults) = sensitive_hits(&files, Some("**/ui/**"));
        assert_eq!(hits, vec!["src/ui/button.rs"]);
        assert!(!from_defaults);
    }

    #[test]
    fn defaults_are_used_when_the_project_declared_nothing() {
        let files = vec![
            "src/auth/login.rs".to_string(),
            "src/ui/button.rs".to_string(),
        ];
        let (hits, from_defaults) = sensitive_hits(&files, None);
        assert_eq!(hits, vec!["src/auth/login.rs"]);
        assert!(from_defaults);
    }

    #[test]
    fn blank_and_commented_lines_in_sensitive_paths_are_ignored() {
        let files = vec!["src/db/query.rs".to_string()];
        let (hits, from_defaults) = sensitive_hits(&files, Some("# commento\n\n  **/db/**  \n"));
        assert_eq!(hits, vec!["src/db/query.rs"]);
        assert!(
            !from_defaults,
            "a valid glob was there: it is not a fallback"
        );
    }

    #[test]
    fn a_diff_with_no_sensitive_file_gets_no_security_delivery() {
        let files = vec!["README.md".to_string(), "src/ui/button.tsx".to_string()];
        let (hits, _) = sensitive_hits(&files, None);
        assert!(hits.is_empty());
        let p = build_prompt("diff body", None, &[], &hits);
        assert!(!p.contains("SECURITY PASS"));
    }

    #[test]
    fn prompt_includes_the_security_delivery_and_the_files_that_triggered_it() {
        let sensitive = vec!["src/auth/login.rs".to_string()];
        let p = build_prompt("diff body", None, &[], &sensitive);
        assert!(p.contains("SECURITY PASS"));
        assert!(p.contains("src/auth/login.rs"));
        // The hand-off stays inside the same review: no second verdict.
        assert!(p.contains("as normal findings"));
    }

    #[test]
    fn prompt_includes_invariants_when_present() {
        let p = build_prompt("diff body", Some("Always 1:1 with legacy"), &[], &[]);
        assert!(p.contains("PROJECT INVARIANTS"));
        assert!(p.contains("Always 1:1 with legacy"));
        assert!(p.contains("diff body"));
    }

    #[test]
    fn prompt_omits_invariants_section_when_absent() {
        let p = build_prompt("diff body", None, &[], &[]);
        assert!(!p.contains("PROJECT INVARIANTS"));
    }

    #[test]
    fn re_review_prompt_lists_previous_findings() {
        let prev = vec![finding("null deref on empty input")];
        let p = build_prompt("diff body", None, &prev, &[]);
        assert!(p.contains("RE-REVIEW"));
        assert!(p.contains("null deref on empty input"));
    }

    #[test]
    fn diff_over_limit_is_truncated() {
        let big = "x".repeat(MAX_DIFF_CHARS + 100);
        let (capped, truncated) = cap(&big, MAX_DIFF_CHARS);
        assert!(truncated);
        assert!(capped.contains("diff troncato"));
    }

    #[test]
    fn diff_under_limit_is_untouched() {
        let (capped, truncated) = cap("small diff", MAX_DIFF_CHARS);
        assert!(!truncated);
        assert_eq!(capped, "small diff");
    }

    #[test]
    fn empty_findings_with_non_pass_verdict_is_not_a_green() {
        // Regression: a model that declares "findings" but cannot serialise them
        // must never become a "pass".
        let parsed: ParsedReview =
            serde_json::from_str(r#"{"verdict":"findings","findings":[]}"#).unwrap();
        assert!(parsed.findings.is_empty());
        assert!(!parsed.verdict.eq_ignore_ascii_case("pass"));
    }

    #[test]
    fn strip_fences_removes_json_wrapper() {
        assert_eq!(
            strip_markdown_fences("```json\n{\"verdict\": \"pass\"}\n```"),
            "{\"verdict\": \"pass\"}"
        );
    }
}
