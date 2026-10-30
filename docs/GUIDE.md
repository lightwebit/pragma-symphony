# Guide

How to use Pragma Symphony, from the first session to the quality gates.

## The window

```
┌───────────────────────────────────────────────────────────────┐
│ Header: project · working dir · model tools · session actions │
├──────────────┬──────────────────────────┬─────────────────────┤
│ Sessions     │ Stream                   │ Pragma              │
│ projects,    │ live atoms: tool calls,  │ analysis, plan,     │
│ history,     │ diffs, file changes,     │ report, tests,      │
│ search       │ notes                    │ review              │
└──────────────┴──────────────────────────┴─────────────────────┘
```

Drag the panel borders to resize them. Focus mode hides the noise and keeps the structured events.

## First run

1. Install and log in to Claude Code. Pragma detects the `claude` binary on your `PATH` and creates a profile.
2. Create a **project** and pick its working directory.
3. Press **+** and write what you want. `Ctrl+Enter` sends.

Before you start, read [what you should know](../README.md#what-you-should-know-before-using-it): sessions run without permission prompts.

## A session, phase by phase

| Phase | What happens | What you do |
|---|---|---|
| Analysis | Claude studies the task and the code | Read along |
| Questions | Claude asks what blocks it | Answer, or skip |
| Plan | A numbered plan appears | **Approve** or **Modify plan** |
| Running | Steps execute, atoms flow | Watch, or **Stop** |
| Confirmation | Claude pauses after the plan or a step | **Continue**, or let auto-confirm do it |
| Report | What was done, and the tests | Read |
| VERIFY | Your test command runs | Decide if it stays red |
| REVIEW | A separate session reviews the diff (if enabled) | **Fix** or **Accept** |
| Closing | Done | Continue, or start a new session |

**Auto-confirm** continues on its own after each pause, unless the turn asked a question or was cut short. **Step-by-step** stops after every step.

Writing a new prompt on a finished session continues it with its context. Press **+** to start fresh.

### If the cache has expired

Claude Code keeps context in a cache that expires. Resuming a large session after a pause rewrites it, which costs more. Pragma warns you and offers to start a new session from a short summary instead.

## Atoms

Everything Claude does becomes a typed atom in the stream.

| Atom | Meaning |
|---|---|
| FileTouch | A file was created, changed or deleted |
| Diff | The change itself, collapsed by default |
| ToolUse | A tool call and its parameters |
| Error | Something failed, always shown |
| AgentNote | Free text from Claude |
| UserReply | What you sent |
| PragmaEvent | A protocol marker such as PLAN or REPORT |

The left border colour tells the file type at a glance.

## Quality gates

### VERIFY

Set a **test command** in the project (for example `npm test`). After the report Pragma runs it for real and classifies the output.

The first run records existing failures as a baseline, and only *new* failures block. If tests fail, Claude gets up to two automatic attempts to fix them before the decision comes to you. A project without a test command skips this phase.

### REVIEW

If VERIFY is not red, Pragma opens a new Claude session, with no memory of the work, on the full diff. It runs on Opus by default.

- **Invariants:** write in the project what must always hold (contracts, conventions). The review checks them.
- **Sensitive paths:** globs for auth, secrets, filesystem and the like. If the diff touches one, the review adds a security pass. Without any, Pragma uses sensible defaults.
- **Fix** sends the findings back to the session, then reviews again, up to two rounds. **Accept** goes on and leaves the findings on record.

REVIEW needs a git repository with at least one commit. Pragma records the commit each session starts from, plus any uncommitted changes already there, and reviews exactly what the session changed. A review costs one extra Opus session: switch it off under *Git and review* in Settings. Optionally, *session branches* also give each session its own `pragma/<session-id>` branch, so a session is easy to discard.

A very large diff gets a banner suggesting a deeper manual review.

## Project tools

**E2E** keeps its files in `.autoTest/` in your project. Discovery proposes a runner and a command, you describe the scenarios in plain language, and generation runs as a normal session you can watch. E2E is never a gate: a red run blocks nothing.

**Live** runs a command you choose, such as a dev server or a build, with streaming output. Mark it long-running if it does not stop by itself.

**Pipeline** is an ordered list of local steps that stops at the first failure. A `verify` step uses the VERIFY baseline, so a repository with known failures can still go green.

## Organising work

- **Projects** group sessions. Selecting a project sets the working directory.
- **Parallel sessions** run on different working directories. The strip at the top of the list shows those on other projects.
- **Scheduled sessions:** open the composer, choose *Run later*. If the app was closed at that time, Pragma asks on the next start.
- **To-do:** a checklist per project, separate from sessions.
- **Attachments:** drop a file on the window. It is copied to `.pragmadocs/` in the working directory.
- **Export:** JSON or Markdown from the session panel, or `pragma export` from the CLI.

## Profiles and models

A profile is a `claude` binary, an optional config directory and an optional language. Add several in Settings to use different accounts.

Choose Sonnet, Opus or Fable per session in the composer's advanced tab. A long plan on Sonnet shows a suggestion to switch. Model ids can be changed under `models` in `~/.pragma/settings.json`.

A prompt file at `~/.pragma/prompts/<label>.txt` is added to every session of that profile.

## Web sharing

See [Web sharing](../README.md#web-sharing) for how to get an access key.

1. In Settings, turn on *Share sessions to web* and enter your key.
2. Press **share** in the header: the link is copied.
3. Open it on your phone. Stop sharing, or close Pragma, and the link dies.

To send commands from the phone, turn on *Allow commands from the web* and set a PIN of 4 to 12 digits. Five wrong PINs lock commands until you share again.

## Shortcuts

The full list is in the app, under **guide** in the header.
