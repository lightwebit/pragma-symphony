import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createBridge, newToken, validateHubUrl, type BridgeDeps, type HubLike } from './bridge'
import { FORWARDED_EVENTS, COMMAND_COMMANDS } from './policy'
import { MAX_BAD_PINS } from './bridge'

type Handler = (...a: any[]) => void

class FakeHub implements HubLike {
  handlers = new Map<string, Handler>()
  calls: { method: string; args: any[] }[] = []
  started = false
  stopped = false
  startError: Error | null = null
  openRoomResults: { ok: boolean; error?: string }[] = []
  publishGate: Promise<void> | null = null
  private reconnecting: Handler[] = []
  private reconnected: Handler[] = []
  private closed: Handler[] = []

  async start() {
    if (this.startError) throw this.startError
    this.started = true
  }
  async stop() { this.stopped = true }
  async invoke(method: string, ...args: any[]): Promise<any> {
    this.calls.push({ method, args })
    if (method === 'OpenRoom') return this.openRoomResults.shift() ?? { ok: true }
    if (method === 'Publish' && this.publishGate) await this.publishGate
    return undefined
  }
  on(method: string, h: Handler) { this.handlers.set(method, h) }
  onreconnecting(cb: Handler) { this.reconnecting.push(cb) }
  onreconnected(cb: Handler) { this.reconnected.push(cb) }
  onclose(cb: Handler) { this.closed.push(cb) }

  of(method: string) { return this.calls.filter(c => c.method === method).map(c => c.args[0]) }
  request(rid: string, cmd: string, args: unknown = {}) { this.handlers.get('Request')!({ rid, cmd, args }) }
  viewerCount(count: number) { this.handlers.get('ViewerCount')!({ count }) }
  fireReconnecting() { this.reconnecting.forEach(h => h()) }
  async fireReconnected() { await Promise.all(this.reconnected.map(h => h())) }
  fireClosed(e?: Error) { this.closed.forEach(h => h(e)) }
}

function setup(over: Partial<BridgeDeps> = {}) {
  const hub = new FakeHub()
  const listeners = new Map<string, (e: { payload: unknown }) => void>()
  const unlistened: string[] = []
  const backend = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => ({ ok: 'backend' }))
  const createHub = vi.fn((_url: string) => hub)
  const deps: BridgeDeps = {
    createHub,
    listen: async (event, cb) => {
      listeners.set(event, cb as (e: { payload: unknown }) => void)
      return () => { unlistened.push(event) }
    },
    invoke: backend as BridgeDeps['invoke'],
    snapshot: (id) => (id === 'live' ? { running: true, phase: 'awaiting_approval' } : null),
    appVersion: '9.9.9',
    ...over,
  }
  const bridge = createBridge(deps)
  const local = (event: string, payload: unknown) => listeners.get(event)!({ payload })
  return { hub, bridge, deps, listeners, unlistened, backend, createHub, local }
}

const CFG = { hubUrl: 'https://noema.tools/hubs/pragma-live', hostSecret: 'secret-secret-secret' }

async function started(over: Partial<BridgeDeps> = {}) {
  const s = setup(over)
  expect(await s.bridge.start(CFG)).toBe(true)
  return s
}

const flush = () => vi.waitFor(() => { /* lascia girare la coda */ })

describe('off by default', () => {
  it('without start it opens no connection and listens to nothing', () => {
    const { bridge, createHub, listeners } = setup()
    expect(bridge.state.status).toBe('off')
    expect(createHub).not.toHaveBeenCalled()
    expect(listeners.size).toBe(0)
  })

  it('without a key it does not connect', async () => {
    const { bridge, createHub } = setup()
    expect(await bridge.start({ ...CFG, hostSecret: '   ' })).toBe(false)
    expect(bridge.state.status).toBe('error')
    expect(bridge.state.error).toMatch(/access key/i)
    expect(createHub).not.toHaveBeenCalled()
  })

  it('with an insecure URL it does not connect (the key never travels in plain text)', async () => {
    const { bridge, createHub } = setup()
    expect(await bridge.start({ ...CFG, hubUrl: 'http://evil.example/hubs/pragma-live' })).toBe(false)
    expect(bridge.state.error).toMatch(/https/)
    expect(createHub).not.toHaveBeenCalled()
  })
})

