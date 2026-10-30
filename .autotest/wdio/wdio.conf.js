/**
* WebdriverIO config for Pragma Symphony's own E2E suite (dogfooding).
 *
 * Unlike the Playwright component tests in `.autotest/playwright/`, this drives the
 * *real* app: Rust commands, IPC, SQLite, filesystem.
 *
 * Driver provider: `external` (tauri-driver + Microsoft Edge WebDriver). The
 * service auto-downloads an msedgedriver matching the WebView2 runtime — doing
 * that by hand is the single most common way this setup breaks, since Edge
 * updates itself and the pinned driver silently falls behind.
 *
 * Prerequisites (see README.md in this folder):
 *   - a built binary: `npm run e2e:build`
 *   - no other Pragma instance running (single-instance guard would swallow ours)
 *
 * Not supported on macOS with this provider: tauri-driver has no macOS backend.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const isWindows = process.platform === 'win32'
const exe = (name) => (isWindows ? `${name}.exe` : name)

// Debug by default: `tauri build --debug` is minutes faster than release and the
// UI behaves identically. PRAGMA_E2E_APP overrides to test a release build.
const APP_BINARY =
  process.env.PRAGMA_E2E_APP ||
  path.join(repoRoot, 'target', 'debug', exe('pragma-tauri'))

// Pragma resolves ~/.pragma (settings, pragma.db, trusted dirs) from HOME /
// USERPROFILE. The suite creates projects and sessions, so it MUST NOT run
// against the real profile — a run would otherwise land in the user's own
// database. The app inherits this through the driver it is spawned by.
const SANDBOX_HOME = path.join(here, '.sandbox-home')

// The port tauri-plugin-wdio-webdriver listens on inside the app.
const EMBEDDED_PORT = 4445

/**
 * The single-instance plugin makes a second launch hand over to the first and
 * exit — which reads as "the app never started" and costs an hour of debugging.
 * Fail loudly instead.
 */
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
  })
}

/**
 * If anything else already holds the embedded WebDriver port, the service's
 * health check passes against the *wrong* server and the suite silently drives
 * something that is not the app — a blank page, in the case that cost an hour
 * here (a leftover msedgedriver from an earlier `external`-provider attempt).
 */
async function assertEmbeddedPortFree() {
  if (await portInUse(EMBEDDED_PORT)) {
    throw new Error(
      `Port ${EMBEDDED_PORT} is already in use. The embedded WebDriver server ` +
      'could not bind it, and the run would attach to whatever is listening ' +
      'there instead of to Pragma. Kill the process holding it (a leftover ' +
      'msedgedriver or tauri-driver is the usual suspect) and re-run.',
    )
  }
}

function assertNoRunningInstance() {
  if (!isWindows) return
  const out = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' })
  const running = (out.stdout || '')
    .split(/\r?\n/)
    .some((l) => /"(pragma-tauri\.exe|Pragma Symphony\.exe)"/i.test(l))
  if (running) {
    throw new Error(
      'A Pragma instance is already running. The single-instance guard would ' +
      'hand our launch over to it and the suite would never get a window. ' +
      'Close Pragma (including a `tauri dev` session) and re-run.',
    )
  }
}

export const config = {
  runner: 'local',
  specs: [path.join(here, 'tests', '**', '*.e2e.js')],
  maxInstances: 1,

  capabilities: [{
    browserName: 'tauri',
    'tauri:options': { application: APP_BINARY },
  }],

  services: [['@wdio/tauri-service', {
    // `embedded`: the WebDriver server runs inside the app (tauri-plugin-wdio-
    // webdriver, compiled in by `npm run e2e:build`). The `external` provider —
    // tauri-driver + msedgedriver — cannot work here: it needs a WebView2 CDP
    // port, and current WebView2 runtimes ignore `--remote-debugging-port`.
    driverProvider: 'embedded',
    startTimeout: 60_000,
  }]],

  logLevel: process.env.PRAGMA_E2E_LOG || 'warn',
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,

  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 120_000 },

  /**
   * The service wraps every command in a focus check that evaluates a script
   * expecting `window.__wdio_original_core__`. That global is installed by
   * @wdio/native-utils' mock bridge, which does not come up with this
   * service/native-utils version pair — so the check burns its full 5s timeout
   * on *every* command, turning a 20s suite into a 5-minute one. Pointing the
   * global at the real Tauri core is enough to satisfy it.
   */
  async before() {
    await browser.execute(() => {
      const w = /** @type {any} */ (window)
      if (!w.__wdio_original_core__ && w.__TAURI__?.core) {
        w.__wdio_original_core__ = w.__TAURI__.core
      }
    })
  },

  async onPrepare() {
    if (!existsSync(APP_BINARY)) {
      throw new Error(
        `App binary not found: ${APP_BINARY}\n` +
        'Build it first: npm run e2e:build (or set PRAGMA_E2E_APP).',
      )
    }
    assertNoRunningInstance()
    await assertEmbeddedPortFree()

    // Fresh sandbox every run: no state leaks between runs, and the first spec
    // can rely on seeing the real first-launch empty state.
    rmSync(SANDBOX_HOME, { recursive: true, force: true })
    mkdirSync(SANDBOX_HOME, { recursive: true })
    process.env.HOME = SANDBOX_HOME
    process.env.USERPROFILE = SANDBOX_HOME
  },
}

export { SANDBOX_HOME, APP_BINARY }
