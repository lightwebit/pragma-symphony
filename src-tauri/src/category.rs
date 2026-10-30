use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Client request category → technology stack. Deterministic, hard-wired mapping,
// zero LLM queries — reproducible, instant, free.
//
// Coverage is by *category of client request*, not by language: a language is
// added only if it opens an uncovered category, not if it offers a second way to
// a category that is already covered.
//
// A stack outside this catalogue is legitimate — the user knows how to phrase the
// request, it is not the system's job to disambiguate — just without a live
// command proposed automatically later on.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryEntry {
    pub category: &'static str,
    pub stack: &'static str,
    /// Why that combination — shown in the UI: "opens the hood", never a
    /// black-box proposal.
    pub rationale: &'static str,
}

pub fn category_catalog() -> Vec<CategoryEntry> {
    vec![
        CategoryEntry {
            category: "Website with AI",
            stack: "Vue (frontend) + Python (AI/backend) + CI/CD",
            rationale: "Web frontend and AI/data work each have their own dedicated \
                        stack among the covered categories — no single tool here \
                        covers both well.",
        },
        CategoryEntry {
            category: "Mobile app (with backend)",
            stack: "MAUI/.NET (mobile) + .NET (backend) + CI/CD",
            rationale: "Mobile and backend stay on the same ecosystem (.NET) so a \
                        single client request doesn't need a second toolchain.",
        },
        CategoryEntry {
            category: "Web app / management system",
            stack: "Vue (frontend) + .NET (backend) + CI/CD",
            rationale: "Standard web app shape: a real backend behind the browser \
                        frontend, not a static site.",
        },
        CategoryEntry {
            category: "API / backend only",
            stack: ".NET or Python + CI/CD",
            rationale: "No frontend to build here — .NET or Python depending on \
                        what the backend needs; heavier data/AI work leans Python.",
        },
        CategoryEntry {
            category: "Desktop app",
            stack: "Rust/Tauri + CI/CD",
            rationale: "The only desktop stack covered — Tauri over Electron for \
                        footprint, and it's the stack Pragma itself is built on.",
        },
        CategoryEntry {
            category: "Automation / scripting / data",
            stack: "Python",
            rationale: "Scripting, data and AI automation with nothing to ship as \
                        an app — no CI/CD step by default, there's nothing to \
                        build or deploy.",
        },
    ]
}

