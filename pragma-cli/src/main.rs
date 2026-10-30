use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use uuid::Uuid;

use pragma_parser::{
    parser::Parser,
    sink::{FanOutSink, StdoutSink},
    storage::{
        create_project, export_session_json, list_all_sessions, list_projects, resolve_session_id,
        SqliteSink,
    },
    types::{AtomSink, OutputSource},
};

/// Slug of the project that collects sessions started from the command line.
/// Sessions require a project (non-null FK since schema v3).
const CLI_PROJECT_SLUG: &str = "cli";

fn main() {
    #[cfg(windows)]
    set_console_utf8();

    let args: Vec<String> = std::env::args().collect();

    match args.get(1).map(String::as_str) {
        Some("run") => cmd_run(&args),
        Some("history") => cmd_history(),
        Some("export") => cmd_export(&args),
        Some("--help") | Some("-h") | None => print_help(),
        Some(cmd) => {
            eprintln!("pragma: unknown command '{cmd}'");
            eprintln!("Use 'pragma --help'.");
            std::process::exit(1);
        }
    }
}

// ---------------------------------------------------------------------------
// pragma run -- <command> [args...]
// ---------------------------------------------------------------------------

fn cmd_run(args: &[String]) {
    let sep = args.iter().position(|a| a == "--");
    let cmd_args = match sep {
        Some(i) if i + 1 < args.len() => &args[i + 1..],
        _ => {
            eprintln!("Usage: pragma run -- <command> [args...]");
            std::process::exit(1);
        }
    };

    let cmd = &cmd_args[0];
    let cmd_rest = &cmd_args[1..];
    let command_str = cmd_args.join(" ");

    let session_id = Uuid::new_v4();
    let project_id = cli_project_id();

    // SqliteSink — salva su ~/.pragma/pragma.db
    let sqlite = SqliteSink::new(
        session_id,
        &project_id,
        Some(&command_str),
        None,
        None,
        None,
        None,
        None,
    )
    .unwrap_or_else(|e| {
        eprintln!("pragma: DB error: {e}");
        std::process::exit(1);
    });

    // FanOut: NDJSON to stdout + SQLite
    let mut sink: Box<dyn AtomSink> = Box::new(FanOutSink::new(vec![
        Box::new(StdoutSink::new()),
        Box::new(sqlite),
    ]));

    let mut parser = Parser::new(session_id);

    let mut child = Command::new(cmd)
        .args(cmd_rest)
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap_or_else(|e| {
            eprintln!("pragma: unable to start '{cmd}': {e}");
            std::process::exit(1);
        });

    let stdout = child.stdout.take().expect("missing stdout pipe");
    let reader = BufReader::new(stdout);

    for raw_line in reader.split(b'\n') {
        match raw_line {
            Ok(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                let line = line.trim_end_matches('\r');
                for atom in parser.feed_line(line, OutputSource::Stdout) {
                    sink.push(atom).ok();
                }
            }
            Err(_) => break,
        }
    }

    for atom in parser.finalize(&OutputSource::Stdout) {
        sink.push(atom).ok();
    }
    sink.finalize().ok();

    let status = child.wait().unwrap_or_else(|e| {
        eprintln!("pragma: error waiting for process: {e}");
        std::process::exit(1);
    });

    print_metrics(&parser, session_id);
    eprintln!(
        "  Run 'pragma history' to see this session, or 'pragma export {id}' to export it.",
        id = &session_id.to_string()[..8]
    );

    std::process::exit(status.code().unwrap_or(1));
}

// ---------------------------------------------------------------------------
// pragma history
// ---------------------------------------------------------------------------

