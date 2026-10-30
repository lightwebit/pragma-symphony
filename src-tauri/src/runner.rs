use serde::Serialize;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::oneshot;

/// Ceiling on waiting for the pumps after the direct process has died — both for
/// kill_tree (timeout/stop) and for a normal exit. A surviving descendant
/// (e.g. a background `&` the shell does not wait for) can keep the pipe open
/// well past the end of the process we track: without a ceiling even the most
/// common "clean" exit would hang on a grandchild nobody is waiting for any more.
/// This is not hypothetical: the case that made a Linux CI hang look suspicious
/// was exactly an exit with no timeout and no cancel.
const PUMP_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// The single executor of project commands.
//
// Before this module the same thing existed in three incomplete variants:
// e2e.rs (timeout + cancel, but output only at the end of the run), verify.rs (no
// timeout, no cancel) and process.rs (line-by-line streaming, but wired to
// Claude, the parser and the atoms). Every fix to how a process is killed
// had to be applied in different places — and in fact the tree kill
// was applied nowhere.
//
// Here there is a single place where a project command is launched, listened to,
// stopped and killed.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub enum RunMode {
    /// The command ends by itself (build, test, publish): the outcome is awaited, with
    /// a duration ceiling beyond which it is killed. Without the ceiling a stuck
    /// suite hangs with no remedy.
    OneShot { timeout_secs: u64 },
    /// No duration ceiling: either the command by nature never ends (dev server),
    /// or none is wanted. The only way to stop it is the cancel.
    Unbounded,
}

/// Recipient of the lines, called once per line while the command runs.
/// `None` on the `RunSpec` = no streaming, the output is only collected and
/// returned at the end of the run (the case of VERIFY, which never showed anything on
/// screen while running).
///
/// Deliberately a callback and not an `AppHandle`: emitting is the caller's problem,
/// not the executor's. Keeping Tauri's handle in here tied this module
/// to wry and the webview, and a test touching `run` was enough for the test
/// binary to stop loading (`STATUS_ENTRYPOINT_NOT_FOUND`, WebView2Loader.dll is missing
/// next to the test executables). A process executor has no reason to know what a
/// window is.
pub type LineSink = Arc<dyn Fn(RunLine) + Send + Sync>;

pub struct RunSpec<'a> {
    pub command: &'a str,
    pub working_dir: &'a str,
    pub mode: RunMode,
    pub on_line: Option<LineSink>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLine {
    pub line: String,
    /// Tells stderr from stdout: the UI can colour it, the classifier cannot —
    /// for it everything is a single stream.
    pub stderr: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOutcome {
    pub command: String,
    /// stdout and stderr interleaved in the order they arrived.
    pub output: String,
    /// `None` when the process was killed by timeout or cancel, or when it
    /// died from a signal.
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub duration_ms: u64,
}

impl RunOutcome {
    /// True only if the command reached the end by itself with exit code 0. A killed
    /// run is not a failure of the command but is not a success either: whoever
    /// has to decide (the fail-fast pipeline) does not need to tell them apart.
    ///
    /// The local pipeline relies on it: neither VERIFY nor E2E look at the exit code (both
    /// classify the output with a model call). It is covered by tests because the rule — a killed
    /// run is not green — is the kind of thing that gets wrong when written later.
    #[allow(dead_code)]
    pub fn success(&self) -> bool {
        !self.timed_out && !self.cancelled && self.exit_code == Some(0)
    }
}

// ---------------------------------------------------------------------------
// Killing the process tree
// ---------------------------------------------------------------------------

/// Kills the process **and all its descendants**.
///
/// tokio's `kill_on_drop` and `Child::kill` only kill the direct child — which
/// for us is always the shell (`cmd /c` or `sh -c`), not the program we care about.
/// With a one-shot the damage is contained; with a dev server it is not: `npm run dev` dies,
/// node stays hanging holding the port, and the next launch fails with
/// "port in use" with no clue why.
///
/// No Job Object on Windows on purpose: it would need the `windows` crate and
/// unsafe code for a benefit not needed here (surviving the death of
/// Pragma itself). `taskkill /T` covers the real case — timeout and user stop —
/// and is the same choice already made elsewhere in the project for `icacls`.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        // The child is a group leader (process_group(0) below): the negated PID points to
        // the whole group, so the signal also reaches the grandchildren. The `--` is
        // necessary: without it, some versions of `kill` read `-1234` as a
        // signal and fail, and the error here is deliberately ignored.
        let _ = std::process::Command::new("kill")
            .args(["-9", "--", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

// ---------------------------------------------------------------------------
// Lettura dell'output
// ---------------------------------------------------------------------------

/// Decodes a raw line without ever failing.
///
/// Deliberately *not* using `BufReader::lines()`: it demands valid UTF-8
/// and interrupts the stream with an error as soon as it meets a byte that is
/// not. Toolchains on Windows happily write in the local codepage (accents from
/// `dotnet` on a non-English machine), and losing the rest of a build's output
/// over an accent would be an absurd way to fail.
fn decode_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim_end_matches(['\n', '\r'])
        .to_string()
}

fn spawn_pump<R>(
    reader: R,
    is_stderr: bool,
    on_line: Option<LineSink>,
    sink: Arc<Mutex<String>>,
) -> tokio::task::JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let line = decode_line(&buf);
            if let Ok(mut collected) = sink.lock() {
                collected.push_str(&line);
                collected.push('\n');
            }
            if let Some(ref emit) = on_line {
                emit(RunLine {
                    line,
                    stderr: is_stderr,
                });
            }
        }
    })
}