fn catalog_as_prompt_table() -> String {
    category_catalog()
        .iter()
        .map(|c| {
            format!(
                "- category \"{}\" — stack: {} — why: {}",
                c.category, c.stack, c.rationale
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------------------------------------------------------------------------
// Category discovery (one-off, Sonnet)
//
// Reading order decided up front: a markdown brief written by the user comes
// before the manifests. On an *existing* project the manifests already say the
// stack, but there is nothing to decide — discovery matters mostly on a *new*
// project, where the directory is empty and the only signal is the brief.
// Manifests remain the fallback for projects already under way, not the main channel.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryDiscovery {
    pub category: String,
    pub stack: String,
    #[serde(default)]
    pub rationale: Option<String>,
    /// One sentence on what was inspected (which brief file was read, which
    /// manifests were found) — same transparency as the catalogue: never a
    /// black-box proposal, not even when the model is the one deciding.
    #[serde(default)]
    pub evidence: Option<String>,
}

fn build_discovery_prompt() -> String {
    format!(
        "You are classifying what kind of software project lives in the current working \
         directory, to propose a client-request category and the stack that follows from it.\n\n\
         Look for signal in this order:\n\
         1. A markdown brief at the project root describing what was requested (common names: \
         BRIEF.md, PROJECT.md, README.md, or any other *.md at the root) — read it if present. \
         On a fresh project this is often the ONLY thing in the directory, and it states intent \
         directly: prefer it over anything else.\n\
         2. If no brief exists, or it doesn't describe a client request, inspect the manifests \
         present (package.json, Cargo.toml, *.csproj, pyproject.toml, tauri.conf.json, go.mod, \
         pom.xml, build.gradle…) and infer the category from the stack already in place.\n\
         3. If neither gives a clear signal, do not guess: return empty strings for \"category\" \
         and \"stack\".\n\n\
         Prefer one of these categories when it fits — reuse its exact stack string too:\n\n{}\n\n\
         A category outside this list is legitimate if none fits (report what you actually find, \
         never force a bad match), but never invent a category that contradicts the evidence.\n\n\
         Respond with ONLY a JSON object matching exactly this shape — no prose, no markdown \
         fences:\n\
         {{\"category\": string, \"stack\": string, \"rationale\": string, \"evidence\": string}}\n\n\
         Rules:\n\
         - \"rationale\" is one or two sentences on why this category/stack fits.\n\
         - \"evidence\" says what you actually inspected — which brief file (if any) and/or which \
         manifests were found. Empty string only if you found nothing at all.",
        catalog_as_prompt_table()
    )
}

/// Runs discovery as an isolated Claude call (no interactive session,
/// no protocol markers). Default agent model = Sonnet: it is mechanical
/// reconnaissance of a brief/manifest, not architectural judgement.
pub async fn discover(
    binary: &str,
    config_dir: Option<&str>,
    working_dir: &str,
) -> Result<CategoryDiscovery, String> {
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
    parse_discovery(&stdout).ok_or_else(|| {
        "la discovery non ha trovato un segnale interpretabile — nessun brief o manifest \
         riconoscibile. Compila i campi a mano."
            .to_string()
    })
}

fn parse_discovery(claude_json_envelope: &str) -> Option<CategoryDiscovery> {
    let envelope: serde_json::Value = serde_json::from_str(claude_json_envelope.trim()).ok()?;
    let result_text = envelope["result"].as_str()?;
    let cleaned = crate::verify::strip_markdown_fences(result_text);
    let mut d: CategoryDiscovery = serde_json::from_str(&cleaned).ok()?;
    // Empty category or stack = "no signal found" (prompt rule 3):
    // a half proposal is as unusable as no proposal.
    if d.category.trim().is_empty() || d.stack.trim().is_empty() {
        return None;
    }
    d.rationale = d.rationale.filter(|s| !s.trim().is_empty());
    d.evidence = d.evidence.filter(|s| !s.trim().is_empty());
    Some(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_has_a_non_empty_category_stack_and_rationale() {
        // A half entry (e.g. empty stack) would be an unusable proposal
        // in the UI — better to fail here than to discover an empty field on screen.
        for entry in category_catalog() {
            assert!(!entry.category.trim().is_empty());
            assert!(!entry.stack.trim().is_empty());
            assert!(!entry.rationale.trim().is_empty());
        }
    }

    #[test]
    fn categories_are_unique() {
        let catalog = category_catalog();
        let mut seen = std::collections::HashSet::new();
        for entry in &catalog {
            assert!(
                seen.insert(entry.category),
                "categoria duplicata: {}",
                entry.category
            );
        }
    }

    #[test]
    fn discovery_prompt_lists_every_catalog_category_with_its_stack() {
        let prompt = build_discovery_prompt();
        for entry in category_catalog() {
            assert!(
                prompt.contains(entry.category),
                "missing {}",
                entry.category
            );
            assert!(
                prompt.contains(entry.stack),
                "missing the stack of {}",
                entry.category
            );
        }
    }

    #[test]
    fn discovery_prompt_puts_the_brief_before_the_manifests() {
        // The design decision is that the .md brief comes before the
        // manifests, not the other way round — a test on the prompt text is weak but
        // here it only prevents someone from inverting the order by mistake.
        let prompt = build_discovery_prompt();
        let brief_pos = prompt
            .find("markdown brief")
            .expect("the prompt must mention the brief");
        let manifest_pos = prompt
            .find("manifests present")
            .expect("the prompt must mention the manifests");
        assert!(
            brief_pos < manifest_pos,
            "the brief must come before the manifests in the prompt"
        );
    }

    #[test]
    fn parse_discovery_reads_a_well_formed_envelope() {
        let envelope = r#"{"result":"{\"category\":\"Desktop app\",\"stack\":\"Rust/Tauri + CI/CD\",\"rationale\":\"Tauri manifest found\",\"evidence\":\"Read tauri.conf.json\"}"}"#;
        let d = parse_discovery(envelope).unwrap();
        assert_eq!(d.category, "Desktop app");
        assert_eq!(d.stack, "Rust/Tauri + CI/CD");
        assert_eq!(d.evidence.as_deref(), Some("Read tauri.conf.json"));
    }

    #[test]
    fn parse_discovery_strips_markdown_fences() {
        let envelope = r#"{"result":"```json\n{\"category\":\"Desktop app\",\"stack\":\"Rust/Tauri + CI/CD\"}\n```"}"#;
        let d = parse_discovery(envelope).unwrap();
        assert_eq!(d.stack, "Rust/Tauri + CI/CD");
        assert_eq!(d.rationale, None);
    }

    #[test]
    fn parse_discovery_rejects_an_empty_category_or_stack() {
        // Half is as unusable as nothing: better "I found nothing"
        // than a proposal with an empty field the UI would have to guess.
        let no_category = r#"{"result":"{\"category\":\"  \",\"stack\":\"Python\"}"}"#;
        assert!(parse_discovery(no_category).is_none());
        let no_stack = r#"{"result":"{\"category\":\"Desktop app\",\"stack\":\"\"}"}"#;
        assert!(parse_discovery(no_stack).is_none());
    }

    #[test]
    fn parse_discovery_rejects_non_json_result() {
        let envelope = r#"{"result":"I couldn't find any signal in this directory."}"#;
        assert!(parse_discovery(envelope).is_none());
    }
}