/// Lists every session with at least one atom, not only the "saved" ones:
/// the save concept never really existed (see `list_all_sessions`).
fn cmd_history() {
    match list_all_sessions() {
        Ok(sessions) if sessions.is_empty() => {
            eprintln!("No sessions yet. Run 'pragma run -- <command>' first.");
        }
        Ok(sessions) => {
            eprintln!("{:<38} {:<25} {:>5}  command", "ID", "date", "atoms");
            eprintln!("{}", "─".repeat(80));
            for s in sessions {
                eprintln!(
                    "{:<38} {:<25} {:>5}  {}",
                    s.id,
                    &s.started_at[..19],
                    s.atom_count,
                    s.command.as_deref().unwrap_or("—"),
                );
            }
        }
        Err(e) => {
            eprintln!("pragma history: {e}");
            std::process::exit(1);
        }
    }
}

// ---------------------------------------------------------------------------
// pragma export <session-id>
// ---------------------------------------------------------------------------

fn cmd_export(args: &[String]) {
    let id_prefix = match args.get(2) {
        Some(id) => id,
        None => {
            eprintln!("Usage: pragma export <session-id>");
            std::process::exit(1);
        }
    };

    let full_id = match resolve_session_id(id_prefix) {
        Ok(id) => id,
        Err(e) => {
            eprintln!("pragma export: {e}");
            std::process::exit(1);
        }
    };
    match export_session_json(&full_id) {
        Ok(json) => println!("{json}"),
        Err(e) => {
            eprintln!("pragma export: {e}");
            std::process::exit(1);
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Returns the "CLI" project id, creating it on first run.
fn cli_project_id() -> String {
    let projects = list_projects().unwrap_or_else(|e| {
        eprintln!("pragma: DB error: {e}");
        std::process::exit(1);
    });

    if let Some(project) = projects.iter().find(|p| p.slug == CLI_PROJECT_SLUG) {
        return project.id.clone();
    }

    create_project(
        "CLI",
        Some("Sessions started via `pragma run`"),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .unwrap_or_else(|e| {
        eprintln!("pragma: unable to create the CLI project: {e}");
        std::process::exit(1);
    })
    .id
}

fn print_metrics(parser: &Parser, session_id: Uuid) {
    let m = parser.metrics();
    eprintln!("─────────────────────────────────────");
    eprintln!("  Pragma session summary");
    eprintln!("  session : {session_id}");
    eprintln!("  atoms   : {}", m.total);
    eprintln!("  ├─ file_touch : {}", m.file_touch);
    eprintln!("  ├─ diff       : {}", m.diff);
    eprintln!("  ├─ tool_use   : {}", m.tool_use);
    eprintln!("  ├─ error      : {}", m.error);
    eprintln!(
        "  └─ agent_note : {} ({:.1}%)",
        m.agent_note,
        m.agent_note_pct()
    );
    if m.agent_note_pct() > 40.0 {
        eprintln!();
        eprintln!(
            "  WARNING: High AGENT_NOTE rate ({:.1}%).",
            m.agent_note_pct()
        );
    }
    eprintln!("─────────────────────────────────────");
}

fn print_help() {
    eprintln!("Pragma — AI agent output atomizer");
    eprintln!();
    eprintln!("COMMANDS:");
    eprintln!("  pragma run -- <command> [args...]   Wraps and atomizes in real time");
    eprintln!("  pragma history                      Lists sessions run via 'pragma run'");
    eprintln!("  pragma export <session-id>          Exports a session as JSON to stdout");
    eprintln!();
    eprintln!("EXAMPLES:");
    eprintln!("  pragma run -- claude -p --output-format stream-json --verbose --dangerously-skip-permissions \"create hello.rs\"");
    eprintln!("  pragma history");
}

#[cfg(windows)]
fn set_console_utf8() {
    use std::os::raw::c_uint;
    extern "system" {
        fn SetConsoleCP(wCodePageID: c_uint) -> i32;
        fn SetConsoleOutputCP(wCodePageID: c_uint) -> i32;
    }
    unsafe {
        SetConsoleCP(65001);
        SetConsoleOutputCP(65001);
    }
}
