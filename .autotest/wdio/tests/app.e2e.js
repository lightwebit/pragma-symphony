/**
 * End-to-end suite against the real Pragma Symphony app.
 *
 * One file on purpose: the embedded WebDriver provider spawns a single app
 * instance for the whole run, so a second spec file would find no session to
 * connect to. Order matters — the shell block runs against a database with no
 * projects, and the projects block is what puts one there.
 *
 * Nothing here starts a Claude session: that costs tokens and needs a
 * configured profile, which the sandbox home deliberately does not have.
 */
import { byTestId, waitForAppReady, createProject } from '../helpers.js'
import { startFakeRelay } from '../fakeRelay.js'

describe('app shell', () => {
  before(async () => {
    await waitForAppReady()
  })

  it('starts with the expected window title', async () => {
    // Also proves the Tauri shell — not just a webview — is what we drive.
    expect(await browser.getTitle()).toBe('Pragma Symphony')
  })

  it('mounts the frontend past the splash', async () => {
    await expect(byTestId('app-logo')).toHaveText('pragma')
    await expect(byTestId('app-layout')).toBeDisplayed()
  })

  it('opens and closes the guide', async () => {
    await byTestId('btn-help').click()
    await expect(byTestId('help-panel')).toBeDisplayed()
    await byTestId('help-close').click()
    await expect(byTestId('help-panel')).not.toBeExisting()
  })

  it('opens and closes settings', async () => {
    // Settings reads ~/.pragma/settings.json through a Rust command, so this
    // exercises the IPC round-trip, not just Vue rendering.
    await byTestId('btn-settings').click()
    await expect(byTestId('settings-panel')).toBeDisplayed()
    await byTestId('settings-close').click()
    await expect(byTestId('settings-panel')).not.toBeExisting()
  })

  it('toggles the theme', async () => {
    const root = await $('html')
    const before = await root.getAttribute('data-theme')
    await byTestId('btn-theme').click()
    await browser.waitUntil(
      async () => (await root.getAttribute('data-theme')) !== before,
      { timeoutMsg: 'data-theme did not change' },
    )
    await byTestId('btn-theme').click() // leave the app as we found it
  })

  it('gates project-scoped actions until a project exists', async () => {
    await expect(byTestId('btn-e2e')).toBeDisabled()
    await expect(byTestId('btn-live')).toBeDisabled()
    await expect(byTestId('btn-pipeline')).toBeDisabled()
    await expect(byTestId('btn-todo')).toBeDisabled()
  })
})

describe('projects', () => {
  it('shows the empty state on a fresh database', async () => {
    await expect(byTestId('empty-projects')).toBeDisplayed()
    await expect(byTestId('project-name')).toHaveText('No project')
  })

  it('creates a project and makes it current', async () => {
    // `create_project` is a Rust command writing to pragma.db — the part the
    // Playwright component tests cannot reach. workingDir is the repo root itself
    // (the wdio process already runs with that as its cwd) — Live/Pipeline below
    // need a real, existing directory to spawn commands in.
    await createProject('E2E Sandbox', { testCommand: 'npm test', workingDir: process.cwd() })

    await expect(byTestId('project-name')).toHaveText('E2E Sandbox')
    await expect(byTestId('empty-projects')).not.toBeExisting()
  })

  it('enables project-scoped actions once a project exists', async () => {
    await expect(byTestId('btn-e2e')).toBeEnabled()
    await expect(byTestId('btn-live')).toBeEnabled()
    await expect(byTestId('btn-pipeline')).toBeEnabled()
    await expect(byTestId('btn-todo')).toBeEnabled()
  })

  it('opens the E2E modal for the current project', async () => {
    await byTestId('btn-e2e').click()
    await expect(byTestId('e2e-modal')).toBeDisplayed()
    await byTestId('e2e-close').click()
    await expect(byTestId('e2e-modal')).not.toBeExisting()
  })
})

describe('Live', () => {
  // Unlike VERIFY/REVIEW/E2E-with-a-runner-script, Live is a plain shell command —
  // no Claude session involved. That means it
  // can be exercised for real, for free, which VERIFY/REVIEW cannot. `echo` is used
  // instead of anything from the repo's own toolchain so this test has zero
  // dependency on node/cargo being on the app's inherited PATH.
  it('saves a command, runs it for real, and shows a passed result', async () => {
    await byTestId('btn-live').click()
    await expect(byTestId('live-modal')).toBeDisplayed()

    await byTestId('live-command-input').setValue('echo pragma-e2e-live-ok')
    await byTestId('live-save-config').click()

    await byTestId('live-run').click()
    await byTestId('live-result').waitForDisplayed({ timeout: 20_000 })
    await expect(byTestId('live-result')).toHaveText(/✓ Exit 0/)
    await expect(byTestId('live-output')).toHaveText(/pragma-e2e-live-ok/)

    await byTestId('live-close').click()
    await expect(byTestId('live-modal')).not.toBeExisting()
  })
})

