use pragma_parser::{
    parser::Parser,
    storage::{
        cache_snapshot_from_usage, load_session_usage,
        update_session_attachments as db_update_session_attachments, update_session_cache,
        update_session_usage, SqliteSink, Usage,
    },
    types::{Atom, AtomSink, AtomType, OutputSource},
};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::Mutex as TokioMutex;
use uuid::Uuid;

use crate::events::emit_session;
use crate::protocol::{last_agent_note, ProtocolEvent, ProtocolParser};

fn emit_protocol(app: &AppHandle, sid: &str, events: Vec<ProtocolEvent>) {
    for ev in events {
        emit_session(app, ev.name, sid, ev.payload);
    }
}

// ---------------------------------------------------------------------------
// UTF-16 LE/BE / UTF-8 BOM / plain UTF-8 decoder
// ---------------------------------------------------------------------------

pub fn decode_bytes(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let shorts: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        return String::from_utf16_lossy(&shorts).to_string();
    }
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let shorts: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_be_bytes(*c))
            .collect();
        return String::from_utf16_lossy(&shorts).to_string();
    }
    if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        return String::from_utf8_lossy(&bytes[3..]).to_string();
    }
    String::from_utf8_lossy(bytes).to_string()
}

// ---------------------------------------------------------------------------
// Binary path validation
// ---------------------------------------------------------------------------

