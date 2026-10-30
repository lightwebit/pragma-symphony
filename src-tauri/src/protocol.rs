use pragma_parser::types::{Atom, AtomType};

// ---------------------------------------------------------------------------
// Pragma protocol — injected as --append-system-prompt on every run.
// ---------------------------------------------------------------------------

pub const PRAGMA_PROTOCOL: &str = r#"
You are operating within the Pragma protocol. You MUST structure every response using the exact markers below — no exceptions, no deviations.

== FLOW ==

1. Always start with:
   ANALYSIS:
   <concise analysis of the request — what is being asked and any relevant constraints>

2. If the task is ambiguous or requires clarification before proceeding, emit:
   QUESTIONS:
   1. <question 1>
      - <option, only if the user has to pick among alternatives>
      - <option>
   2. <question 2>
   AWAITING_ANSWERS
   Then STOP and wait for the user's reply before continuing.

3. Once the task is clear, emit the execution plan:
   PLAN:
   1. <step 1>
   2. <step 2>
   ...
   AWAITING_CONFIRMATION
   Then STOP. Do not execute anything until the user confirms.

4. After confirmation, execute each step in order. After completing each step emit:
   STEP_COMPLETE: <N>
   <brief description of what was done>

5. After all steps are complete, emit:
   REPORT:
   <summary of completed work, files created/modified, key decisions>

6. Always emit a verification checklist:
   TESTS:
   - <verification step 1>
   - <verification step 2>
   - <verification step 3>

7. Finally, always close with:
   CLOSING:
   <one short sentence — confirm completion and invite follow-up questions>
   AWAITING_CLOSE