describe('Pipeline', () => {
  // Same reasoning as Live: a 'command'-kind step is just a shell command, so the
  // full add-step -> run -> aggregate-result cycle can run for real without a
  // Claude session or any token cost.
  it('adds a step, runs the pipeline for real, and shows the aggregate result', async () => {
    await byTestId('btn-pipeline').click()
    await expect(byTestId('pipeline-modal')).toBeDisplayed()

    // WebDriver also clicks a disabled button, with no effect: without these
    // waits a click during step loading is silently lost.
    await expect(byTestId('pipeline-add-step')).toBeEnabled()
    await byTestId('pipeline-add-step').click()
    await byTestId('pipeline-step-label').setValue('echo step')
    await byTestId('pipeline-step-command').setValue('echo pragma-e2e-pipeline-ok')

    // Disabled here = no profile: `claude` is not on the process PATH (see the README).
    await expect(byTestId('pipeline-run')).toBeEnabled()
    await byTestId('pipeline-run').click()
    await byTestId('pipeline-result').waitForDisplayed({ timeout: 20_000 })
    await expect(byTestId('pipeline-result')).toHaveText(/✓ Pipeline passed/)
    await expect(byTestId('pipeline-step-result')).toHaveText(/✓ passed/)

    await byTestId('pipeline-close').click()
    await expect(byTestId('pipeline-modal')).not.toBeExisting()
  })
})

describe('To-do', () => {
  // The user's per-project checklist: no Claude session involved, so the full
  // add -> check -> clear round trip goes through the real DB at no cost. The real
  // point of the test is persistence: the list is re-read from `todos` on every open,
  // so reopening the popup proves the Rust round trip, not Vue's in-memory state.
  const rows = () => $$('[data-testid="todo-row"]')

  it('adds items with Enter and counts the open ones on the button', async () => {
    await byTestId('btn-todo').click()
    await expect(byTestId('todo-overlay')).toBeDisplayed()

    await byTestId('todo-input').setValue('primo appunto')
    await browser.keys('Enter')
    await byTestId('todo-input').setValue('secondo appunto')
    await browser.keys('Enter')

    await expect(rows()).toBeElementsArrayOfSize(2)
    await expect(byTestId('todo-count')).toHaveText(/2 open/)
    await expect(byTestId('btn-todo')).toHaveText(/2/)
  })

  it('checking an item moves it to the done count without reordering the list', async () => {
    await $$('[data-testid="todo-toggle"]')[0].click()

    await expect(byTestId('todo-count')).toHaveText(/1 open/)
    await expect(byTestId('todo-count')).toHaveText(/1 done/)
    // Insertion order does not change when an item is checked.
    const texts = await rows().map(r => r.getText())
    expect(texts[0]).toContain('primo appunto')
    expect(texts[1]).toContain('secondo appunto')
  })

  it('survives closing and reopening the popup', async () => {
    // The point of this block: on reopening, the list is re-read from `todos` via Rust,
    // so this proves the DB, not Vue state left in memory.
    await byTestId('todo-close').click()
    await expect(byTestId('todo-overlay')).not.toBeExisting()

    await byTestId('btn-todo').click()
    await expect(rows()).toBeElementsArrayOfSize(2)
    await expect(byTestId('todo-count')).toHaveText(/1 open/)
  })

  it('clear done removes only the checked item', async () => {
    await byTestId('todo-clear-done').click()

    await expect(rows()).toBeElementsArrayOfSize(1)
    await expect(byTestId('todo-list')).toHaveText(/secondo appunto/)
    await expect(byTestId('todo-count')).toHaveText(/1 open/)
  })

  it('deletes the last item and leaves the button unlit', async () => {
    // The trash icon has opacity 0 until the pointer is over the row: without moveTo
    // WebDriver considers it not visible and the click fails.
    await rows()[0].moveTo()
    await byTestId('todo-delete').click()

    await expect(byTestId('todo-row')).not.toBeExisting()
    await expect(byTestId('todo-count')).toHaveText(/0 open/)
    await byTestId('todo-close').click()
    await expect(byTestId('btn-todo')).toHaveText('todo')
  })
})

