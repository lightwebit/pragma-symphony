import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { reactive } from 'vue'

// `new Audio(...)` runs at module top level: the vitest environment is 'node', no DOM.
class FakeAudio {
  currentTime = 0
  play() { return Promise.resolve() }
}

const sessionState = reactive<{
  running: boolean
  sessionTitle: string | null
  runningSessions: { id: string }[]
  sessions: Record<string, { title?: string; lastError?: string | null }>
}>({
  running: false,
  sessionTitle: null,
  runningSessions: [],
  sessions: {},
})
vi.mock('../stores/session', () => ({ useSessionStore: () => sessionState }))

const settingsState = reactive({ settings: { soundEnabled: false, notificationsEnabled: false } })
vi.mock('../stores/settings', () => ({ useSettingsStore: () => settingsState }))

const setTitle = vi.fn()
const setProgressBar = vi.fn()
vi.mock('../platform', () => ({
  getCurrentWindow: () => ({ setTitle, setProgressBar }),
  ProgressBarStatus: { None: 'none', Indeterminate: 'indeterminate' },
  isPermissionGranted: vi.fn(async () => false),
  requestPermission: vi.fn(async () => 'denied'),
  sendNotification: vi.fn(),
}))

// `vi.stubGlobal` must run before the module is evaluated (it instantiates `Audio` at
// top level): a static import would be hoisted above, so a dynamic import after the stub.
let useSessionNotifications: () => void
let ProgressBarStatus: { None: unknown; Indeterminate: unknown }

const settle = async () => { await Promise.resolve(); await Promise.resolve() }

beforeAll(async () => {
  vi.stubGlobal('Audio', FakeAudio)
  ;({ useSessionNotifications } = await import('./useSessionNotifications'))
  ;({ ProgressBarStatus } = await import('../platform'))
  // A single composable for the whole suite: it mirrors the real single app-wide instance.
  useSessionNotifications()
  await settle()
})

describe('useSessionNotifications — taskbar progress bar', () => {
  beforeEach(async () => {
    sessionState.runningSessions = []
    sessionState.running = false
    await settle()
    setProgressBar.mockClear()
  })

  it('turns on the indeterminate bar when a session starts', async () => {
    sessionState.runningSessions = [{ id: 'a' }]
    await settle()
    expect(setProgressBar).toHaveBeenLastCalledWith({ status: ProgressBarStatus.Indeterminate })
  })

  it('turns it off when the last session ends', async () => {
    sessionState.runningSessions = [{ id: 'a' }]
    await settle()
    sessionState.runningSessions = []
    await settle()
    expect(setProgressBar).toHaveBeenLastCalledWith({ status: ProgressBarStatus.None })
  })

  it('stays on while at least one session is running', async () => {
    sessionState.runningSessions = [{ id: 'a' }]
    await settle()
    sessionState.runningSessions = [{ id: 'a' }, { id: 'b' }]
    await settle()
    setProgressBar.mockClear()

    sessionState.runningSessions = [{ id: 'b' }]
    await settle()
    expect(setProgressBar).not.toHaveBeenCalled()
  })
})