describe('validateHubUrl', () => {
  it.each([
    ['https://noema.tools/hubs/pragma-live', null],
    ['http://localhost:5000/hubs/pragma-live', null],
    ['http://127.0.0.1:5000/x', null],
  ])('%s è ammesso', (url, expected) => expect(validateHubUrl(url)).toBe(expected))

  it.each(['http://noema.tools/hubs/pragma-live', 'ftp://x', 'not a url', ''])('%s is refused', (url) => {
    expect(validateHubUrl(url)).not.toBeNull()
  })
})

describe('newToken', () => {
  it('is 43-character base64url and never repeats', () => {
    const a = newToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newToken()).not.toBe(a)
  })
})

describe('opening the room', () => {
  it('opens the room with the key, the version and commands off', async () => {
    const { hub, bridge } = await started()
    const [open] = hub.of('OpenRoom')
    expect(open).toMatchObject({
      hostSecret: CFG.hostSecret, protocolVersion: 1, appVersion: '9.9.9', commandsEnabled: false,
    })
    expect(open.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(bridge.state.status).toBe('on')
    expect(bridge.state.link).toBe(`https://noema.tools/pragma-symphony/live#t=${open.token}`)
  })

  it('listens to the 22 expected events and no other', async () => {
    const { listeners } = await started()
    expect([...listeners.keys()].sort()).toEqual([...FORWARDED_EVENTS].sort())
    for (const banned of ['session:debug', 'pragma:e2e', 'pragma:live-output', 'pragma:pipeline-output']) {
      expect(listeners.has(banned)).toBe(false)
    }
  })

  it('key refused by the relay: clear error, hub closed, no events', async () => {
    const s = setup()
    s.hub.openRoomResults.push({ ok: false, error: 'unauthorized' })
    expect(await s.bridge.start(CFG)).toBe(false)
    expect(s.bridge.state.status).toBe('error')
    expect(s.bridge.state.error).toMatch(/access key/i)
    expect(s.hub.stopped).toBe(true)
    expect(s.listeners.size).toBe(0)
    expect(s.bridge.state.link).toBe('')
  })

  it('relay unreachable: error, and it can be retried', async () => {
    const s = setup()
    s.hub.startError = new Error('boom')
    expect(await s.bridge.start(CFG)).toBe(false)
    expect(s.bridge.state.status).toBe('error')
    expect(s.bridge.state.error).toMatch(/Could not reach the relay: boom/)

    s.hub.startError = null
    expect(await s.bridge.start(CFG)).toBe(true)
    expect(s.bridge.state.status).toBe('on')
    expect(s.bridge.state.error).toBeNull()
  })

  it('a second start while already on does not open another hub', async () => {
    const s = await started()
    expect(await s.bridge.start(CFG)).toBe(false)
    expect(s.createHub).toHaveBeenCalledTimes(1)
  })
})

describe('events towards the relay', () => {
  it('forwards events in order with an increasing seq', async () => {
    const { hub, local } = await started()
    local('atoms:batch', { sessionId: 's1', payload: [{ id: 'a' }] })
    local('pragma:phase', { sessionId: 's1', payload: 'awaiting_approval' })
    local('session:complete', { sessionId: 's1', payload: null })
    await vi.waitFor(() => expect(hub.of('Publish')).toHaveLength(3))

    const pub = hub.of('Publish')
    expect(pub.map(p => p.seq)).toEqual([1, 2, 3])
    expect(pub.map(p => p.event)).toEqual(['atoms:batch', 'pragma:phase', 'session:complete'])
    expect(pub[0].payload).toEqual({ sessionId: 's1', payload: [{ id: 'a' }] })
  })

  it('an event without payload goes out as null, not undefined', async () => {
    const { hub, local } = await started()
    local('session:complete', undefined)
    await vi.waitFor(() => expect(hub.of('Publish')).toHaveLength(1))
    expect(hub.of('Publish')[0].payload).toBeNull()
  })

  it('without an active connection it publishes nothing', async () => {
    const { hub, local } = await started()
    hub.fireReconnecting()
    local('atoms:batch', { sessionId: 's1', payload: [] })
    await flush()
    expect(hub.of('Publish')).toHaveLength(0)
  })

  it('an event that is too big is not sent: a resync instead', async () => {
    const { hub, local } = await started()
    local('atoms:batch', { sessionId: 's1', payload: 'x'.repeat(2_000_000) })
    await vi.waitFor(() => expect(hub.of('Publish')).toHaveLength(1))
    expect(hub.of('Publish')[0]).toMatchObject({ event: 'pragma:resync', payload: null })
  })

  it('if the network cannot keep up it drops the queue and sends a single resync', async () => {
    const { hub, local } = await started()
    let release!: () => void
    hub.publishGate = new Promise<void>((r) => { release = r })

    for (let i = 0; i < 600; i++) local('atoms:batch', { sessionId: 's1', payload: [i] })
    release()
    // The first event is already in flight (outside the queue); events 2–501 fill the queue up to the
    // limit; the 502nd drops it and replaces it with a resync; the last 98 arrive after.
    // Total 1 + 1 + 98: all 600 are never sent.
    await vi.waitFor(() => expect(hub.of('Publish')).toHaveLength(100))

    const pub = hub.of('Publish')
    const resyncAt = pub.findIndex(p => p.event === 'pragma:resync')
    expect(pub.filter(p => p.event === 'pragma:resync')).toHaveLength(1)
    expect(resyncAt).toBe(1)
    expect(pub.slice(resyncAt + 1).every(p => p.event === 'atoms:batch')).toBe(true)
    expect(pub.map(p => p.seq)).toEqual([...pub.map(p => p.seq)].sort((a, b) => a - b))
  })
})

describe('live state towards the relay', () => {
  it('publishState goes out as pragma:state in an envelope, in the same sequence as the events', async () => {
    const { hub, bridge, local } = await started()
    local('pragma:phase', { sessionId: 's1', payload: 'awaiting_confirmation' })
    bridge.publishState('s1', { running: false, phase: 'awaiting_confirmation', autoConfirmAt: 123 })
    await vi.waitFor(() => expect(hub.of('Publish')).toHaveLength(2))

    const pub = hub.of('Publish')
    expect(pub.map(p => [p.seq, p.event])).toEqual([[1, 'pragma:phase'], [2, 'pragma:state']])
    expect(pub[1].payload).toEqual({ sessionId: 's1', payload: { running: false, phase: 'awaiting_confirmation', autoConfirmAt: 123 } })
  })

  it('without sharing, or for a vanished session, it publishes nothing', async () => {
    const { hub, bridge } = setup()
    bridge.publishState('s1', { running: true })
    const on = await started()
    on.bridge.publishState('s1', null)
    await flush()
    expect(hub.of('Publish')).toHaveLength(0)
    expect(on.hub.of('Publish')).toHaveLength(0)
  })
})

// The 40 excluded commands: none passes, not even with commands on and the right PIN.
const EXCLUDED = [
  'create_project', 'update_project', 'delete_project', 'e2e_runner_catalog', 'project_category_catalog',
  'discover_project_category', 'discover_e2e_runner', 'update_e2e_config', 'read_e2e_spec', 'save_e2e_spec',
  'prepare_e2e_generation', 'run_e2e_suite', 'stop_e2e_run', 'update_live_command', 'run_live_command',
  'stop_live_run', 'pipeline_template_for_stack', 'detect_remote_ci', 'get_pipeline_steps', 'save_pipeline_steps',
  'run_project_pipeline', 'stop_pipeline_run', 'delete_session', 'duplicate_session', 'export_session',
  'export_session_to_file', 'export_session_to_markdown', 'save_settings_cmd', 'detect_claude', 'pick_directory',
  'pick_file', 'copy_to_pragmadocs', 'save_session_attachments', 'file_exists',
  'open_url', 'get_claude_usage', 'trust_directory', 'get_trusted_dirs', 'remove_trusted_dir', 'check_output_style',
]

function withCommands(enabled = true) {
  const run = vi.fn(async (_cmd: string, _args: Record<string, unknown>): Promise<unknown> => 'done')
  const commands = {
    enabled: () => enabled,
    checkPin: async (pin: unknown) => pin === '4321',
    run,
  }
  return { commands, run }
}

const responses = (hub: FakeHub) => hub.of('Respond')

describe('commands from the web', () => {
  it('the 40 excluded commands: none passes even with commands on and the right PIN', async () => {
    expect(EXCLUDED).toHaveLength(40)
    const { commands, run } = withCommands()
    const { hub, backend } = await started({ commands })
    EXCLUDED.forEach((cmd, i) => hub.request(`r${i}`, cmd, { pin: '4321', path: 'C:/x', binary: 'evil.exe' }))
    await vi.waitFor(() => expect(responses(hub)).toHaveLength(EXCLUDED.length))
    expect(responses(hub).every((m: any) => !m.ok && m.error.code === 'not_allowed')).toBe(true)
    expect(run).not.toHaveBeenCalled()
    expect(backend).not.toHaveBeenCalled()
  })

  it('switch off: every command refused, right PIN or not', async () => {
    const { commands, run } = withCommands(false)
    const { hub } = await started({ commands })
    COMMAND_COMMANDS.forEach((cmd, i) => hub.request(`r${i}`, cmd, { pin: '4321' }))
    await vi.waitFor(() => expect(responses(hub)).toHaveLength(COMMAND_COMMANDS.length))
    expect(responses(hub).every((m: any) => !m.ok && m.error.code === 'not_allowed')).toBe(true)
    expect(run).not.toHaveBeenCalled()
  })

  it('without the commands part: refused', async () => {
    const { hub } = await started()
    hub.request('r1', 'send_control', { pin: '4321', sessionId: 's', message: 'APPROVED' })
    await vi.waitFor(() => expect(responses(hub)).toHaveLength(1))
    expect(responses(hub)[0]).toMatchObject({ ok: false, error: { code: 'not_allowed' } })
  })

  it("the room opens with commands as the switch says, and the change reaches the relay", async () => {
    let on = true
    const commands = { ...withCommands().commands, enabled: () => on }
    const { hub, bridge } = await started({ commands })
    expect(hub.of('OpenRoom')[0].commandsEnabled).toBe(true)
    on = false
    bridge.syncCommands()
    expect(hub.calls.filter(c => c.method === 'SetCommandsEnabled').map(c => c.args[0])).toEqual([false])
  })

  it('right PIN: runs with cleaned arguments — no PIN, no executables or folders from the web', async () => {
    const { commands, run } = withCommands()
    const { hub } = await started({ commands })
    hub.request('r1', 'run_pragma', {
      pin: '4321', prompt: 'go', projectId: 'p1', binary: 'C:/evil.exe', workingDir: 'C:/Windows',
      configDir: 'C:/x', attachments: ['a'], model: 'opus',
    })
    await vi.waitFor(() => expect(responses(hub)).toHaveLength(1))
    expect(responses(hub)[0]).toMatchObject({ ok: true, result: 'done' })
    const args = run.mock.calls[0][1]
    expect(run.mock.calls[0][0]).toBe('run_pragma')
    expect(args).toMatchObject({ prompt: 'go', projectId: 'p1', model: 'opus' })
    for (const k of ['pin', 'binary', 'workingDir', 'configDir', 'attachments']) expect(args).not.toHaveProperty(k)
  })

  it('wrong arguments: bad_request, nothing executed', async () => {
    const { commands, run } = withCommands()
    const { hub } = await started({ commands })
    hub.request('r1', 'run_pragma', { pin: '4321', prompt: 'go', projectId: 'p1', model: 'gpt-4' })
    hub.request('r2', 'send_control', { pin: '4321', sessionId: 's' })
    await vi.waitFor(() => expect(responses(hub)).toHaveLength(2))
    expect(responses(hub).map((m: any) => m.error.code)).toEqual(['bad_request', 'bad_request'])
    expect(run).not.toHaveBeenCalled()
  })

  it('the store refusal (conflict) comes back with its code', async () => {
    const { commands } = withCommands()
    commands.run = vi.fn(async () => { throw Object.assign(new Error('someone got there first'), { code: 'conflict' }) })
    const { hub } = await started({ commands })
    hub.request('r1', 'send_control', { pin: '4321', sessionId: 's', message: 'APPROVED' })
    await vi.waitFor(() => expect(responses(hub)).toHaveLength(1))
    expect(responses(hub)[0]).toMatchObject({ ok: false, error: { code: 'conflict', message: 'someone got there first' } })
  })

  it(`wrong PIN: bad_pin; at the ${MAX_BAD_PINS}th in a row commands lock, even with the right PIN`, async () => {
    const { commands, run } = withCommands()
    const { hub } = await started({ commands })
    for (let i = 0; i < MAX_BAD_PINS; i++) {
      hub.request(`bad${i}`, 'kill_session', { pin: '0000', sessionId: 's' })
      await vi.waitFor(() => expect(responses(hub)).toHaveLength(i + 1))
    }
    const codes = responses(hub).map((m: any) => m.error.code)
    expect(codes.slice(0, -1).every((c: string) => c === 'bad_pin')).toBe(true)
    expect(codes.at(-1)).toBe('locked')
    expect(hub.calls.filter(c => c.method === 'SetCommandsEnabled').map(c => c.args[0])).toEqual([false])

    hub.request('good', 'kill_session', { pin: '4321', sessionId: 's' })
    await vi.waitFor(() => expect(responses(hub)).toHaveLength(MAX_BAD_PINS + 1))
    expect(responses(hub).at(-1)).toMatchObject({ ok: false, error: { code: 'locked' } })
    expect(run).not.toHaveBeenCalled()
  })

  it('a right PIN resets the count of wrong ones', async () => {
    const { commands } = withCommands()
    const { hub } = await started({ commands })
    let n = 0
    const send = async (pin: string) => {
      n++
      hub.request(`r${n}`, 'kill_session', { pin, sessionId: 's' })
      await vi.waitFor(() => expect(responses(hub)).toHaveLength(n))
    }
    for (let i = 0; i < MAX_BAD_PINS - 1; i++) await send('0000')
    await send('4321')
    for (let i = 0; i < MAX_BAD_PINS - 1; i++) await send('0000')
    expect(responses(hub).map((m: any) => m.error?.code ?? 'ok')).not.toContain('locked')
  })
})

describe('malformed messages from the relay', () => {
  it('a Request without rid or cmd is discarded, with no answer and no exception', async () => {
    const { commands, run } = withCommands()
    const { hub, backend } = await started({ commands })
    const handler = hub.handlers.get('Request')!
    for (const bad of [null, undefined, 42, 'x', {}, { rid: 1, cmd: 'list_projects' }, { rid: 'r', cmd: null }]) {
      expect(() => handler(bad)).not.toThrow()
    }
    await flush()
    expect(hub.of('Respond')).toHaveLength(0)
    expect(backend).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('non-object arguments: reads and commands answer bad_request', async () => {
    const { commands } = withCommands()
    const { hub } = await started({ commands })
    hub.request('r1', 'load_session', 'not-an-object')
    hub.request('r2', 'send_control', ['4321'])
    await vi.waitFor(() => expect(hub.of('Respond')).toHaveLength(2))
    expect(hub.of('Respond').map((m: any) => m.error.code).sort()).toEqual(['bad_pin', 'bad_request'])
  })
})

describe('read requests from the relay', () => {
  it('runs a read with cleaned arguments and answers with the result', async () => {
    const { hub, backend } = await started()
    backend.mockResolvedValueOnce([{ id: 's1' }])
    hub.request('r1', 'list_sessions', { projectId: 'p1', binary: 'evil.exe', workingDir: 'C:\\x' })
    await vi.waitFor(() => expect(hub.of('Respond')).toHaveLength(1))

    expect(backend).toHaveBeenCalledWith('list_sessions', { projectId: 'p1' })
    expect(hub.of('Respond')[0]).toEqual({ rid: 'r1', ok: true, result: [{ id: 's1' }], error: null })
  })

  it('get_settings comes out redacted: never the key or the paths', async () => {
    const { hub, backend } = await started()
    backend.mockResolvedValueOnce({
      profiles: [{ label: 'W', binary: 'C:\\claude.exe', configDir: 'C:\\cfg', language: 'it' }],
      dbPath: 'C:\\pragma.db', exportDir: 'C:\\out', lastWorkingDir: 'C:\\w',
      remote: { enabled: true, hubUrl: 'https://noema.tools/hubs/pragma-live', hostSecret: 'SEGRETO-VERO' },
    })
    hub.request('r1', 'get_settings')
    await vi.waitFor(() => expect(hub.of('Respond')).toHaveLength(1))

    const json = JSON.stringify(hub.of('Respond')[0])
    for (const leaked of ['SEGRETO-VERO', 'claude.exe', 'pragma.db', 'C:\\\\out', 'C:\\\\cfg']) {
      expect(json).not.toContain(leaked)
    }
    expect(hub.of('Respond')[0].ok).toBe(true)
  })

  it('pragma.snapshot reads the live state; a session not in memory gives null', async () => {
    const { hub, backend } = await started()
    hub.request('r1', 'pragma.snapshot', { sessionId: 'live' })
    hub.request('r2', 'pragma.snapshot', { sessionId: 'assente' })
    await vi.waitFor(() => expect(hub.of('Respond')).toHaveLength(2))

    const byRid = Object.fromEntries(hub.of('Respond').map(r => [r.rid, r]))
    expect(byRid.r1.result).toEqual({ running: true, phase: 'awaiting_approval' })
    expect(byRid.r2).toMatchObject({ ok: true, result: null })
    expect(backend).not.toHaveBeenCalled()
  })

  it.each([
    'send_control', 'run_pragma', 'kill_session', 'review_fix', 'delete_session', 'delete_project',
    'save_settings_cmd', 'run_live_command', 'run_project_pipeline', 'run_e2e_suite',
    'trust_directory', 'open_url', 'create_todo', 'pragma.review_accept', 'inventato',
  ])('%s is refused without touching the backend', async (cmd) => {
    const { hub, backend } = await started()
    hub.request('r1', cmd, { sessionId: 's1', binary: 'evil.exe' })
    await vi.waitFor(() => expect(hub.of('Respond')).toHaveLength(1))

    expect(hub.of('Respond')[0]).toMatchObject({ rid: 'r1', ok: false, error: { code: 'not_allowed' } })
    expect(backend).not.toHaveBeenCalled()
  })

  it.each([
    ['load_session', {}],
    ['load_session', { sessionId: 7 }],
    ['search_sessions', { projectId: 'p' }],
  ])('%s con argomenti sbagliati → bad_request', async (cmd, args) => {
    const { hub, backend } = await started()
    hub.request('r1', cmd, args)
    await vi.waitFor(() => expect(hub.of('Respond')).toHaveLength(1))
    expect(hub.of('Respond')[0]).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    expect(backend).not.toHaveBeenCalled()
  })

  it('a backend error comes back as backend_error', async () => {
    const { hub, backend } = await started()
    backend.mockRejectedValueOnce('database locked')
    hub.request('r1', 'list_projects')
    await vi.waitFor(() => expect(hub.of('Respond')).toHaveLength(1))
    expect(hub.of('Respond')[0]).toMatchObject({
      ok: false, error: { code: 'backend_error', message: 'database locked' },
    })
  })

  it('a response that is too large comes back as too_large', async () => {
    const { hub, backend } = await started()
    backend.mockResolvedValueOnce('x'.repeat(2_000_000))
    hub.request('r1', 'load_session', { sessionId: 's1' })
    await vi.waitFor(() => expect(hub.of('Respond')).toHaveLength(1))
    expect(hub.of('Respond')[0]).toMatchObject({ ok: false, error: { code: 'too_large' } })
  })
})

describe('lifecycle', () => {
  it('counts the viewers watching', async () => {
    const { hub, bridge } = await started()
    hub.viewerCount(2)
    expect(bridge.state.viewerCount).toBe(2)
  })

  it('Stop sharing: CloseRoom, listeners removed, hub stopped, clean state, no more events', async () => {
    const { hub, bridge, unlistened, local } = await started()
    await bridge.stop()

    expect(hub.of('CloseRoom')).toEqual([{ reason: 'stopped' }])
    expect(unlistened.sort()).toEqual([...FORWARDED_EVENTS].sort())
    expect(hub.stopped).toBe(true)
    expect(bridge.state).toMatchObject({ status: 'off', link: '', viewerCount: 0 })

    local('atoms:batch', { sessionId: 's1', payload: [] })
    await flush()
    expect(hub.of('Publish')).toHaveLength(0)
  })

  it('when Pragma closes the reason is app_closing', async () => {
    const { hub, bridge } = await started()
    await bridge.stop('app_closing')
    expect(hub.of('CloseRoom')).toEqual([{ reason: 'app_closing' }])
  })

  it('a relay that does not answer CloseRoom does not hold Pragma hostage', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      const started = s.bridge.start(CFG)
      await vi.runAllTimersAsync()
      await started
      s.hub.invoke = () => new Promise(() => {}) // non risponde mai
      const stopping = s.bridge.stop()
      await vi.advanceTimersByTimeAsync(2500)
      await stopping
      expect(s.bridge.state.status).toBe('off')
      expect(s.hub.stopped).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop without an active sharing does nothing', async () => {
    const { bridge, hub } = setup()
    await bridge.stop()
    expect(hub.calls).toHaveLength(0)
  })

  it('after a stop it can reopen with a new token', async () => {
    const s = await started()
    const first = s.bridge.state.link
    await s.bridge.stop()
    expect(await s.bridge.start(CFG)).toBe(true)
    expect(s.bridge.state.link).not.toBe(first)
  })
})

describe('reconnection', () => {
  it('reopens the room with the same token and asks for realignment', async () => {
    const { hub, bridge } = await started()
    const token = hub.of('OpenRoom')[0].token

    hub.fireReconnecting()
    expect(bridge.state.status).toBe('reconnecting')

    await hub.fireReconnected()
    expect(bridge.state.status).toBe('on')
    expect(hub.of('OpenRoom')).toHaveLength(2)
    expect(hub.of('OpenRoom')[1].token).toBe(token)
    await vi.waitFor(() => expect(hub.of('Publish').at(-1)?.event).toBe('pragma:resync'))
  })

  it('if on return the relay refuses the key, it stops with an error', async () => {
    const { hub, bridge, unlistened } = await started()
    hub.openRoomResults.push({ ok: false, error: 'unauthorized' })
    hub.fireReconnecting()
    await hub.fireReconnected()

    expect(bridge.state.status).toBe('error')
    expect(bridge.state.link).toBe('')
    expect(hub.stopped).toBe(true)
    expect(unlistened).toHaveLength(FORWARDED_EVENTS.length)
  })

  it('an unexpected connection close switches everything off and says so', async () => {
    const { hub, bridge, unlistened } = await started()
    hub.fireClosed(new Error('socket chiuso'))
    await vi.waitFor(() => expect(bridge.state.status).toBe('error'))
    expect(bridge.state.error).toMatch(/socket chiuso/)
    expect(unlistened).toHaveLength(FORWARDED_EVENTS.length)
  })

  it('a close caused by stop is not an error', async () => {
    const { hub, bridge } = await started()
    await bridge.stop()
    hub.fireClosed()
    expect(bridge.state.status).toBe('off')
    expect(bridge.state.error).toBeNull()
  })
})

beforeEach(() => { vi.useRealTimers() })
