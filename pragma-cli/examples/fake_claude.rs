//! A stand-in for the `claude` binary, for E2E runs that must exercise the real app without
//! spending a single token.
//!
//! It does two things: appends the arguments it was started with, as one JSON array per line, to
//! the file named by `FAKE_CLAUDE_LOG`; and prints the smallest stream Pragma's parser accepts —
//! one plain assistant message (no protocol markers) and a successful result — then exits.
//!
//! A scripted reply instead: if an argument contains
//! `[[fake:NAME]]` and `FAKE_CLAUDE_REPLIES` names a directory, the message text is the content of
//! `NAME.txt` in it. The token goes in the prompt, so each session of a spec picks its own reply.
//!
//! Or a queue: if `FAKE_CLAUDE_QUEUE` names a directory, each call takes the lowest-numbered
//! `N.txt` in it as its reply and deletes it, so a script can play a whole conversation without
//! putting a token in the prompt (the screenshot script does this).
//!
//! Build: `cargo build -p pragma-cli --example fake_claude`.

use std::io::Write;

/// JSON string literal for `s` (enough for argv: quotes, backslashes and control characters).
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if let Ok(path) = std::env::var("FAKE_CLAUDE_LOG") {
        let line = format!(
            "[{}]\n",
            args.iter()
                .map(|a| json_string(a))
                .collect::<Vec<_>>()
                .join(",")
        );
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = f.write_all(line.as_bytes());
        }
    }

    let text = queued_reply()
        .or_else(|| scripted_reply(&args))
        .unwrap_or_else(|| "fake claude reply".to_string());
    let text = json_string(&text);
    let usage = r#"{"input_tokens":1,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}"#;
    // `--output-format json` (the one-shot calls, e.g. VERIFY's classifier) is the result alone.
    if !args.windows(2).any(|w| w == ["--output-format", "json"]) {
        println!(
            r#"{{"type":"assistant","message":{{"model":"fake","content":[{{"type":"text","text":{text}}}],"usage":{usage}}}}}"#
        );
    }
    println!(
        r#"{{"type":"result","subtype":"success","is_error":false,"result":{text},"total_cost_usd":0.0,"usage":{usage}}}"#
    );
}

/// The next reply of the queue in `$FAKE_CLAUDE_QUEUE`: the `N.txt` with the lowest `N`, consumed.
fn queued_reply() -> Option<String> {
    let dir = std::path::PathBuf::from(std::env::var_os("FAKE_CLAUDE_QUEUE")?);
    let mut files: Vec<(u64, std::path::PathBuf)> = std::fs::read_dir(&dir)
        .ok()?
        .filter_map(|e| {
            let path = e.ok()?.path();
            let n = path.file_stem()?.to_str()?.parse().ok()?;
            (path.extension()? == "txt").then_some((n, path))
        })
        .collect();
    files.sort();
    let (_, path) = files.into_iter().next()?;
    let text = std::fs::read_to_string(&path).ok()?;
    std::fs::remove_file(&path).ok()?;
    Some(text)
}

/// The reply named by `[[fake:NAME]]` in the arguments, read from `$FAKE_CLAUDE_REPLIES/NAME.txt`.
/// A continuation turn (`--resume`, after the user or auto-confirm said "continue") carries no
/// token: it gets `resume.txt`, if there is one.
fn scripted_reply(args: &[String]) -> Option<String> {
    let dir = std::env::var_os("FAKE_CLAUDE_REPLIES")?;
    let token = args.iter().find_map(|a| {
        let start = a.find("[[fake:")? + "[[fake:".len();
        let end = a[start..].find("]]")? + start;
        Some(a[start..end].to_string())
    });
    let name = match token {
        Some(n) => n,
        None if args.iter().any(|a| a == "--resume") => "resume".to_string(),
        None => return None,
    };
    std::fs::read_to_string(std::path::Path::new(&dir).join(format!("{name}.txt"))).ok()
}