== RULES ==
- Use these markers exactly as written (uppercase, colon after section names).
- IMPORTANT: Always write the marker keywords in English (ANALYSIS:, QUESTIONS:, PLAN:, etc.) regardless of the language you use for content. Only the content inside each section may be in the user's language.
- Never skip AWAITING_CONFIRMATION — always pause after PLAN and wait for approval.
- Never emit QUESTIONS and PLAN in the same response. If a doubt blocks the work, ask it and stop at AWAITING_ANSWERS. If it does not block, do not ask: state the choice you are making as an assumption inside ANALYSIS and go on to the PLAN.
- Never skip TESTS — always include at least 2 verification items.
- Never skip CLOSING / AWAITING_CLOSE — always end every response with them.
- Do not add markdown headers (##) or bold (**) around the markers themselves.
- Keep section content concise and actionable.
- THIS IS NON-OPTIONAL: even for short, conversational, or evaluative prompts (opinions, quick answers, explanations), you MUST still use the markers. There is NO scenario where you may respond with plain prose or markdown headers instead.
- Minimum flow for non-task responses (no plan needed): ANALYSIS: → CLOSING: → AWAITING_CLOSE
- NEVER use ## headers, **bold labels**, or any markdown structure as a substitute for the markers above.
"#;

/// Step-by-step addendum — appended when the user requires manual approval between steps.
pub const PRAGMA_STEP_BY_STEP: &str = r#"
== STEP-BY-STEP MODE (MANDATORY) ==
CRITICAL CONSTRAINT — you MUST obey this without exception:
After every STEP_COMPLETE: <N>, if there are more steps remaining, you MUST emit:
AWAITING_CONFIRMATION
Then STOP COMPLETELY. Do not write another word. Do not begin the next step.
You may only continue after receiving CONTINUE from the user.
Ignoring this constraint will cause the session to abort.
"#;

// ---------------------------------------------------------------------------
// Pragma protocol state machine — per-session
// ---------------------------------------------------------------------------

#[derive(PartialEq)]
pub enum SectionKind {
    None,
    Analysis,
    Questions,
    Plan,
    StepComplete(u32),
    Report,
    Tests,
    Closing,
}

/// A protocol event to deliver to the frontend: the name (`pragma:plan`…) and the payload.
/// The session it belongs to is added by whoever emits it (`process.rs`).
#[derive(Debug, Clone, PartialEq)]
pub struct ProtocolEvent {
    pub name: &'static str,
    pub payload: serde_json::Value,
}

/// State machine of the protocol, one per process (so per turn). Pure: it receives atoms
/// and returns events, without touching Tauri — which is what makes it testable.
///
/// It persists between one atom and the next to handle:
/// - a section opened in one atom and filled in the next;
/// - cumulative streaming: the same payload is not re-emitted;
/// - the end of the turn: the section still open is closed in `finish`.
pub struct ProtocolParser {
    section: SectionKind,
    buf: Vec<String>,
    found_any_marker: bool,
    /// At least one phase marker (AWAITING_*) in this turn: if missing, the turn ended
    /// without telling the user what to do and the UI has no buttons to show.
    phase_seen: bool,
    last_emitted: std::collections::HashMap<&'static str, String>,
    report_emitted: bool,
}

impl Default for ProtocolParser {
    fn default() -> Self {
        Self::new()
    }
}

impl ProtocolParser {
    pub fn new() -> Self {
        Self {
            section: SectionKind::None,
            buf: Vec::new(),
            found_any_marker: false,
            phase_seen: false,
            last_emitted: std::collections::HashMap::new(),
            report_emitted: false,
        }
    }

    /// A REPORT: was emitted in this turn. Alone it is not enough to launch VERIFY: a
    /// truncated turn emits the half-written REPORT in `finish` (see `process.rs`).
    pub fn report_emitted(&self) -> bool {
        self.report_emitted
    }

    pub fn feed(&mut self, atom: &Atom) -> Vec<ProtocolEvent> {
        let mut out = Vec::new();
        if atom.atom_type != AtomType::AgentNote {
            return out;
        }

        let lines = split_lines_outside_fences(&atom.content);

        let first_meaningful = lines
            .iter()
            .filter(|l| !l.in_fence)
            .map(|l| strip_markdown_prefix(l.text.trim_end()))
            .find(|l| !l.is_empty())
            .unwrap_or("");
        if is_section_header_start(first_meaningful) || is_phase_keyword(first_meaningful) {
            // First the section left open by the previous atoms is closed: just resetting it
            // lost a REPORT followed by an atom starting with AWAITING_CLOSE. An atom
            // that repeats the same text produces the same payload, and deduplication discards it.
            self.flush_current(&mut out);
            self.section = SectionKind::None;
            self.buf.clear();
        }

        for l in &lines {
            let line = l.text.trim_end();
            if l.in_fence {
                self.buf.push(line.to_string());
                continue;
            }
            let norm = strip_markdown_prefix(line);

            if let Some((kind, inline)) = detect_section_header(norm) {
                self.flush_current(&mut out);
                self.section = kind;
                self.buf.clear();
                self.found_any_marker = true;
                if let Some(text) = inline {
                    if !text.is_empty() {
                        if matches!(self.section, SectionKind::Plan) {
                            self.buf.extend(split_numbered_inline(text));
                        } else {
                            self.buf.push(text.to_string());
                        }
                    }
                }
            } else if let Some(phase) = detect_phase(norm) {
                self.flush_current(&mut out);
                self.section = SectionKind::None;
                self.buf.clear();
                self.found_any_marker = true;
                self.phase_seen = true;
                self.push_dedup(
                    &mut out,
                    "pragma:phase",
                    serde_json::Value::String(phase.to_string()),
                );
            } else {
                self.buf.push(line.to_string());
            }
        }
        out
    }

    /// End of the turn. Closes the open section; if the turn had no marker, recovers
    /// the model's last note as RAW_NOTE; and always says how the turn ended with
    /// `pragma:turn_end`. `truncated`: the process died or closed with an error, so
    /// the last section may be half-written.
    pub fn finish(&mut self, last_note: Option<&str>, truncated: bool) -> Vec<ProtocolEvent> {
        let mut out = Vec::new();
        self.flush_current(&mut out);

        if !self.found_any_marker {
            if let Some(text) = last_note {
                let trimmed = text.trim();
                if trimmed.len() > 20 {
                    self.push_dedup(
                        &mut out,
                        "pragma:raw_note",
                        serde_json::json!({ "text": trimmed }),
                    );
                }
            }
        }

        out.push(ProtocolEvent {
            name: "pragma:turn_end",
            payload: serde_json::json!({ "terminal": self.phase_seen, "truncated": truncated }),
        });

        self.section = SectionKind::None;
        self.buf.clear();
        self.found_any_marker = false;
        self.phase_seen = false;
        out
    }

    fn flush_current(&mut self, out: &mut Vec<ProtocolEvent>) {
        if matches!(self.section, SectionKind::None) {
            return;
        }
        let payload = build_section_payload(&self.section, &self.buf);
        let event = section_event_name(&self.section);
        if let (Some(payload), Some(event)) = (payload, event) {
            self.push_dedup(out, event, payload);
        }
    }

    fn push_dedup(
        &mut self,
        out: &mut Vec<ProtocolEvent>,
        event: &'static str,
        payload: serde_json::Value,
    ) {
        if event == "pragma:report" {
            self.report_emitted = true;
        }
        let serialized = payload.to_string();
        if self.last_emitted.get(event) == Some(&serialized) {
            return;
        }
        self.last_emitted.insert(event, serialized);
        out.push(ProtocolEvent {
            name: event,
            payload,
        });
    }
}

/// The model's last note in the turn: it is the text the RAW_NOTE fallback recovers when
/// the turn has no marker. It must be searched across *all* the turn's atoms: it used to be
/// searched in the last batch, already emptied, and the fallback never fired.
pub fn last_agent_note(atoms: &[Atom]) -> Option<&str> {
    atoms
        .iter()
        .rfind(|a| a.atom_type == AtomType::AgentNote)
        .map(|a| a.content.as_str())
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

struct ScanLine {
    text: String,
    /// Inside a ``` block (fence included): it is content, never a marker. A model that
    /// writes a file with a `PLAN:` line or explains the protocol must not open sections.
    in_fence: bool,
}

/// Splits an atom into lines, and outside code blocks moves every marker attached to
/// prose onto its own line (`Done. STEP_COMPLETE: 11` — seen in real databases).
/// The fence state restarts at every atom: a block left open by mistake must not
/// switch off the markers for the rest of the turn.
fn split_lines_outside_fences(text: &str) -> Vec<ScanLine> {
    let mut out = Vec::new();
    let mut in_fence = false;
    for raw in text.lines() {
        if raw.trim_start().starts_with("```") {
            in_fence = !in_fence;
            out.push(ScanLine {
                text: raw.to_string(),
                in_fence: true,
            });
            continue;
        }
        if in_fence {
            out.push(ScanLine {
                text: raw.to_string(),
                in_fence: true,
            });
            continue;
        }
        for part in normalize_pragma_content(raw).lines() {
            out.push(ScanLine {
                text: part.to_string(),
                in_fence: false,
            });
        }
    }
    out
}

fn normalize_pragma_content(text: &str) -> String {
    const STARTERS: &[&str] = &[
        "ANALYSIS:",
        "QUESTIONS:",
        "PLAN:",
        "STEP_COMPLETE:",
        "REPORT:",
        "TESTS:",
        "CLOSING:",
        "AWAITING_ANSWERS",
        "AWAITING_APPROVAL",
        "AWAITING_CONFIRMATION",
        "AWAITING_CLOSE",
    ];
    let mut out = text.to_string();
    for kw in STARTERS {
        out = out.replace(&format!(" {kw}"), &format!("\n{kw}"));
    }
    out
}

fn strip_markdown_prefix(line: &str) -> &str {
    let s = line.trim_start_matches('#').trim();
    let s = s.trim_start_matches("**").trim_end_matches("**").trim();
    s.trim_start_matches('*').trim()
}

fn is_section_header_start(norm: &str) -> bool {
    matches!(
        norm,
        "ANALYSIS:" | "QUESTIONS:" | "PLAN:" | "REPORT:" | "TESTS:" | "CLOSING:"
    ) || norm.starts_with("ANALYSIS: ")
        || norm.starts_with("QUESTIONS: ")
        || norm.starts_with("PLAN: ")
        || norm.starts_with("REPORT: ")
        || norm.starts_with("TESTS: ")
        || norm.starts_with("CLOSING: ")
        || norm.starts_with("STEP_COMPLETE: ")
}

fn is_phase_keyword(norm: &str) -> bool {
    matches!(
        norm,
        "AWAITING_ANSWERS" | "AWAITING_APPROVAL" | "AWAITING_CLOSE"
    ) || norm.starts_with("AWAITING_CONFIRMATION")
}

fn detect_section_header(norm: &str) -> Option<(SectionKind, Option<&str>)> {
    macro_rules! section {
        ($kw:literal, $kind:expr) => {
            if norm == $kw {
                return Some(($kind, None));
            }
            if let Some(inline) = norm.strip_prefix(concat!($kw, " ")) {
                return Some(($kind, Some(inline)));
            }
        };
    }
    section!("ANALYSIS:", SectionKind::Analysis);
    section!("QUESTIONS:", SectionKind::Questions);
    section!("PLAN:", SectionKind::Plan);
    section!("REPORT:", SectionKind::Report);
    section!("TESTS:", SectionKind::Tests);
    section!("CLOSING:", SectionKind::Closing);

    if let Some(rest) = norm.strip_prefix("STEP_COMPLETE: ") {
        let mut parts = rest.splitn(2, ' ');
        let n = parts.next().unwrap_or("0").parse::<u32>().unwrap_or(0);
        let inline = parts.next();
        return Some((SectionKind::StepComplete(n), inline));
    }
    None
}

fn detect_phase(norm: &str) -> Option<&'static str> {
    match norm {
        "AWAITING_ANSWERS" => Some("awaiting_answers"),
        "AWAITING_APPROVAL" => Some("awaiting_approval"),
        "AWAITING_CLOSE" => Some("awaiting_close"),
        _ if norm.starts_with("AWAITING_CONFIRMATION") => Some("awaiting_confirmation"),
        _ => None,
    }
}

fn build_section_payload(sec: &SectionKind, lines: &[String]) -> Option<serde_json::Value> {
    let text = lines.join("\n");
    let text = text.trim().to_string();
    match sec {
        SectionKind::Analysis | SectionKind::Report | SectionKind::Closing => {
            if text.is_empty() {
                return None;
            }
            Some(serde_json::json!({ "text": text }))
        }
        SectionKind::Questions => {
            let questions = group_questions(lines);
            if questions.is_empty() {
                return None;
            }
            let items: Vec<serde_json::Value> = questions
                .into_iter()
                .map(|(text, options)| serde_json::json!({ "text": text, "options": options }))
                .collect();
            Some(serde_json::json!({ "items": items }))
        }
        SectionKind::Tests => {
            let items: Vec<String> = lines
                .iter()
                .map(|l| l.trim_start_matches("- ").trim().to_string())
                .filter(|s| !s.is_empty() && !s.chars().all(|c| c == '-'))
                .collect();
            if items.is_empty() {
                return None;
            }
            Some(serde_json::json!({ "items": items }))
        }
        SectionKind::Plan => {
            let steps: Vec<&String> = lines.iter().filter(|l| !l.trim().is_empty()).collect();
            if steps.is_empty() {
                return None;
            }
            Some(serde_json::json!({ "steps": steps }))
        }
        SectionKind::StepComplete(n) => {
            if text.is_empty() {
                return None;
            }
            Some(serde_json::json!({ "step": n, "result": text }))
        }
        SectionKind::None => None,
    }
}

/// Strips leading numbering (`1. `, `2) `, even repeated: `1. 1. `). `None` if there is none.
fn strip_numbering(s: &str) -> Option<&str> {
    let mut rest = s;
    let mut stripped = false;
    loop {
        let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 {
            break;
        }
        let after = &rest[digits..];
        let Some(after) = after.strip_prefix('.').or_else(|| after.strip_prefix(')')) else {
            break;
        };
        if !after.starts_with(char::is_whitespace) {
            break;
        }
        rest = after.trim_start();
        stripped = true;
    }
    stripped.then_some(rest)
}

fn strip_bullet(s: &str) -> Option<&str> {
    ["- ", "* ", "• "]
        .iter()
        .find_map(|b| s.strip_prefix(b))
        .map(str::trim_start)
}

/// `(a) …` or `a) …`: an option written without a dash.
fn is_lettered_option(s: &str) -> bool {
    let s = s.strip_prefix('(').unwrap_or(s);
    let mut chars = s.chars();
    matches!(
        (chars.next(), chars.next(), chars.next()),
        (Some(l), Some(')'), Some(' ')) if l.is_ascii_alphabetic()
    )
}

/// Groups the QUESTIONS lines into questions with their options. The rules follow
/// how the model writes (4 real cases out of 5): numbered questions, options as
/// items under the question.
/// - If the block has at least one numbered line, numbered lines open a question and the items
///   (`- `, `(a) `) are options of the current question. A numbered line that contains an
///   item (`2. - (a) …`, as they used to be saved) is an option too.
/// - Without numbers, every item is a question: it is the protocol format of earlier versions.
/// - Any other line continues the text of the current question. A prose-only block
///   (a proposal in paragraphs) therefore stays **one** question, as the UI used to treat it.
///
/// Twin of `groupQuestions` in `src/questions.ts`: same rules, same test cases.
fn group_questions(lines: &[String]) -> Vec<(String, Vec<String>)> {
    let clean: Vec<&str> = lines
        .iter()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.chars().all(|c| c == '-'))
        .collect();
    let numbered = clean.iter().any(|l| strip_numbering(l).is_some());

    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for line in clean {
        let (body, was_numbered) = match strip_numbering(line) {
            Some(rest) => (rest, true),
            None => (line, false),
        };
        let bullet = strip_bullet(body);
        let is_option =
            numbered && (bullet.is_some() || (!was_numbered && is_lettered_option(body)));

        if is_option {
            let text = bullet.unwrap_or(body).to_string();
            match out.last_mut() {
                Some(q) => q.1.push(text),
                None => out.push((text, Vec::new())),
            }
        } else if was_numbered || (!numbered && bullet.is_some()) || out.is_empty() {
            out.push((bullet.unwrap_or(body).to_string(), Vec::new()));
        } else if let Some(q) = out.last_mut() {
            q.0.push('\n');
            q.0.push_str(body);
        }
    }
    out
}

