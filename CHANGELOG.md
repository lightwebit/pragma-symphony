# Changelog

All notable changes to Pragma Symphony are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Pragma Symphony uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---
## [Unreleased]

---

## [2.0.0] — first open-source release

Pragma Symphony is now open source under the MIT licence, built from source: there are no prebuilt
binaries. The 1.2.1 and 1.3.0 changes below were never published on their own and ship in this release.

### Added

- **Pragma on the web.** Follow the Pragma running on your PC from a browser — your phone — at
  `noema.tools/pragma-symphony/live`. Off by default, and it needs a personal access key, available
  on request: turn on *Share sessions to web* in Settings, enter the key and
  press **share** in the header, which creates a link. The link works while you share and dies when
  you stop or close Pragma; nothing is stored on the server, which only relays what Pragma shows.
  The page keeps its own layout for phones (Sessions / Stream / Pragma tabs) and follows the PC live,
  including after the connection drops. Settings that name programs or folders never leave the PC.
- **Commands from the web**, separately switched on in Settings (*Allow commands from the web*) and
  protected by a PIN of 4 to 12 digits that only you know: start or resume a session, approve,
  modify the plan, answer questions, stop, Fix / Accept a review, and edit to-dos and scheduled
  sessions. The PC decides what runs and where (your Claude profile, the project's working
  directory); five wrong PINs lock commands until you share again. Sessions started this way run
  without permission prompts, like every Pragma session. Atoms written for such an action are
  marked *from web*.
- A backend guard that refuses a second turn on a session that already has a live `claude`
  process.
- Settings warns when a profile's Claude Code config sets a non-default `outputStyle`: the Pragma
  protocol has only been verified against the default style.

### Changed

- **MIT licence**, replacing the proprietary licence of the 1.x line. Comments, tests and all
  remaining Italian text are now in English.
- The privacy policy describes web sharing (v2.3): what passes through the relay, that none of
  it is stored, and how commands are protected. The first time you switch sharing on, Settings
  shows a short notice with a link to it.
- **Session branches are off by default.** One `pragma/<session-id>` branch per session piled up
  hundreds of identical branches. A `settings.json` that already sets `sessionBranchEnabled`
  keeps its value.

### Removed

- **Install confirmation ping.** Pragma no longer sends anything to noema.tools on first launch.
- **Morphē handoff**: the banner and the project graph field. Existing data is left in place.
- **Per-project briefing (Lexis v2)** and everything around it: the `briefingEnabled` setting, the
  header chip, the composer's "No briefing" switch, `pragma briefing`, the `BRIEFING_DELTA:`
  section and the `e2e:briefing*` suites. It shipped off by default in 1.2.0 because measuring it
  showed no saving. The `briefings` and `briefing_events` tables stay in existing databases,
  unused; nothing is dropped.
- **Save session.** The header's "save" button and `pragma save` marked a flag that no list ever
  read: every session that ran was already listed. Sessions stay listed until deleted.

### Fixed

- **Auto-approve could race a fresh turn against the tail of the one before it.** The auto-approve
  timer started at the `AWAITING_CONFIRMATION` marker, which can arrive while the model is still
  writing; if that turn's process took longer than the timer, its completion landed after the
  Continue already sent, briefly marking the session idle while a second turn was in fact running.
  Auto-approve now waits for the turn to actually finish before it starts its countdown.

---

## [1.2.0] — 2026-09-21

### Added

- **Parallel sessions.** The session store is a map keyed by session id, and every event carries
  its `sessionId`, so several sessions can run at once (on different projects). A working
  directory accepts one active session at a time.
- **Session branches.** In a git working directory a new session starts on its own
  `pragma/<session-id>` branch (Settings → session branches, on by default).
- **Test and review after a session.** After the REPORT, Pragma runs the project's test command
  (VERIFY) and compares it with the state before the session; only if nothing regressed does a
  separate model review the diff (REVIEW), with Fix / Accept. Large diffs get a DEEP REVIEW
  banner and changes to sensitive paths (declared per project, or a default list) are flagged.
