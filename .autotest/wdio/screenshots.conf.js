/**
 * Regenerates the screenshots in `docs/screenshots/` from the real app.
 *
 *   npm run e2e:build        # once, or after UI changes
 *   npm run screenshots
 *
 * Same embedded-WebDriver setup as the E2E suite, but the sandbox home is filled by
 * `pragma-parser/examples/seed_demo.rs` with invented projects and sessions, so every image
 * shows plausible data and nothing from a real database. Each view is captured twice, dark
 * and light.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as base, APP_BINARY } from './wdio.conf.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
// base.onPrepare() redirects HOME; cargo needs the real one to find its toolchain.
const REAL_ENV = { ...process.env }
export const SHOTS_HOME = path.join(here, '.sandbox-shots')
// The "projects" live here, so the working directory shown in the app is a neutral path.
export const DEMO_ROOT = process.env.PRAGMA_SHOTS_DEMO_ROOT || 'C:/demo'
export const QUEUE_DIR = path.join(DEMO_ROOT, 'queue')
export const OUT_DIR = path.join(repoRoot, 'docs', 'screenshots')

export const config = {
  ...base,
  specs: [path.join(here, 'shots', '*.shots.js')],
  mochaOpts: { ui: 'bdd', timeout: 300_000 },
  async onPrepare() {
    await base.onPrepare()
    rmSync(SHOTS_HOME, { recursive: true, force: true })
    mkdirSync(SHOTS_HOME, { recursive: true })
    rmSync(DEMO_ROOT, { recursive: true, force: true })
    mkdirSync(OUT_DIR, { recursive: true })
    mkdirSync(path.join(DEMO_ROOT, 'bin'), { recursive: true })
    mkdirSync(QUEUE_DIR, { recursive: true })
    // Build first with the real HOME (cargo/rustup live there), then run with the throwaway one.
    const build = spawnSync(
      'cargo', ['build', '-q', '-p', 'pragma-parser', '--example', 'seed_demo'],
      { cwd: repoRoot, stdio: 'inherit', shell: true, env: REAL_ENV },
    )
    // The "claude" of the demo is the fake binary: sessions started from the UI play a script,
    // so nothing is spent and nothing real is shown.
    const fake = spawnSync('cargo', ['build', '-q', '-p', 'pragma-cli', '--example', 'fake_claude'],
      { cwd: repoRoot, stdio: 'inherit', shell: true, env: REAL_ENV })
    if (fake.status !== 0) throw new Error('fake_claude did not build')
    copyFileSync(
      path.join(repoRoot, 'target', 'debug', 'examples', process.platform === 'win32' ? 'fake_claude.exe' : 'fake_claude'),
      path.join(DEMO_ROOT, 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
    )
    process.env.FAKE_CLAUDE_QUEUE = QUEUE_DIR
    process.env.PRAGMA_SHOTS_QUEUE = QUEUE_DIR
    if (build.status !== 0) throw new Error('seed_demo did not build')
    process.env.HOME = SHOTS_HOME
    process.env.USERPROFILE = SHOTS_HOME
    process.env.PRAGMA_SHOTS_OUT = OUT_DIR
    const seed = path.join(repoRoot, 'target', 'debug', 'examples', process.platform === 'win32' ? 'seed_demo.exe' : 'seed_demo')
    const res = spawnSync(seed, [DEMO_ROOT], { cwd: repoRoot, stdio: 'inherit', env: process.env })
    if (res.status !== 0) throw new Error('seed_demo failed')
  },
}

export { APP_BINARY }