describe('Scheduled sessions', () => {
  // Zero-token like the rest of this file: only the composer -> scheduled_sessions
  // -> SessionPanel round trip is exercised, never a real Claude session. Scheduling
  // deliberately does not require a configured profile (it resolves at fire time,
  // see scheduler.rs::fire_one) — which is what makes this testable at all in a
  // sandbox that has none. Ctrl+K opens the composer directly, bypassing
  // PromptBar's trigger button (disabled while no profile is configured).
  it('schedules a session and shows it as a pending row in the panel', async () => {
    await browser.keys(['Control', 'k'])
    await byTestId('composer-modal').waitForDisplayed()
    await byTestId('composer-textarea').setValue('scheduled e2e prompt')

    await byTestId('composer-advanced-toggle').click()
    await byTestId('composer-schedule-toggle').click()

    const future = new Date(Date.now() + 10 * 60_000)
    const pad = (n) => String(n).padStart(2, '0')
    const localValue = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`
    await byTestId('composer-schedule-at').setValue(localValue)

    await expect(byTestId('composer-submit')).toHaveText('Schedule')
    await byTestId('composer-submit').click()
    await byTestId('composer-modal').waitForExist({ reverse: true })

    const row = byTestId('scheduled-item')
    await row.waitForDisplayed()
    await expect(row).toHaveText(/⏱/)
    expect(await row.getAttribute('title')).toContain(String(future.getFullYear()))
  })

  it('cancelling removes the row', async () => {
    await byTestId('scheduled-cancel').click()
    await expect(byTestId('scheduled-item')).not.toBeExisting()
  })
})

// Web sharing. Nothing here reaches a real relay: the point is that the
// feature is invisible until switched on, and that a relay that cannot be reached
// is reported in words instead of failing silently. The hub URL points at a closed
// local port, so no request ever leaves the machine.
describe('Web sharing', () => {
  async function saveRemoteSettings({ enabled, secret, expectNotice }) {
    await byTestId('btn-settings').click()
    await byTestId('settings-panel').waitForDisplayed()
    const box = byTestId('remote-enabled')
    if ((await box.isSelected()) !== enabled) await box.click()
    // the privacy notice shows only the first time sharing is switched on.
    if (expectNotice !== undefined) {
      if (expectNotice) {
        await expect(byTestId('share-privacy-notice')).toBeDisplayed()
        await expect(byTestId('share-privacy-link')).toHaveText('Privacy policy')
      } else {
        await expect(byTestId('share-privacy-notice')).not.toBeExisting()
      }
    }
    if (enabled) {
      await byTestId('remote-hub-url').setValue('http://127.0.0.1:1/hubs/pragma-live')
      await byTestId('remote-secret').setValue(secret)
    }
    await byTestId('settings-save').click()
    await byTestId('settings-panel').waitForExist({ reverse: true })
  }

  it('has no share button by default', async () => {
    await expect(byTestId('btn-share')).not.toBeExisting()
  })

  it('stays hidden when the feature is on but no secret is set', async () => {
    await saveRemoteSettings({ enabled: true, secret: '', expectNotice: true })
    await expect(byTestId('btn-share')).not.toBeExisting()
  })

  it('shows the share button once a secret is set, and explains an unreachable relay', async () => {
    await saveRemoteSettings({ enabled: true, secret: 'e2e-secret-e2e-secret' })
    await byTestId('btn-share').waitForDisplayed()

    await byTestId('btn-share').click()
    await byTestId('share-error').waitForDisplayed({ timeout: 15_000 })
    await expect(byTestId('share-error')).toHaveText(expect.stringContaining('Could not reach the relay'))
    await expect(byTestId('btn-share-stop')).not.toBeExisting()
    await expect(byTestId('btn-share')).toBeDisplayed() // can try again
  })

  it('switching the feature off removes the button again', async () => {
    await saveRemoteSettings({ enabled: false })
    await expect(byTestId('btn-share')).not.toBeExisting()
  })

  it('does not show the privacy notice again once sharing has been on', async () => {
    await saveRemoteSettings({ enabled: true, secret: 'e2e-secret-e2e-secret', expectNotice: false })
    await saveRemoteSettings({ enabled: false })
  })
})

// the real bridge in the real app, against a fake relay on localhost that plays the relay's
// part. A read is answered; an excluded command is refused even with the right PIN; an allowed
// command runs for real (a to-do: it reaches pragma.db and costs no tokens) only with the right
// PIN, and the desktop sees it; the connection drops and the bridge reopens the same room.
describe('Web commands through a relay', () => {
  const SECRET = 'e2e-secret-e2e-secret'
  const PIN = '2468'
  let relay
  let projectId

  before(async () => {
    relay = await startFakeRelay({ secret: SECRET })
  })

  after(async () => {
    if (await byTestId('btn-share-stop').isExisting()) await byTestId('btn-share-stop').click()
    relay?.close()
  })

  it('shares with commands on: the room opens with commands enabled, and the header says so', async () => {
    await byTestId('btn-settings').click()
    await byTestId('settings-panel').waitForDisplayed()
    if (!(await byTestId('remote-enabled').isSelected())) await byTestId('remote-enabled').click()
    await byTestId('remote-hub-url').setValue(relay.hubUrl)
    await byTestId('remote-secret').setValue(SECRET)
    if (!(await byTestId('remote-commands').isSelected())) await byTestId('remote-commands').click()
    await byTestId('remote-pin').setValue(PIN)
    await byTestId('settings-save').click()
    await byTestId('settings-panel').waitForExist({ reverse: true })

    await byTestId('btn-share').click()
    await byTestId('btn-share-stop').waitForDisplayed({ timeout: 15_000 })
    await browser.waitUntil(() => relay.state.opens.length === 1, { timeout: 10_000 })
    expect(relay.state.opens[0]).toMatchObject({ hostSecret: SECRET, commandsEnabled: true })
    await expect(byTestId('share-commands-on')).toBeDisplayed()
  })

  it('answers a read, and hides the secret and the PIN hash from get_settings', async () => {
    const projects = await relay.request('list_projects')
    expect(projects.ok).toBe(true)
    const sandbox = projects.result.find((p) => p.title === 'E2E Sandbox')
    expect(sandbox).toBeTruthy()
    projectId = sandbox.id

    const settings = await relay.request('get_settings')
    expect(settings.ok).toBe(true)
    const text = JSON.stringify(settings.result)
    expect(text).not.toContain(SECRET)
    expect(settings.result.remote).toBeUndefined()
  })

  it('refuses excluded commands even with the right PIN', async () => {
    for (const cmd of ['create_project', 'run_live_command', 'save_settings_cmd', 'trust_directory']) {
      const r = await relay.request(cmd, { pin: PIN, title: 'x', command: 'calc.exe', dir: 'C:/' })
      expect(r).toMatchObject({ ok: false, error: { code: 'not_allowed' } })
    }
  })

  it('runs an allowed command only with the right PIN, and the desktop sees it', async () => {
    const wrong = await relay.request('create_todo', { pin: '0000', projectId, text: 'from the web' })
    expect(wrong).toMatchObject({ ok: false, error: { code: 'bad_pin' } })
    await expect(byTestId('btn-todo')).not.toHaveText(expect.stringContaining('1'))

    const right = await relay.request('create_todo', { pin: PIN, projectId, text: 'from the web' })
    expect(right.ok).toBe(true)
    // The desktop list is refreshed by the bridge: the badge on the button counts it.
    await browser.waitUntil(async () => (await byTestId('btn-todo').getText()).includes('1'), { timeout: 10_000 })

    const cleanup = await relay.request('delete_todo', { pin: PIN, id: right.result.id })
    expect(cleanup.ok).toBe(true)
    await browser.waitUntil(async () => !(await byTestId('btn-todo').getText()).includes('1'), { timeout: 10_000 })
  })

  it('reopens the same room after the connection drops, and asks viewers to resync', async () => {
    const token = relay.state.opens[0].token
    relay.state.publishes.length = 0
    relay.dropAll()
    await browser.waitUntil(() => relay.state.opens.length >= 2, { timeout: 20_000, timeoutMsg: 'the bridge did not reconnect' })
    expect(relay.state.opens.at(-1).token).toBe(token)
    await browser.waitUntil(() => relay.state.publishes.some((p) => p.event === 'pragma:resync'), { timeout: 10_000 })
    await byTestId('btn-share-stop').waitForDisplayed()
    expect(await byTestId('btn-share-stop').getText()).toContain('sharing')

    // Still the same PIN rules after reconnecting.
    const r = await relay.request('create_project', { pin: PIN, title: 'x' })
    expect(r).toMatchObject({ ok: false, error: { code: 'not_allowed' } })
  })
})
