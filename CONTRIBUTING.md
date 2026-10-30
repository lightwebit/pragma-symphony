# Contributing to Pragma Symphony

Pragma Symphony is a small personal project, developed by one person with Claude as an AI collaborator. Contributions are welcome, but it moves at a deliberate pace and PRs may take time to review.

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Rust | stable | https://rustup.rs |
| Node.js | 22 | https://nodejs.org |
| Claude Code | latest | https://claude.com/claude-code |

Claude Code must be installed and authenticated — Pragma spawns the `claude` binary at runtime.

System packages for each platform are listed in the [README](README.md#build-from-source).

## Development setup

```sh
git clone https://github.com/lightwebit/pragma-symphony.git
cd pragma-symphony
npm install
npm run tauri:dev
```

`tauri:dev` starts Vite with hot-reload and the Tauri dev window simultaneously.

## Project layout

```
pragma-parser/      Rust crate — parser, SQLite storage, settings
pragma-cli/         Rust crate — CLI wrapper binary
src-tauri/src/
  lib.rs            Tauri command handlers + app entry point
  protocol.rs       Pragma protocol state machine (markers → events)
  process.rs        Claude process spawning + stream_claude
  runner.rs         The single executor of project commands
  verify.rs         VERIFY phase
  review.rs         REVIEW phase
  e2e.rs            On-demand E2E
  live.rs           Live button
  pipeline.rs       Local pipeline
  scheduler.rs      Scheduled sessions
  session_locks.rs  One session per working directory
src/                Vue 3 frontend — components, Pinia stores, web bridge
.autotest/          Playwright component tests, WebdriverIO E2E
```

## Running tests

```sh
# Frontend (Vitest)
npm test

# Rust
cargo test --workspace

# Component tests (Playwright)
npm run test:ct

# End-to-end on the real app (WebdriverIO)
npm run e2e
```

The suites must pass before opening a PR. None of them spends Claude tokens.

## Code conventions

- **Rust**: `cargo clippy --workspace --all-targets -- -D warnings`; `cargo fmt` applied.
- **TypeScript/Vue**: no new TypeScript errors (`npx vue-tsc --noEmit`); no magic numbers (add constants to `src/PRAGMA_CONSTANTS.ts`).
- No new comments that just describe what the code does — only add a comment when the *why* is non-obvious.
- Keep the module split: logic in the appropriate `src-tauri/src/*.rs` module, thin wrappers in `lib.rs`.

- Changes to the database schema must be additive: existing databases are never reset.
- Comments, tests and UI text are in English.

## Opening an issue

Before opening a PR, open an issue describing the problem or feature. Small fixes (typos, one-line bugs) can skip this step.

## License

By contributing you agree that your work will be licensed under the [MIT License](LICENSE).