pub fn validate_binary_path(binary: &str) -> Result<(), String> {
    if binary.trim().is_empty() {
        return Err("binary path is empty".to_string());
    }
    let p = std::path::Path::new(binary);
    if p.is_absolute() {
        if p.components().any(|c| c == std::path::Component::ParentDir) {
            return Err(format!("binary path contains '..': {binary}"));
        }
        if !p.exists() {
            return Err(format!("binary not found: {binary}"));
        }
        if !p.is_file() {
            return Err(format!("binary path is not a file: {binary}"));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Structured error emission
// ---------------------------------------------------------------------------

pub fn emit_error(
    app: &AppHandle,
    session_id: &str,
    code: &'static str,
    message: impl Into<String>,
    raw: impl std::fmt::Display,
) {
    let _ = app.emit("session:debug", format!("[error:{code}] {raw}"));
    emit_session(
        app,
        "session:error",
        session_id,
        serde_json::json!({ "code": code, "message": message.into() }),
    );
}

// ---------------------------------------------------------------------------
// Shared streaming core — used by run_pragma and send_control commands
// ---------------------------------------------------------------------------

/// Returns `true` if a REPORT: was emitted during this stream and the turn ended
/// cleanly — used by run_pragma to decide whether to launch the VERIFY phase.
#[allow(clippy::too_many_arguments)]
pub async fn stream_claude(
    app: AppHandle,
    session_id: Uuid,
    binary: String,
    project_id: String,
    extra_args: Vec<String>,
    working_dir: Option<String>,
    config_dir: Option<String>,
    db_command: Option<String>,
    db_title: Option<String>,
    // Alias of the first turn's model ('sonnet'/'opus'/'fable'), written to
    // `sessions.model` only when SqliteSink::new creates the row (never on resume,
    // where `db_command`/`db_title` are already None for the same reason).
    model: Option<String>,
    attachments: Vec<String>,
    resume: bool,
    skip_permissions: bool,
    sessions: Arc<TokioMutex<HashMap<String, tokio::process::Child>>>,
    git_branch: Option<String>,
    git_base: Option<String>,
) -> bool {
    let sid = session_id.to_string();
    let mut parser = Parser::new(session_id);
    let mut pragma_state = ProtocolParser::new();
    // Outcome of the stream-json `result` event: `None` if it never arrived (process dead
    // before closing the turn), `Some(false)` if the CLI closed with an error.
    let mut result_ok: Option<bool> = None;
    let mut all_atoms: Vec<Atom> = Vec::new();
    let mut sqlite: Option<SqliteSink> = if resume {
        SqliteSink::open_existing(session_id).ok()
    } else {
        db_command.as_deref().and_then(|cmd| {
            SqliteSink::new(
                session_id,
                &project_id,
                Some(cmd),
                db_title.as_deref(),
                working_dir.as_deref(),
                git_branch.as_deref(),
                git_base.as_deref(),
                model.as_deref(),
            )
            .ok()
        })
    };
    if sqlite.is_some() && !attachments.is_empty() {
        let _ = db_update_session_attachments(&sid, &attachments);
    }
    // Tokens of the previous turns: the CLI reports only those of the turn, and writing them as
    // they were left a resumed session with the tokens of the last turn only.
    let usage_base = if resume {
        load_session_usage(&sid).unwrap_or_default()
    } else {
        Usage::default()
    };

    let mut cmd = tokio::process::Command::new(&binary);
    let mut base_args = vec!["--output-format", "stream-json", "--verbose", "-p"];
    if skip_permissions {
        base_args.push("--dangerously-skip-permissions");
    }
    cmd.args(&base_args)
        .args(&extra_args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());

    if let Some(ref dir) = working_dir {
        cmd.current_dir(dir);
        let pragmadocs = std::path::Path::new(dir).join(".pragmadocs");
        let _ = std::fs::create_dir_all(&pragmadocs);
        let pragmadocs_str = pragmadocs.to_string_lossy().into_owned();
        cmd.args(["--add-dir", &pragmadocs_str]);
    }
    if let Some(ref dir) = config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }

    if let Err(e) = validate_binary_path(&binary) {
        emit_error(
            &app,
            &sid,
            "ERR_BINARY_INVALID",
            "Binary path is invalid. Check the profile settings.",
            e,
        );
        return false;
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit_error(
                &app,
                &sid,
                "ERR_SPAWN_FAILED",
                "Could not start the Claude binary.",
                e,
            );
            return false;
        }
    };

    let stdout = child.stdout.take().expect("stdout pipe missing");
    let stderr = child.stderr.take().expect("stderr pipe missing");

    // The PID tells this turn's process apart from the next turn's, which registers
    // under the same session id (see `exited_ok`).
    let my_pid = child.id();
    sessions.lock().await.insert(sid.clone(), child);

    let app_err = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut buf = Vec::new();
        let mut reader = BufReader::new(stderr);
        let _ = reader.read_to_end(&mut buf).await;
        if !buf.is_empty() {
            let text = decode_bytes(&buf);
            let text = text.trim();
            if !text.is_empty() {
                let _ = app_err.emit("session:debug", format!("[stderr] {text}"));
            }
        }
    });

    let mut lines_iter = BufReader::new(stdout).lines();
    let mut batch: Vec<Atom> = Vec::new();
    let mut last_emit = std::time::Instant::now();
    let mut line_count = 0usize;

    while let Ok(Some(raw_line)) = lines_iter.next_line().await {
        let line = raw_line.trim_end_matches('\r').to_string();
        let _ = app.emit("session:debug", format!("[line] {:?}", line));
        line_count += 1;

        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            if v["type"].as_str() == Some("result") {
                result_ok = Some(
                    !v["is_error"].as_bool().unwrap_or(false)
                        && v["subtype"].as_str().is_none_or(|s| s == "success"),
                );
            }
            let usage_obj = match v["type"].as_str() {
                Some("result") => Some(&v["usage"]),
                Some("assistant") => Some(&v["message"]["usage"]),
                _ => None,
            };
            if let Some(u) = usage_obj {
                if u.is_object() {
                    let model = v["message"]["model"].as_str().unwrap_or("").to_string();
                    let cost = v["total_cost_usd"].as_f64();
                    let total = usage_base
                        + Usage {
                            input: u["input_tokens"].as_u64().unwrap_or(0),
                            output: u["output_tokens"].as_u64().unwrap_or(0),
                            cache_read: u["cache_read_input_tokens"].as_u64().unwrap_or(0),
                            cache_write: u["cache_creation_input_tokens"].as_u64().unwrap_or(0),
                        };
                    emit_session(
                        &app,
                        "session:usage",
                        &sid,
                        serde_json::json!({
                            "inputTokens":   total.input,
                            "outputTokens":  total.output,
                            "cacheReadTokens":     total.cache_read,
                            "cacheWriteTokens":    total.cache_write,
                            "model":         model,
                            "totalCostUsd":  cost,
                        }),
                    );
                    let _ = update_session_usage(&sid, total, cost);
                }
            }
            // Only `assistant`: it is a single call. The `result` usage is the sum of the turn.
            if v["type"].as_str() == Some("assistant") {
                if let Some(snap) = cache_snapshot_from_usage(&v["message"]["usage"]) {
                    let at = chrono::Utc::now().to_rfc3339();
                    let _ = update_session_cache(&sid, snap, &at);
                    emit_session(
                        &app,
                        "session:cache",
                        &sid,
                        serde_json::json!({
                            "contextTokens": snap.context_tokens,
                            "ttlSecs":       snap.ttl_secs,
                            "lastCallAt":    at,
                        }),
                    );
                }
            }
        }

        let atoms = parser.feed_line(&line, OutputSource::Stdout);
        batch.extend(atoms);

        let now = std::time::Instant::now();
        if now.duration_since(last_emit).as_millis() >= 50 && !batch.is_empty() {
            for atom in &batch {
                emit_protocol(&app, &sid, pragma_state.feed(atom));
                if atom.atom_type == AtomType::Error {
                    emit_error(
                        &app,
                        &sid,
                        "ERR_CLAUDE_RUNTIME",
                        atom.content.clone(),
                        &atom.content,
                    );
                }
            }
            emit_session(&app, "atoms:batch", &sid, &batch);
            if let Some(ref mut db) = sqlite {
                for atom in &batch {
                    db.push(atom.clone()).ok();
                }
            }
            all_atoms.append(&mut batch);
            last_emit = now;
        }
    }

    let _ = app.emit(
        "session:debug",
        format!("[stdout] {line_count} lines received"),
    );

    batch.extend(parser.finalize(&OutputSource::Stdout));
    if !batch.is_empty() {
        for atom in &batch {
            emit_protocol(&app, &sid, pragma_state.feed(atom));
            if atom.atom_type == AtomType::Error {
                // Same structured shape as the other branch: the frontend reads
                // `message`, a bare string here arrived as `undefined`.
                emit_error(
                    &app,
                    &sid,
                    "ERR_CLAUDE_RUNTIME",
                    atom.content.clone(),
                    &atom.content,
                );
            }
        }
        emit_session(&app, "atoms:batch", &sid, &batch);
        if let Some(ref mut db) = sqlite {
            for atom in &batch {
                db.push(atom.clone()).ok();
            }
        }
        all_atoms.append(&mut batch);
    }

    // Stdout is closed: we wait for the exit to know whether the turn really finished. Only the
    // process of *this* turn is removed from the map. Auto-confirm now waits for
    // `session:complete` and the manual buttons are disabled while the turn runs, so a
    // continuation turn registered under the same id while this one is alive should no longer
    // exist: the PID check stays as a defence. Removing someone else's process would make it
    // wait here and be marked truncated there. If our process is no longer there, the `result` event decides; one
    // stopped with stop stays in the map, killed, and exits unclean.
    let own = {
        let mut map = sessions.lock().await;
        let ours = my_pid.is_some() && map.get(&sid).and_then(|c| c.id()) == my_pid;
        if ours {
            map.remove(&sid)
        } else {
            None
        }
    };
    let exited_ok = match own {
        Some(mut c) => c.wait().await.is_ok_and(|s| s.success()),
        None => result_ok == Some(true),
    };
    let truncated = !exited_ok || result_ok != Some(true);
    emit_protocol(
        &app,
        &sid,
        pragma_state.finish(last_agent_note(&all_atoms), truncated),
    );
    // A REPORT emitted by a truncated turn is half-written: VERIFY and REVIEW must not start.
    let report_emitted = pragma_state.report_emitted() && !truncated;

    if let Some(ref mut db) = sqlite {
        db.finalize().ok();
    }

    emit_session(&app, "session:complete", &sid, serde_json::Value::Null);

    report_emitted
}