- **End-to-end button.** A popup with a catalogue of runners, per-project command and spec, a
  timeout, and a way to kill the run.
- **Live and Pipeline.** Projects have a category and a stack. The Live button runs the
  project's own command on demand; the Pipeline popup runs a local pipeline with a VERIFY step.
- **Scheduled sessions.** A prompt and a date and time; the session starts by itself.
- **Project checklist.** A TODO list per project (`todos` table), from a button in the header.
- **End-of-session sound** (`soundEnabled`, Settings) and the **model used** stored for every
  session (`sessions.model`, shown as a badge in the list).
- **Per-project briefing** (Lexis v2), **experimental and off by default** — switch it on with
  `"briefingEnabled": true` in `~/.pragma/settings.json`. Pragma keeps a compiled, budgeted
  (1,500 tokens) summary of
  each project in `pragma.db` (schema v14, additive) and, at the start of a new session, injects it
  as a system prompt in place of the model re-reading the project's state documents. The session
  always shows a `BRIEFING` line saying what happened (injected with version and size, stale, none,
  unreadable); a missing or unreadable briefing never stops a session. `pragma briefing
  show|history|publish --project <slug>` manages it from the command line. Each start is recorded in
  `briefing_events`, and `npm run metrics` (`tools/metrics/`) reports token cost per session and per
  briefing group. It ships off because measuring it on real work showed no saving: without it a
  session already reaches its plan in a handful of targeted reads.
- **Briefing status chip and per-session "No briefing" switch** (only with the briefing enabled).
  The header shows what the next
  session of the current project will receive (version and size, stale, or none). The composer's
  advanced settings have a "No briefing" switch that starts one session without the briefing and
  records it as `disabled`, so sessions with and without it can be compared. Scheduled sessions
  always get the briefing.
- **Briefing clause.** With a current briefing, the session is told not to open the state
  documents it summarizes just to get its bearings, except to change them, to find a detail the
  briefing says it lacks, or when the briefing contradicts the code. A stale briefing gets no such
  permission. Sessions without a briefing get exactly the same system prompt as before.
  `npm run e2e:briefing-real` checks it with three real sessions (spends tokens).
- **Briefing updates itself.** A session that received the briefing closes with a
  `BRIEFING_DELTA:` (the sections its work changed, or `none`), and Pragma publishes the next
  version once that reply is safely stored; the session shows the result. A session that does
  work and closes without one, or whose update is too large or malformed, leaves the briefing
  marked stale, and the next session rebuilds it from the documents. Every tenth version is
  recompiled from the documents. Sessions run with "No briefing" update it at the very end,
  without seeing it while they work. `npm run e2e:briefing-real -- chain` runs three real sessions
  in a row.
- `docs/CLI.md` — full `pragma-cli` command reference (`run` / `save` / `history` / `export`,
  the automatic `CLI` project, database location). The README's CLI section now links to it
  instead of duplicating the flag table.
- Unit tests for `ModelIds::resolve` (`pragma-parser/src/settings.rs`) covering a pre-`models`
  `settings.json` falling back to defaults, and for `slugify` / `unique_slug`
  (`pragma-parser/src/storage.rs`) covering accented/special-character titles and slug
  collisions.

### Fixed

- **Token counts and cost of resumed sessions.** `claude -p --resume` reports only its own turn,
  and Pragma overwrote the session's totals with it, so a session that was continued (or had its
  briefing update shortened, or was resumed after a pause) kept only the last turn's tokens. Each
  turn now adds to what is already stored; the cost, which the CLI reports for the whole session,
  is written as is. Sessions recorded before this stay as they were.
- A finished session no longer blocks the next one in the same working directory
  (`awaiting_close` was treated as active).
- Auto-approve no longer switches itself off after the first session of a run.
- `cargo fmt` and two `clippy` lints that were failing the CI.

### Changed

