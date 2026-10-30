# Tauri E2E suite (WebdriverIO)

Drives the **real Pragma Symphony app** — Tauri shell, Rust commands, IPC,
SQLite, filesystem. This is the layer the Playwright component tests in
`../playwright/` cannot reach: those render Vue components in a browser with
`invoke` mocked.

```bash
npm run e2e          # build the E2E binary, then run the suite
npm run e2e:build    # build only
npm run e2e:run      # run only (binary must already exist)
```

## How it is wired

```
wdio ──http──> WebDriver server running *inside* the app
               (tauri-plugin-wdio-webdriver, port 4445)
```

The app is built by `build.mjs` with `--features e2e`, which is the only build
that compiles the plugins in. A shipped binary never contains them: an embedded
WebDriver server is a remote-control surface for any local process.

`build.mjs` also injects, for that build only:

- `withGlobalTauri: true` (via `--config`), which the service's bridge needs;
- a temporary `src-tauri/capabilities/wdio.e2e.json` granting `wdio:default` and
  `wdio-webdriver:default`. It is deleted right after the build — an ordinary
  `tauri build` would fail to resolve permissions for plugins it does not
  compile.

### Why not tauri-driver + msedgedriver

That is the documented route for Tauri on Windows, and it does not work here.
`msedgedriver` automates WebView2 over the Chrome DevTools Protocol, which
requires the webview to open a `--remote-debugging-port`. Current WebView2
runtimes (verified on 150.0.4078.99) ignore that argument no matter how it is
delivered — `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, or `additionalBrowserArgs`
baked into the app. The port never opens, so every session fails with
`DevToolsActivePort file doesn't exist`. The embedded provider bypasses CDP
entirely by talking to the native WebView2 APIs from inside the app, and it also
works on macOS, which `tauri-driver` does not support at all.

## Isolation

The app runs against a throwaway home (`.sandbox-home/`, wiped before each run),
so the suite's projects and sessions never land in the real `~/.pragma/pragma.db`.
Pragma resolves its home from `HOME` / `USERPROFILE`, which `wdio.conf.js`
redirects before spawning.

A consequence worth knowing: the sandbox has **no Claude profile configured**, so
no spec can start a session even by accident. Nothing here spends tokens.

## Writing specs

- Everything lives in `tests/app.e2e.js`. The embedded provider spawns **one app
  instance per run**, so a second spec file would find no session to connect to.
  Order matters inside the file: the shell block expects a database with no
  projects.
- Select by `data-testid` only. Class names in this app are styling, and change.
- Helpers are in `helpers.js`.

## Still to cover

A real Claude session is never started on purpose here: the sandbox home has no
profiles, so the suite cannot spend tokens by accident. Where a turn is needed
without spending tokens there is the fake `claude` binary
`pragma-cli/examples/fake_claude.rs`. What stays uncovered is the E2E button on a
real project (discovery, generation, run).

## Live and Pipeline: they really run, they are not mocked

Unlike VERIFY/REVIEW, a Live step or a `command` pipeline step is a plain shell
command — no Claude session involved. The `Live`/`Pipeline` specs in `app.e2e.js`
take advantage of that: they save a real command (`echo ...`) and really run it in
the app, checking the outcome in the DOM. Zero tokens spent.

**Exception**: `PipelineModal` needs a non-null `profile` to enable Run
(`canRun`), and the profile comes from the autodetect in
`load_settings_with_autodetect()` (`where claude` / `which claude` on the PATH
inherited by the app process) — even though no pipeline step actually calls Claude.
If `claude` cannot be resolved on the PATH `npm run e2e` is launched with,
`profiles` stays empty, the Run button stays disabled forever and the Pipeline spec
fails by timeout (not obviously: the symptom is "the result never shows up", not a
profile error). Make sure `claude` is on the PATH of the shell running the suite.

## Environment overrides

| Variable | Purpose |
|---|---|
| `PRAGMA_E2E_APP` | Use a different binary (e.g. a release build) |
| `PRAGMA_E2E_LOG` | wdio log level (default `warn`; `debug` to trace the service) |

## Known rough edges

- `@wdio/tauri-service@1.2.0` pins `@wdio/native-utils` 2.4.0 but imports an
  export that only exists from 2.5.0. `package.json` carries an `overrides`
  entry to fix it; remove that once the service ships a corrected pin.
- With that version pair the service's mock bridge never installs
  `window.__wdio_original_core__`, so `browser.tauri.execute()` and
  `browser.tauri.mock()` do not work. Plain WebDriver automation does. The
  `before()` hook in `wdio.conf.js` sets that global by hand, otherwise the
  service's per-command focus check burns a 5s timeout on *every* command (a 4s
  suite becomes a 5-minute one).
- If the run fails at startup, the usual causes are a Pragma instance already
  running (the single-instance guard swallows our launch) or something else
  holding port 4445. Both are checked up front with an explicit message.
