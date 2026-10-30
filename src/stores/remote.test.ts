import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'

// The SignalR constructor and Tauri's `listen` are spied on: «off» means neither of the
// two is touched, not just that nothing is seen.
const built = vi.hoisted(() => ({
  builds: 0,
  url: '' as string,
  opts: null as any,
  retry: null as any,
  hub: null as any,
}))

vi.mock('@microsoft/signalr', () => {
  class HubConnectionBuilder {
    withUrl(url: string, opts: unknown) { built.url = url; built.opts = opts; return this }
    withAutomaticReconnect(o: unknown) { built.retry = o; return this }
    configureLogging() { return this }
    build() { built.builds++; return built.hub }
  }
  return { HubConnectionBuilder, LogLevel: { Warning: 3 } }
})

const listen = vi.fn(async (_e: string, _cb: unknown) => () => {})
const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined)
vi.mock('../platform', () => ({ listen: (e: string, cb: unknown) => listen(e, cb), invoke: (c: string, a?: unknown) => invoke(c, a) }))

vi.mock('./session', () => ({ useSessionStore: () => ({ sessions: {} }) }))
vi.mock('./projects', () => ({ useProjectStore: () => ({ projects: [], currentProjectId: null }) }))
vi.mock('./todos', () => ({ useTodoStore: () => ({ refresh: vi.fn(async () => {}) }) }))
vi.mock('./scheduled', () => ({ useScheduledStore: () => ({ refresh: vi.fn(async () => {}) }) }))

import { useRemoteStore } from './remote'
import { useSettingsStore } from './settings'

function fakeHub() {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    invoke: vi.fn(async (method: string) => (method === 'OpenRoom' ? { ok: true } : undefined)),
    on: vi.fn(),
    onreconnecting: vi.fn(),
    onreconnected: vi.fn(),
    onclose: vi.fn(),
  }
}

function configure(remote: Partial<{ enabled: boolean; hubUrl: string; hostSecret: string }>) {
  const settings = useSettingsStore()
  settings.settings.remote = {
    enabled: false, hubUrl: 'https://noema.tools/hubs/pragma-live', hostSecret: '',
    commandsEnabled: false, commandPinHash: '', shareNoticeSeen: false, ...remote,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  built.builds = 0
  built.hub = fakeHub()
  listen.mockClear()
  invoke.mockClear()
})

describe('remote store — off by default', () => {
  it('with factory settings the button does not appear and start opens nothing', async () => {
    const remote = useRemoteStore()
    expect(remote.canShare).toBe(false)
    expect(await remote.start()).toBe(false)
    expect(built.builds).toBe(0)
    expect(listen).not.toHaveBeenCalled()
    expect(remote.status).toBe('off')
  })

  it('feature on but without a key: still no connection', async () => {
    configure({ enabled: true, hostSecret: '' })
    const remote = useRemoteStore()
    expect(remote.canShare).toBe(false)
    expect(await remote.start()).toBe(false)
    expect(built.builds).toBe(0)
  })

  it('key present but feature off: no connection', async () => {
    configure({ enabled: false, hostSecret: 'secret-secret-secret' })
    const remote = useRemoteStore()
    expect(await remote.start()).toBe(false)
    expect(built.builds).toBe(0)
  })

  it('creating the store is not enough to open connections', () => {
    configure({ enabled: true, hostSecret: 'secret-secret-secret' })
    useRemoteStore()
    expect(built.builds).toBe(0)
    expect(listen).not.toHaveBeenCalled()
  })
})

describe('remote store — on', () => {
  beforeEach(() => configure({ enabled: true, hostSecret: 'secret-secret-secret' }))

  it('start builds the client without credentials and opens the room', async () => {
    const remote = useRemoteStore()
    expect(remote.canShare).toBe(true)
    expect(await remote.start()).toBe(true)

    expect(built.builds).toBe(1)
    expect(built.url).toBe('https://noema.tools/hubs/pragma-live')
    expect(built.opts).toEqual({ withCredentials: false })
    expect(remote.status).toBe('on')
    expect(remote.sharing).toBe(true)
    expect(remote.link).toMatch(/^https:\/\/noema\.tools\/pragma-symphony\/live#t=[A-Za-z0-9_-]{43}$/)
    expect(listen).toHaveBeenCalledTimes(22)
  })

  it('automatic reconnection never gives up: growing pause up to 30 s', async () => {
    await useRemoteStore().start()
    const delay = built.retry.nextRetryDelayInMilliseconds as (c: { previousRetryCount: number }) => number
    expect([0, 1, 2, 3, 4, 10, 100].map(n => delay({ previousRetryCount: n })))
      .toEqual([0, 2000, 4000, 8000, 16000, 30000, 30000])
  })

  it('stop closes the room', async () => {
    const remote = useRemoteStore()
    await remote.start()
    await remote.stop()
    expect(built.hub.invoke).toHaveBeenCalledWith('CloseRoom', { reason: 'stopped' })
    expect(remote.status).toBe('off')
    expect(remote.link).toBe('')
  })

  it('switching the feature off in settings closes a sharing in progress', async () => {
    const remote = useRemoteStore()
    await remote.start()
    useSettingsStore().settings.remote.enabled = false
    await nextTick()
    await vi.waitFor(() => expect(remote.status).toBe('off'))
    expect(built.hub.invoke).toHaveBeenCalledWith('CloseRoom', { reason: 'stopped' })
  })
})