fn section_event_name(sec: &SectionKind) -> Option<&'static str> {
    match sec {
        SectionKind::Analysis => Some("pragma:analysis"),
        SectionKind::Questions => Some("pragma:questions"),
        SectionKind::Plan => Some("pragma:plan"),
        SectionKind::StepComplete(_) => Some("pragma:step_complete"),
        SectionKind::Report => Some("pragma:report"),
        SectionKind::Tests => Some("pragma:tests"),
        SectionKind::Closing => Some("pragma:closing"),
        SectionKind::None => None,
    }
}

fn split_numbered_inline(text: &str) -> Vec<String> {
    let mut steps: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut n: u32 = 2;
    let mut remaining = text;
    loop {
        let needle = format!(" {n}. ");
        if let Some(pos) = remaining.find(&needle) {
            current.push_str(&remaining[..pos]);
            if !current.trim().is_empty() {
                steps.push(current.trim().to_string());
            }
            current = format!("{n}. ");
            remaining = &remaining[pos + needle.len()..];
            n += 1;
        } else {
            current.push_str(remaining);
            if !current.trim().is_empty() {
                steps.push(current.trim().to_string());
            }
            break;
        }
    }
    if steps.is_empty() && !text.trim().is_empty() {
        steps.push(text.trim().to_string());
    }
    steps
}

