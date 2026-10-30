use anyhow::Result;
use std::io::{self, Read};
use uuid::Uuid;

use pragma_parser::{
    parser::Parser,
    sink::StdoutSink,
    types::{AtomSink, OutputSource},
};

fn main() -> Result<()> {
    // Force UTF-8 on the Windows console
    #[cfg(windows)]
    set_console_utf8();

    let session_id = Uuid::new_v4();
    let mut parser = Parser::new(session_id);
    let mut sink = StdoutSink::new();

    // Reads stdin as raw bytes and converts to UTF-8 with a lossy fallback.
    // Needed on Windows, where the system codepage may not be UTF-8.
    let mut raw = Vec::new();
    io::stdin().read_to_end(&mut raw)?;
    let content = String::from_utf8_lossy(&raw);

    for line in content.lines() {
        // lines() handles both \n and \r\n
        let atoms = parser.feed_line(line, OutputSource::Stdout);
        for atom in atoms {
            sink.push(atom)?;
        }
    }

    // Flush any in-progress multi-line state at EOF
    let final_atoms = parser.finalize(&OutputSource::Stdout);
    for atom in final_atoms {
        sink.push(atom)?;
    }
    sink.finalize()?;

    // Print session metrics to stderr (doesn't pollute the NDJSON stdout)
    let m = &parser.metrics;
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
        eprintln!("           Patterns may be outdated.");
    }
    eprintln!("─────────────────────────────────────");

    Ok(())
}

/// Sets the Windows console codepage to UTF-8 (65001).
/// Without this, accented characters (à, è, ì, etc.) are
/// read with the system codepage (typically CP1252 in Western Europe).
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
