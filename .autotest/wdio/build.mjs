/**
 * Builds the binary the E2E suite drives.
 *
 * It is a *different* binary from the shipped one, on purpose:
 *
 *   - `--features e2e` compiles in `tauri-plugin-wdio-webdriver`, which runs a
 *     WebDriver server inside the app. That is what lets WebdriverIO drive the
 *     real app at all: on Windows the classic route (tauri-driver →
 *     msedgedriver → WebView2 CDP) needs a remote debugging port, and current
 *     WebView2 runtimes ignore `--remote-debugging-port` however it is passed
 *     (environment variable or `additionalBrowserArgs`).
 *   - the automation permissions and `withGlobalTauri` are injected here rather
 *     than committed into the app's own config.
 *
 * None of it reaches a release build — an embedded WebDriver server in a
 * shipped app is a remote-control surface for any local process.
 */
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

// The wdio plugins reach the frontend through the global Tauri API.
const overridePath = path.join(here, '.tauri.e2e.json')
writeFileSync(
  overridePath,
  JSON.stringify({ app: { withGlobalTauri: true } }, null, 2),
)

// Permissions have to arrive as a real capability *file*: inlining them in the
// `--config` override does not register them (the generated ACL keeps listing
// `default` alone). The file is written just for this build and removed right
// after, so an ordinary `tauri build` never sees permissions for plugins that
// are not compiled in — it would fail to resolve them.
const capabilityPath = path.join(repoRoot, 'src-tauri', 'capabilities', 'wdio.e2e.json')
writeFileSync(
  capabilityPath,
  JSON.stringify(
    {
      identifier: 'wdio-e2e',
      description: 'E2E automation surface — written by .autotest/wdio/build.mjs, never committed',
      windows: ['main'],
      permissions: ['wdio:default', 'wdio-webdriver:default'],
    },
    null,
    2,
  ),
)

try {
  const res = spawnSync(
    'npx',
    [
      'tauri', 'build',
      '--debug',        // minutes faster than release; same UI behaviour
      '--no-bundle',    // the suite runs the raw binary, not an installer
      '--features', 'e2e',
      '--config', overridePath,
    ],
    { cwd: repoRoot, stdio: 'inherit', shell: true },
  )
  process.exitCode = res.status ?? 1
} finally {
  rmSync(capabilityPath, { force: true })
}