- `pragma-cli` (`main.rs`) user-facing strings (help text, usage/error messages) are now in
  English instead of Italian, matching the rest of the UI.

### Removed

- **The Lexis router integration** (`lexis_client.rs`, the `λ` header button, the Lexis section of
  Settings, `lexisEnabled` / `lexisUrl` / `lexisTimeoutSecs`, the `~/.pragma/lexis_pending/` retry
  queue). It was optional and off by default. With it goes the only path by which prompts, user
  replies and session atoms could leave the machine for a configurable server: **no session content
  is sent anywhere any more**. An existing `settings.json` that still carries the three old keys
  loads normally and the keys are dropped at the next save. Cross-session context is being rebuilt
  inside Pragma itself (a compiled per-project briefing in `pragma.db`), with no server involved.
- The `is_loopback_url` fix listed above for this release is moot: the code it fixed is gone.

---

## [1.1.1] — 2026-07-14

### Fixed

- Footer legal links now point to `noema.tools/pragma-symphony/{terms,privacy}` (the Pragma
  Symphony v2.0 EULA/policy pages) instead of the old `pragma/{terms,privacy,license}` MIT-era
  pages. The "License" link was removed for now — no standalone license page exists yet for
  Pragma Symphony.

---

## [1.1.0] — 2026-07-09

First release after the open-source line. Version `1.0.0` is the frozen public
open-source snapshot; development continues here from `1.1.0`.

### Added

- **Projects** — sessions now belong to a project (title, slug, working directory, colour,
  optional Morphē reference). The session list, search, and export are scoped per project.
  Database schema v3.
- **Lexis integration** (optional, disabled by default) — when enabled in Settings, Pragma
  queries a Lexis server for prior context before a run and posts the finished session back
  to it, with a retry queue for failed deliveries. Configurable URL, timeout, and a health
  check in the Settings panel.
- **Morphē handoff detection** — handoff files found in the working directory are offered as
  a ready-made prompt.
- **Fable model** — third option in the composer's Advanced form, alongside Sonnet and Opus.
  `PlanCard` proposes both Opus and Fable when a plan exceeds five steps.
- **Configurable model ids** — the `models` key in `~/.pragma/settings.json` maps each UI
  alias to the id passed to `--model`, so a new model can be adopted without a rebuild.

### Changed

- The **Opus** alias now resolves to `claude-opus-4-8` (previously `claude-opus-4-7`).
- Renamed the application from **Pragma** to **Pragma Symphony**. The bundle identifier
  (`com.noema.pragma`), the crate names, and the `~/.pragma` data directory are unchanged, so
  existing installations upgrade in place and keep their sessions.

### Fixed

- `pragma run` (CLI) no longer fails after the schema v3 migration: command-line sessions are
  recorded under a dedicated **CLI** project, created on first use.

### Privacy

- Pragma stores sessions locally in `~/.pragma/pragma.db` and sends nothing over the network
  on its own. The only outbound traffic is the Lexis integration, which is **off by default**;
  when enabled, prompts and session atoms are sent to the configured `lexisUrl`. Plain HTTP is
  permitted only for loopback addresses.

---

## [0.2.0] — never published

Superseded by `1.1.0`. The rename to **Pragma Symphony** shipped as part of that release.

---

## [0.1.0] — 2026-05-02

First complete release.

### Added

**Core protocol**
- Pragma protocol: structured phases ANALYSIS / QUESTIONS / PLAN / STEP_COMPLETE / REPORT / TESTS / CLOSING
- `PragmaEmitState` — per-session state machine with streaming deduplication and implicit-analysis fallback
- Protocol injected via `--append-system-prompt` + `<pragma>` prefix in user message for reliable compliance
- Typed atom stream: `FileTouch`, `Diff`, `ToolUse`, `Error`, `AgentNote`, `UserReply`, `PragmaEvent`