fn shell_command(command: &str) -> tokio::process::Command {
    if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/c", command]);
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", command]);
        c
    }
}

// ---------------------------------------------------------------------------
// Esecuzione
// ---------------------------------------------------------------------------

/// Runs a project command in its working dir.
///
/// `cancel` is `None` for whoever has no way to stop the run. Deliberately an
/// `Option` and not an always-present receiver: a `oneshot::Receiver` whose
/// sender is dropped resolves **immediately**, and a caller that does not hold on to
/// the sender would see every run die instantly without understanding
/// why. This way that case cannot be expressed.
///
/// Returns `Err` only if the process did not even start. Everything else —
/// non-zero exit code, timeout, user stop — is a legitimate `RunOutcome`
/// with the output collected up to that moment: whoever stops a run still wants
/// to see what happened before.
pub async fn run(
    spec: RunSpec<'_>,
    cancel: Option<oneshot::Receiver<()>>,
) -> Result<RunOutcome, String> {
    let started = std::time::Instant::now();

    let mut cmd = shell_command(spec.command);
    cmd.current_dir(spec.working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not run `{}`: {e}", spec.command))?;

    // Needed before consuming the child in the wait: afterwards it is no longer reachable,
    // and without a PID there is no tree to kill.
    let pid = child.id();

    let stdout = child.stdout.take().expect("stdout pipe mancante");
    let stderr = child.stderr.take().expect("stderr pipe mancante");

    let collected = Arc::new(Mutex::new(String::new()));
    let out_pump = spawn_pump(stdout, false, spec.on_line.clone(), Arc::clone(&collected));
    let err_pump = spawn_pump(stderr, true, spec.on_line.clone(), Arc::clone(&collected));

    // The wait lives in its own block: it holds a mutable borrow of `child`, and
    // without closing it here the process could not be touched after the select.
    let (timed_out, cancelled, exit_code) = {
        let wait = child.wait();
        tokio::pin!(wait);

        // `Unbounded` has no deadline: a future that never completes leaves the
        // select waiting on the other two branches only.
        let deadline: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> =
            match spec.mode {
                RunMode::OneShot { timeout_secs } => Box::pin(tokio::time::sleep(
                    std::time::Duration::from_secs(timeout_secs),
                )),
                RunMode::Unbounded => Box::pin(std::future::pending::<()>()),
            };
        tokio::pin!(deadline);

        // Without a sender no stop is possible: a future that never completes
        // leaves the branch inert, instead of resolving immediately as an
        // orphaned receiver would.
        let stop: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> = match cancel {
            Some(rx) => Box::pin(async {
                let _ = rx.await;
            }),
            None => Box::pin(std::future::pending::<()>()),
        };
        tokio::pin!(stop);

        tokio::select! {
            status = &mut wait => {
                (false, false, status.ok().and_then(|s| s.code()))
            }
            _ = &mut deadline => {
                if let Some(pid) = pid {
                    kill_tree(pid);
                }
                (true, false, None)
            }
            _ = &mut stop => {
                if let Some(pid) = pid {
                    kill_tree(pid);
                }
                (false, true, None)
            }
        }
    };

    // The pumps finish when the pipes close — that is, when the process (and
    // after kill_tree its descendants too) is dead. Waiting for them here is what
    // guarantees the collected output is complete and not cut mid-line.
    if timed_out || cancelled {
        // The process may have survived the tree kill (permissions, PID already
        // recycled, `kill` failed): kill it directly BEFORE waiting for the
        // pumps, otherwise a still-living child keeps the pipe open and the wait never
        // ends. It also avoids a zombie hanging on our handle.
        let _ = child.kill().await;
    }
    // The ceiling also applies on a normal exit, not only on
    // kill_tree. `child.wait()` tracks only the direct process (the shell): a
    // descendant left in the background — `command &` with no `wait` in the
    // script — inherits the pipes and keeps them open even after the shell has
    // exited, so even the "clean" path can hang without a ceiling.
    // The output already read stays valid in every case.
    let _ = tokio::time::timeout(PUMP_DRAIN_TIMEOUT, async {
        let _ = out_pump.await;
        let _ = err_pump.await;
    })
    .await;

    let output = collected
        .lock()
        .map(|s| s.clone())
        .unwrap_or_else(|e| e.into_inner().clone());

    Ok(RunOutcome {
        command: spec.command.to_string(),
        output,
        exit_code,
        timed_out,
        cancelled,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A command that never ends, built with shell builtins only: neither
    /// `ping` nor `sleep` is guaranteed on the PATH of every build environment, and a
    /// test that relies on them fails for the wrong reason.
    fn never_ending_command() -> &'static str {
        if cfg!(windows) {
            "for /l %i in (0,0,1) do @rem"
        } else {
            "while true; do :; done"
        }
    }

    fn spec(command: &str, mode: RunMode) -> RunSpec<'_> {
        RunSpec {
            command,
            working_dir: ".",
            mode,
            on_line: None,
        }
    }

    #[test]
    fn decode_line_survives_invalid_utf8() {
        // An isolated 0xE8 byte = "è" in CP1252, not valid in UTF-8. It must degrade
        // to a replacement character, not break the read.
        let line = decode_line(&[b'b', b'u', b'i', b'l', b'd', b' ', 0xE8, b'\r', b'\n']);
        assert!(line.starts_with("build "));
        assert!(!line.contains('\r'));
        assert!(!line.contains('\n'));
    }

    #[test]
    fn decode_line_strips_windows_line_endings() {
        assert_eq!(decode_line(b"ciao\r\n"), "ciao");
        assert_eq!(decode_line(b"ciao\n"), "ciao");
        assert_eq!(decode_line(b"ciao"), "ciao");
    }

    #[tokio::test]
    async fn one_shot_honours_the_timeout() {
        let (_tx, rx) = oneshot::channel();
        let outcome = run(
            spec(never_ending_command(), RunMode::OneShot { timeout_secs: 1 }),
            Some(rx),
        )
        .await
        .unwrap();
        assert!(outcome.timed_out, "the long command must time out");
        assert!(!outcome.cancelled);
        assert!(!outcome.success());
    }

    #[tokio::test]
    async fn streams_each_line_to_the_sink_while_running() {
        // Streaming is the reason this module exists: without it, a long build
        // leaves the UI frozen until the end. That the lines arrive one by
        // one — and not all at once at the close — is the property to defend.
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);

        let outcome = run(
            RunSpec {
                command: "echo line-one & echo line-two",
                working_dir: ".",
                mode: RunMode::OneShot { timeout_secs: 30 },
                on_line: Some(Arc::new(move |l: RunLine| {
                    sink.lock().unwrap().push(l.line);
                })),
            },
            None,
        )
        .await
        .unwrap();

        assert!(outcome.success());
        let lines = seen.lock().unwrap().clone();
        assert!(
            lines.iter().any(|l| l.contains("line-one")),
            "lines seen: {lines:?}"
        );
        assert!(
            lines.iter().any(|l| l.contains("line-two")),
            "lines seen: {lines:?}"
        );
    }

    #[tokio::test]
    async fn captures_output_and_exit_code_of_a_fast_command() {
        let (_tx, rx) = oneshot::channel();
        let outcome = run(
            spec(
                "echo pragma-runner-ok",
                RunMode::OneShot { timeout_secs: 30 },
            ),
            Some(rx),
        )
        .await
        .unwrap();
        assert!(!outcome.timed_out);
        assert!(outcome.output.contains("pragma-runner-ok"));
        assert_eq!(outcome.exit_code, Some(0));
        assert!(outcome.success());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_backgrounded_grandchild_does_not_hang_a_clean_exit() {
        // The shell exits at once (no timeout, no cancel, kill_tree never
        // called) but leaves a background `&` without waiting for it — it inherits the
        // pipes and keeps them open well past the end of the tracked process. Before
        // the ceiling on this branch, `out_pump.await`/`err_pump.await` would
        // have hung until the grandchild ended (here 20s, far beyond
        // PUMP_DRAIN_TIMEOUT): the run had to stay bounded by the ceiling.
        let (_tx, rx) = oneshot::channel();
        let outcome = run(
            spec(
                "sleep 20 & echo main-done",
                RunMode::OneShot { timeout_secs: 30 },
            ),
            Some(rx),
        )
        .await
        .unwrap();
        assert!(!outcome.timed_out);
        assert!(!outcome.cancelled);
        assert_eq!(outcome.exit_code, Some(0));
        assert!(outcome.output.contains("main-done"));
        assert!(
            outcome.duration_ms < PUMP_DRAIN_TIMEOUT.as_millis() as u64 + 2_000,
            "the run stayed hung on the background grandchild: {}ms",
            outcome.duration_ms
        );
    }

    #[tokio::test]
    async fn reports_a_non_zero_exit_code() {
        // The fail-fast pipeline needs it: without a reliable exit code
        // there is no way to know whether to stop at the next step.
        let (_tx, rx) = oneshot::channel();
        let outcome = run(
            spec("exit 3", RunMode::OneShot { timeout_secs: 30 }),
            Some(rx),
        )
        .await
        .unwrap();
        assert_eq!(outcome.exit_code, Some(3));
        assert!(!outcome.success());
    }

    #[tokio::test]
    async fn a_run_without_cancel_channel_is_not_cancelled_on_its_own() {
        // Deliberate regression test: passing `None` must not do what
        // a receiver whose sender has already dropped would do, that is an immediate
        // stop. It is the case of VERIFY, which has no stop button.
        let outcome = run(
            spec("echo senza-stop", RunMode::OneShot { timeout_secs: 30 }),
            None,
        )
        .await
        .unwrap();
        assert!(!outcome.cancelled);
        assert!(outcome.output.contains("senza-stop"));
        assert!(outcome.success());
    }

    #[tokio::test]
    async fn unbounded_run_can_be_cancelled() {
        // It is the dev server case: no timeout, the only way to stop it is the
        // user's stop.
        let (tx, rx) = oneshot::channel();
        let handle = tokio::spawn(async move {
            run(spec(never_ending_command(), RunMode::Unbounded), Some(rx)).await
        });
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        let _ = tx.send(());

        let outcome = handle.await.unwrap().unwrap();
        assert!(outcome.cancelled, "the manual stop must interrupt the run");
        assert!(!outcome.timed_out);
        assert!(!outcome.success());
    }

    #[tokio::test]
    async fn cancelled_run_keeps_the_output_produced_so_far() {
        // Whoever stops a run still wants to see what happened before: throwing away the
        // collected output would make the stop useless for understanding a hang.
        let command = if cfg!(windows) {
            "echo prima-dello-stop & for /l %i in (0,0,1) do @rem"
        } else {
            "echo prima-dello-stop; while true; do :; done"
        };
        let (tx, rx) = oneshot::channel();
        let handle =
            tokio::spawn(async move { run(spec(command, RunMode::Unbounded), Some(rx)).await });
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let _ = tx.send(());

        let outcome = handle.await.unwrap().unwrap();
        assert!(outcome.cancelled);
        assert!(
            outcome.output.contains("prima-dello-stop"),
            "output perso allo stop: {:?}",
            outcome.output
        );
    }

    #[tokio::test]
    async fn spawn_failure_is_the_only_error_case() {
        // A non-existent working dir is the only realistic way of not starting
        // at all: it must give Err, not a bogus outcome with empty output.
        let result = run(
            RunSpec {
                command: "echo x",
                working_dir: "__pragma_dir_che_non_esiste__/nope",
                mode: RunMode::OneShot { timeout_secs: 5 },
                on_line: None,
            },
            None,
        )
        .await;
        assert!(result.is_err());
    }

    #[test]
    fn success_requires_a_clean_natural_exit() {
        let base = RunOutcome {
            command: "x".into(),
            output: String::new(),
            exit_code: Some(0),
            timed_out: false,
            cancelled: false,
            duration_ms: 0,
        };
        assert!(base.success());

        assert!(
            !RunOutcome {
                exit_code: Some(1),
                ..base.clone()
            }
            .success(),
            "a non-zero exit code is not a success"
        );
        assert!(
            !RunOutcome {
                timed_out: true,
                ..base.clone()
            }
            .success(),
            "a timed-out run is not a success even if the exit code looks good"
        );
        assert!(
            !RunOutcome {
                cancelled: true,
                ..base.clone()
            }
            .success(),
            "a run stopped by the user is not a success"
        );
    }
}