#[cfg(test)]
mod tests {
    use super::*;
    use pragma_parser::types::OutputSource;

    fn atom(atom_type: AtomType, content: &str) -> Atom {
        Atom {
            id: uuid::Uuid::new_v4(),
            atom_type,
            file_path: None,
            file_type: None,
            action: None,
            content: content.to_string(),
            collapsed: false,
            source: OutputSource::Stdout,
            received_at: chrono::Utc::now(),
            session_id: uuid::Uuid::nil(),
        }
    }

    fn note(content: &str) -> Atom {
        atom(AtomType::AgentNote, content)
    }

    /// The whole turn: the events of each atom plus those from the closing.
    fn run(notes: &[&str], truncated: bool) -> Vec<ProtocolEvent> {
        let mut p = ProtocolParser::new();
        let mut out: Vec<ProtocolEvent> = notes.iter().flat_map(|n| p.feed(&note(n))).collect();
        let atoms: Vec<Atom> = notes.iter().map(|n| note(n)).collect();
        out.extend(p.finish(last_agent_note(&atoms), truncated));
        out
    }

    fn names(evs: &[ProtocolEvent]) -> Vec<&'static str> {
        evs.iter().map(|e| e.name).collect()
    }

    fn payload<'a>(evs: &'a [ProtocolEvent], name: &str) -> Option<&'a serde_json::Value> {
        evs.iter()
            .rev()
            .find(|e| e.name == name)
            .map(|e| &e.payload)
    }

    #[test]
    fn a_normal_turn_emits_sections_phase_and_a_terminal_turn_end() {
        let evs = run(
            &["ANALYSIS:\nServe un modulo.\nPLAN:\n1. Uno\n2. Due\nAWAITING_CONFIRMATION"],
            false,
        );
        assert_eq!(
            names(&evs),
            [
                "pragma:analysis",
                "pragma:plan",
                "pragma:phase",
                "pragma:turn_end"
            ]
        );
        assert_eq!(
            payload(&evs, "pragma:plan").unwrap()["steps"],
            serde_json::json!(["1. Uno", "2. Due"])
        );
        assert_eq!(
            payload(&evs, "pragma:turn_end").unwrap(),
            &serde_json::json!({ "terminal": true, "truncated": false })
        );
    }

    #[test]
    fn a_section_opened_in_one_atom_is_filled_by_the_next() {
        let evs = run(&["REPORT:", "Fatto tutto.", "AWAITING_CLOSE"], false);
        assert_eq!(
            payload(&evs, "pragma:report").unwrap()["text"],
            "Fatto tutto."
        );
    }

    #[test]
    fn markers_glued_to_prose_are_split_off() {
        // Real cases seen in the DB: «Done. STEP_COMPLETE: 11 (…)».
        let evs = run(
            &["Done. STEP_COMPLETE: 3 — Blocco B. STEP_COMPLETE: 4 — Blocco C.\nAWAITING_CONFIRMATION"],
            false,
        );
        let steps: Vec<_> = evs
            .iter()
            .filter(|e| e.name == "pragma:step_complete")
            .map(|e| e.payload["step"].as_u64().unwrap())
            .collect();
        assert_eq!(steps, [3, 4]);
    }

    #[test]
    fn markers_inside_a_code_fence_are_content_not_markers() {
        let evs = run(
            &["ANALYSIS:\nIl file conterrà:\n```\nPLAN:\nAWAITING_CONFIRMATION\n```\nCLOSING:\nOk.\nAWAITING_CLOSE"],
            false,
        );
        assert!(!names(&evs).contains(&"pragma:plan"));
        let phases: Vec<_> = evs
            .iter()
            .filter(|e| e.name == "pragma:phase")
            .map(|e| e.payload.clone())
            .collect();
        assert_eq!(phases, [serde_json::json!("awaiting_close")]);
        assert!(payload(&evs, "pragma:analysis").unwrap()["text"]
            .as_str()
            .unwrap()
            .contains("AWAITING_CONFIRMATION"));
    }

    #[test]
    fn an_unclosed_fence_does_not_silence_the_next_atom() {
        let evs = run(
            &[
                "ANALYSIS:\n```\ncodice senza chiusura",
                "PLAN:\n1. Uno\nAWAITING_CONFIRMATION",
            ],
            false,
        );
        assert!(names(&evs).contains(&"pragma:plan"));
    }

    #[test]
    fn a_turn_without_markers_is_saved_as_raw_note_and_is_not_terminal() {
        // The model asks in prose which option to pick and stops.
        let evs = run(&["Ci sono tre strade: A, B o C. Quale preferisci?"], false);
        assert_eq!(names(&evs), ["pragma:raw_note", "pragma:turn_end"]);
        assert_eq!(payload(&evs, "pragma:turn_end").unwrap()["terminal"], false);
    }

    #[test]
    fn the_raw_note_is_the_last_note_of_the_turn_not_of_the_last_batch() {
        // The earlier bug: the fallback read an already-emptied batch.
        let atoms = [
            note("prima nota del turno, abbastanza lunga"),
            atom(AtomType::ToolUse, "Read x"),
            note("ultima nota, quella da recuperare"),
        ];
        assert_eq!(
            last_agent_note(&atoms),
            Some("ultima nota, quella da recuperare")
        );
        assert_eq!(last_agent_note(&[atom(AtomType::ToolUse, "Read x")]), None);
    }

    #[test]
    fn a_short_answer_without_markers_is_not_worth_a_card() {
        let evs = run(&["Ok."], false);
        assert_eq!(names(&evs), ["pragma:turn_end"]);
    }

    #[test]
    fn a_truncated_turn_still_shows_what_it_had_but_says_so() {
        // Process dead mid-REPORT (usage limit): the section comes out, the turn is marked.
        let evs = run(&["REPORT:\nHo modificato"], true);
        assert!(names(&evs).contains(&"pragma:report"));
        assert_eq!(
            payload(&evs, "pragma:turn_end").unwrap(),
            &serde_json::json!({ "terminal": false, "truncated": true })
        );
    }

    #[test]
    fn cumulative_streaming_does_not_emit_the_same_payload_twice() {
        let evs = run(
            &["ANALYSIS:\nUno", "ANALYSIS:\nUno", "AWAITING_CLOSE"],
            false,
        );
        assert_eq!(
            names(&evs)
                .iter()
                .filter(|n| **n == "pragma:analysis")
                .count(),
            1
        );
    }

    fn grouped(lines: &[&str]) -> Vec<(String, Vec<String>)> {
        group_questions(&lines.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    fn q(text: &str, options: &[&str]) -> (String, Vec<String>) {
        (
            text.to_string(),
            options.iter().map(|s| s.to_string()).collect(),
        )
    }

    #[test]
    fn numbered_questions_keep_their_options() {
        // Real case: numbered question, options as items underneath.
        assert_eq!(
            grouped(&[
                "1. **How do you want to handle step A?** Three options:",
                "   - **(a)** Run A first",
                "   - **(b)** Run A and B back to back",
                "2. Did you attach the document from the root folder?",
            ]),
            [
                q(
                    "**How do you want to handle step A?** Three options:",
                    &["**(a)** Run A first", "**(b)** Run A and B back to back"]
                ),
                q("Did you attach the document from the root folder?", &[]),
            ]
        );
    }

    #[test]
    fn lettered_options_without_a_dash_are_options_too() {
        assert_eq!(
            grouped(&["1. Quale provider?", "(a) Ollama locale", "b) Claude"]),
            [q("Quale provider?", &["(a) Ollama locale", "b) Claude"])]
        );
    }

    #[test]
    fn a_repeated_number_is_stripped_once_and_for_all() {
        assert_eq!(grouped(&["1. 1. Confermi?"]), [q("Confermi?", &[])]);
    }

    #[test]
    fn without_numbers_each_bullet_is_a_question() {
        // The protocol format of earlier versions.
        assert_eq!(
            grouped(&["- Primo dubbio?", "- Secondo dubbio?"]),
            [q("Primo dubbio?", &[]), q("Secondo dubbio?", &[])]
        );
    }

    #[test]
    fn a_block_of_prose_stays_one_question() {
        // Caso reale (30d93a82): una proposta di decisione in paragrafi.
        assert_eq!(
            grouped(&[
                "**D-28 — Chi legge la casella**",
                "Coerente con D-24.",
                "*Caselle*: tre account IMAP."
            ]),
            [q(
                "**D-28 — Chi legge la casella**\nCoerente con D-24.\n*Caselle*: tre account IMAP.",
                &[]
            )]
        );
    }

    #[test]
    fn the_questions_payload_is_structured() {
        let evs = run(
            &["QUESTIONS:\n1. Formato?\n   - CSV\n   - JSON\n2. Serve la CLI?\nAWAITING_ANSWERS"],
            false,
        );
        assert_eq!(
            payload(&evs, "pragma:questions").unwrap(),
            &serde_json::json!({ "items": [
                { "text": "Formato?", "options": ["CSV", "JSON"] },
                { "text": "Serve la CLI?", "options": [] },
            ]})
        );
    }

    #[test]
    fn finish_resets_the_turn_state() {
        let mut p = ProtocolParser::new();
        p.feed(&note("ANALYSIS:\nx\nAWAITING_CLOSE"));
        p.finish(None, false);
        let second = p.finish(None, false);
        assert_eq!(second.last().unwrap().payload["terminal"], false);
    }
}