**UI — three-panel layout**
- Left panel: session list with search (FTS5), save/delete/duplicate, "running…" indicator
- Center panel: `AnalysisCard`, `QuestionsCard`, `PlanCard`, `TestsCard`, `ReportCard`, `ClosingCard` — collapsible with CSS grid animation
- Right panel: raw atom stream (`AtomStream.vue`) with per-atom expand/collapse
- Resizable panels (drag handle), persistent widths via localStorage
- Dark / light theme toggle, persisted across sessions
- Focus mode — filters noise, shows only structured pragma events
- Token counter live in header during active session

**Sessions**
- Multi-turn sessions with `--resume` / `--session-id`
- Session context card shown on resume
- New session on `+` button or `ClosingCard` confirm
- Guard prompt when switching away from a running session
- SQLite storage (WAL + FTS5) in `~/.pragma/pragma.db`
- Full-text search across session history
- Save / delete / duplicate from session list
- Session title auto-set from first prompt; editable

**Profiles**
- Multiple profiles with independent binary path, config dir, language preference
- Default profile (★) selector
- Model selection per-session: Sonnet (default) or Opus

**File attachments**
- File picker + drag-and-drop overlay
- Files copied to `{workingDir}/pragmadocs/` and passed via `--add-dir`
- Attachment chips in composer; red chip if file missing at resume
- Attachments persisted in DB per session

**Working directory**
- Directory picker with auto-open on first attach
- Trust store (`~/.pragma/trusted_dirs.json`) — explicit approval before use
- `pragmadocs/` subdirectory created automatically

**Export**
- Export session as JSON (UI button + CLI `pragma export`)
- Export session as Markdown (UI button, writes to configured export directory)
- Export directory configurable in settings (default: `~/Downloads`)
- Toast notification on export success

**Usage**
- `/usage` command via PTY — reads Claude Code's interactive usage screen
- Structured JSON output with three sections: current session, current week, extra usage
- Progress bars with warning/danger thresholds in modal UI
- Auto-confirm trust prompt; 20 s hard timeout

**Settings**
- Settings panel (Ctrl+S): binary path, config dir, language, export dir, profile management
- Auto-detect `claude` binary on startup
- Prompt files stored externally in `~/.pragma/prompts/<label>.txt`
- `diffAlwaysOpen` toggle

**Notifications**
- Desktop notifications via `tauri-plugin-notification`
- Permission requested lazily on first session completion (not at startup)

**Keyboard shortcuts**
- Ctrl+Enter — submit prompt
- Ctrl+S — open settings
- Esc — close composer / modal

### Security

- Binary path validated before spawn (rejects empty, `..` traversal, non-existent absolute paths)
- TOCTOU pre-check removed from attachment copy — `canonicalize()` used instead
- Session titles and attachment filenames sanitized (control chars stripped, 200-char limit)
- Only `http://` and `https://` URIs allowed in `open_url`
- Raw error details emitted only to `session:debug` channel; user-facing errors are structured codes
- DB file permissions restricted to owner on first open: `icacls` (Windows) / `chmod 700` (Unix)
- Working-directory trust store — `--dangerously-skip-permissions` gated on explicit user approval

### Infrastructure

- Tauri v2 desktop shell (Windows primary target; macOS / Linux path prepared)
- Single-instance guard via `tauri-plugin-single-instance`
- SQLite schema versioning + migration runner (`schema_version` table)
- `pragma-parser` and `pragma-cli` as independent Rust crates in a Cargo workspace
- `pragma-parser/src/lib.rs` split into `protocol.rs`, `process.rs`, `files.rs`, `usage.rs`, `trust.rs`
- `PRAGMA_CONSTANTS.ts` — all frontend magic numbers extracted
- Test coverage: 11 Vitest (atom filter), 6 Rust tauri (sanitize + copy), 4 Rust parser (storage round-trip)
- CI: GitHub Actions — frontend (type-check + Vitest + Vite build) + Rust (fmt + clippy + test, full workspace)
- MIT license, README, CONTRIBUTING

[0.1.0]: https://github.com/lightwebit/pragma-symphony/releases/tag/v0.1.0
