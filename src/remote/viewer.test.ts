import { describe, it, expect, vi } from 'vitest'
import type { HubLike } from './bridge'
import { createViewer, RelayError } from './viewer'

type Handler = (...a: any[]) => void

class FakeHub implements HubLike {
  handlers = new Map<string, Handler>()
  calls: { method: string; args: any[] }[] = []
  stopped = false
  startError: Error | null = null
  joinResults: any[] = []
  joinGate: Promise<void> | null = null
  private reconnecting: Handler[] = []
  private reconnected: Handler[] = []
  private closed: Handler[] = []

  async start() { if (this.startError) throw this.startError }
  async stop() { this.stopped = true }
  async invoke(method: string, ...args: any[]): Promise<any> {
    this.calls.push({ method, args })
    if (method === 'Join') {
      if (this.joinGate) await this.joinGate
      return this.joinResults.shift() ?? { ok: true, hostOnline: true, commandsEnabled: false }
    }
    return undefined
  }
  on(m: string, h: Handler) { this.handlers.set(m, h) }
  onreconnecting(cb: Handler) { this.reconnecting.push(cb) }
  onreconnected(cb: Handler) { this.reconnected.push(cb) }
  onclose(cb: Handler) { this.closed.push(cb) }

  of(method: string) { return this.calls.filter(c => c.method === method).map(c => c.args[0]) }
  event(seq: number, event: string, payload: unknown = null) { this.handlers.get('Event')!({ seq, event, payload }) }
  respond(id: string, ok: boolean, result: unknown = null, error?: { code: string; message: string }) {
    this.handlers.get('Response')!({ id, ok, result, error })
  }
  hostStatus(online: boolean, commandsEnabled = false) { this.handlers.get('HostStatus')!({ online, commandsEnabled }) }
  closedMsg(reason: string) { this.handlers.get('Closed')!({ reason }) }
  fireReconnecting() { this.reconnecting.forEach(h => h()) }
  async fireReconnected() { await Promise.all(this.reconnected.map(h => h())) }
  fireClosed(e?: Error) { this.closed.forEach(h => h(e)) }
  lastRequestId() { return this.of('Request').at(-1).id as string }
}

const TOKEN = 'A'.repeat(43)

function setup(token: string | null = TOKEN) {
  const hub = new FakeHub()
  const createHub = vi.fn(() => hub)
  const viewer = createViewer({ token, createHub })
  return { hub, viewer, createHub }
}

async function live() {
  const s = setup()
  await s.viewer.start()
  return s
}

describe('entering the room', () => {
  it('without a token it connects to nothing', async () => {
    const { viewer, createHub } = setup(null)
    await viewer.start()
    expect(viewer.state.status).toBe('no_token')
    expect(createHub).not.toHaveBeenCalled()
    await expect(viewer.invoke('list_projects')).rejects.toMatchObject({ code: 'not_connected' })
  })

  it('joins with the token and goes live, with commands as the PC says', async () => {
    const { hub, viewer } = setup()
    hub.joinResults.push({ ok: true, hostOnline: true, commandsEnabled: true })
    await viewer.start()
    expect(hub.of('Join')).toEqual([{ token: TOKEN }])
    expect(viewer.state).toMatchObject({ status: 'live', hostOnline: true, commandsEnabled: true })
  })

  it('PC not connected: host_offline', async () => {
    const { hub, viewer } = setup()
    hub.joinResults.push({ ok: true, hostOnline: false, commandsEnabled: false })
    await viewer.start()
    expect(viewer.state.status).toBe('host_offline')
  })

  it.each([
    ['not_found', 'not_found'],
    ['room_full', 'room_full'],
    ['not_allowed', 'error'],
    ['boh', 'error'],
  ])('Join rifiutato con %s → stato %s', async (error, status) => {
    const { hub, viewer } = setup()
    hub.joinResults.push({ ok: false, error })
    await viewer.start()
    expect(viewer.state.status).toBe(status)
    expect(viewer.state.error).toBeTruthy()
    await expect(viewer.invoke('list_projects')).rejects.toBeInstanceOf(RelayError)
  })

  it('relay unreachable: error with a message', async () => {
    const { hub, viewer } = setup()
    hub.startError = new Error('boom')
    await viewer.start()
    expect(viewer.state.status).toBe('error')
    expect(viewer.state.error).toMatch(/Could not reach the relay: boom/)
  })

  it('start is idempotent: a single hub', async () => {
    const { viewer, createHub } = setup()
    await Promise.all([viewer.start(), viewer.start()])
    expect(createHub).toHaveBeenCalledTimes(1)
  })
})

describe('invoke', () => {
  it('sends the request and resolves with the result', async () => {
    const { hub, viewer } = await live()
    const p = viewer.invoke<string[]>('list_sessions', { projectId: 'p1' })
    await vi.waitFor(() => expect(hub.of('Request')).toHaveLength(1))

    const req = hub.of('Request')[0]
    expect(req).toMatchObject({ cmd: 'list_sessions', args: { projectId: 'p1' } })
    expect(req.id.length).toBeLessThanOrEqual(64)

    hub.respond(req.id, true, ['s1', 's2'])
    expect(await p).toEqual(['s1', 's2'])
  })

  it('a refusal becomes a RelayError with the relay code and message', async () => {
    const { hub, viewer } = await live()
    const p = viewer.invoke('load_session', { sessionId: 's1' })
    await vi.waitFor(() => expect(hub.of('Request')).toHaveLength(1))
    hub.respond(hub.lastRequestId(), false, null, { code: 'not_allowed', message: 'Commands from the web are switched off on the PC.' })

    const err = (await p.catch((e) => e)) as RelayError
    expect(err).toBeInstanceOf(RelayError)
    expect(err.code).toBe('not_allowed')
    // In the UI errors end up in String(e): without «RelayError:» in front.
    expect(String(err)).toBe('Commands from the web are switched off on the PC.')
  })

  it('file_exists answers by itself, without the network', async () => {
    const { hub, viewer } = await live()
    expect(await viewer.invoke('file_exists', { path: 'C:\\x' })).toBe(true)
    expect(hub.of('Request')).toHaveLength(0)
  })

  it.each([
    'save_settings_cmd', 'pick_directory', 'open_url', 'run_live_command', 'trust_directory',
    'get_pipeline_steps', 'detect_claude', 'get_claude_usage', 'inventato',
  ])('%s is desktop-only: refused at once, without the network', async (cmd) => {
    const { hub, viewer } = await live()
    await expect(viewer.invoke(cmd)).rejects.toMatchObject({ code: 'desktop_only' })
    expect(hub.of('Request')).toHaveLength(0)
  })

  it('with commands off on the PC a command stops here, without asking for the PIN or using the network', async () => {
    const { hub, viewer } = await live()
    await expect(viewer.invoke('run_pragma', { prompt: 'x' })).rejects.toMatchObject({ code: 'not_allowed' })
    expect(viewer.state.pinPrompt).toBe(false)
    expect(hub.of('Request')).toHaveLength(0)
  })

  it('a request made before the Join finishes waits and then goes', async () => {
    const { hub, viewer } = setup()
    let release!: () => void
    hub.joinGate = new Promise<void>((r) => { release = r })
    const started = viewer.start()
    const p = viewer.invoke('list_projects')
    await Promise.resolve()
    expect(hub.of('Request')).toHaveLength(0)

    release()
    await started
    await vi.waitFor(() => expect(hub.of('Request')).toHaveLength(1))
    hub.respond(hub.lastRequestId(), true, [])
    expect(await p).toEqual([])
  })

  it('with no answer it times out with an error', async () => {
    vi.useFakeTimers()
    try {
      const { hub, viewer } = setup()
      const started = viewer.start()
      await vi.runAllTimersAsync()
      await started
      const p = viewer.invoke('list_projects').catch((e) => e)
      await vi.advanceTimersByTimeAsync(41_000)
      expect(await p).toMatchObject({ code: 'timeout' })
      expect(hub.of('Request')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a Response with an unknown id is ignored', async () => {
    const { hub } = await live()
    expect(() => hub.respond('mai-visto', true, 1)).not.toThrow()
  })
})

describe('events', () => {
  it('delivers the payload to the listeners of the right event', async () => {
    const { hub, viewer } = await live()
    const a = vi.fn(); const b = vi.fn()
    await viewer.listen('atoms:batch', a)
    await viewer.listen('pragma:phase', b)

    hub.event(1, 'atoms:batch', { sessionId: 's1', payload: [{ id: 'a' }] })
    expect(a).toHaveBeenCalledWith({ payload: { sessionId: 's1', payload: [{ id: 'a' }] } })
    expect(b).not.toHaveBeenCalled()
  })

  it('unlisten stops delivering', async () => {
    const { hub, viewer } = await live()
    const a = vi.fn()
    const off = await viewer.listen('atoms:batch', a)
    off()
    hub.event(1, 'atoms:batch', {})
    expect(a).not.toHaveBeenCalled()
  })

  it('listening does not wait for the network: it can be registered before the Join', async () => {
    const { viewer } = setup()
    await expect(viewer.listen('atoms:batch', () => {})).resolves.toBeTypeOf('function')
  })
})

describe('realignment', () => {
  it('a continuous sequence realigns nothing', async () => {
    const { hub, viewer } = await live()
    const resync = vi.fn()
    viewer.onResync(resync)
    for (let i = 1; i <= 5; i++) hub.event(i, 'atoms:batch')
    await Promise.resolve()
    expect(resync).not.toHaveBeenCalled()
  })

  it('a gap in the sequence realigns, and events that arrive meanwhile wait', async () => {
    const { hub, viewer } = await live()
    const seen: string[] = []
    await viewer.listen<{ n: number }>('atoms:batch', (e) => seen.push(`ev${e.payload.n}`))

    let release!: () => void
    viewer.onResync(() => new Promise<void>((r) => { seen.push('resync-start'); release = () => { seen.push('resync-end'); r() } }))

    hub.event(1, 'atoms:batch', { n: 1 })
    hub.event(5, 'atoms:batch', { n: 5 }) // buco: 2, 3 e 4 persi
    hub.event(6, 'atoms:batch', { n: 6 })
    expect(seen).toEqual(['ev1', 'resync-start'])

    release()
    await vi.waitFor(() => expect(seen).toEqual(['ev1', 'resync-start', 'resync-end', 'ev5', 'ev6']))
  })

  it('the pragma:resync event realigns and does not reach the listeners', async () => {
    const { hub, viewer } = await live()
    const resync = vi.fn()
    const any = vi.fn()
    viewer.onResync(resync)
    await viewer.listen('pragma:resync', any)
    hub.event(1, 'pragma:resync')
    await vi.waitFor(() => expect(resync).toHaveBeenCalledTimes(1))
    expect(any).not.toHaveBeenCalled()
  })

  it('several realignment requests while one is running merge into a single extra round', async () => {
    const { hub, viewer } = await live()
    let runs = 0
    let release!: () => void
    viewer.onResync(() => { runs++; return new Promise<void>((r) => { release = r }) })

    hub.event(1, 'pragma:resync')
    await vi.waitFor(() => expect(runs).toBe(1))
    hub.event(2, 'pragma:resync')
    hub.event(3, 'pragma:resync')
    release()
    await vi.waitFor(() => expect(runs).toBe(2))
    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(runs).toBe(2)
  })

  it('a handler that fails stops neither the others nor the release of events', async () => {
    const { hub, viewer } = await live()
    const ok = vi.fn()
    viewer.onResync(() => { throw new Error('boom') })
    viewer.onResync(ok)
    const seen = vi.fn()
    await viewer.listen('atoms:batch', seen)

    hub.event(1, 'pragma:resync')
    hub.event(2, 'atoms:batch', { n: 2 })
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1))
    expect(ok).toHaveBeenCalled()
  })
})

describe('the PC comes and goes', () => {
  it('PC drops: requests in progress fail and the state says so', async () => {
    const { hub, viewer } = await live()
    const p = viewer.invoke('list_projects').catch((e) => e)
    await vi.waitFor(() => expect(hub.of('Request')).toHaveLength(1))

    hub.hostStatus(false)
    expect(await p).toMatchObject({ code: 'pc_offline' })
    expect(viewer.state).toMatchObject({ status: 'host_offline', hostOnline: false })
  })

  it('PC comes back: it realigns and commands follow the switch', async () => {
    const { hub, viewer } = await live()
    const resync = vi.fn()
    viewer.onResync(resync)
    hub.hostStatus(false)
    hub.hostStatus(true, true)

    expect(viewer.state).toMatchObject({ status: 'live', hostOnline: true, commandsEnabled: true })
    await vi.waitFor(() => expect(resync).toHaveBeenCalledTimes(1))
  })

  it('the commands switch changes while the PC is there: no realignment', async () => {
    const { hub, viewer } = await live()
    const resync = vi.fn()
    viewer.onResync(resync)
    hub.hostStatus(true, true)
    await Promise.resolve()
    expect(viewer.state.commandsEnabled).toBe(true)
    expect(resync).not.toHaveBeenCalled()
  })
})

describe('end of sharing', () => {
  it('Closed: state closed with the reason, requests in progress failed, hub stopped', async () => {
    const { hub, viewer } = await live()
    const p = viewer.invoke('list_projects').catch((e) => e)
    await vi.waitFor(() => expect(hub.of('Request')).toHaveLength(1))

    hub.closedMsg('stopped')
    expect(await p).toMatchObject({ code: 'closed' })
    expect(viewer.state).toMatchObject({ status: 'closed', closedReason: 'stopped', hostOnline: false })
    expect(hub.stopped).toBe(true)
    await expect(viewer.invoke('list_projects')).rejects.toMatchObject({ code: 'not_connected' })
  })

  it('a connection close after Closed does not turn it into an error', async () => {
    const { hub, viewer } = await live()
    hub.closedMsg('host_gone')
    hub.fireClosed()
    expect(viewer.state.status).toBe('closed')
  })

  it('an unexpected close is an error with the reason', async () => {
    const { hub, viewer } = await live()
    hub.fireClosed(new Error('socket chiuso'))
    expect(viewer.state.status).toBe('error')
    expect(viewer.state.error).toMatch(/socket chiuso/)
  })
})

describe('the viewer network', () => {
  it('drops: reconnecting, and requests in progress fail', async () => {
    const { hub, viewer } = await live()
    const p = viewer.invoke('list_projects').catch((e) => e)
    await vi.waitFor(() => expect(hub.of('Request')).toHaveLength(1))

    hub.fireReconnecting()
    expect(viewer.state.status).toBe('reconnecting')
    expect(await p).toMatchObject({ code: 'not_connected' })
    await expect(viewer.invoke('list_projects')).rejects.toMatchObject({ code: 'not_connected' })
  })

  it('comes back: re-enters the room with the same token and realigns', async () => {
    const { hub, viewer } = await live()
    const resync = vi.fn()
    viewer.onResync(resync)

    hub.fireReconnecting()
    await hub.fireReconnected()

    expect(hub.of('Join')).toEqual([{ token: TOKEN }, { token: TOKEN }])
    expect(viewer.state.status).toBe('live')
    expect(resync).toHaveBeenCalledTimes(1)
  })

  it('after the return the sequence restarts from scratch without faking a gap', async () => {
    const { hub, viewer } = await live()
    const resync = vi.fn()
    viewer.onResync(resync)
    hub.event(10, 'atoms:batch')
    hub.fireReconnecting()
    await hub.fireReconnected()
    resync.mockClear()

    hub.event(41, 'atoms:batch') // first event after the return: no comparison with the old number
    await Promise.resolve()
    expect(resync).not.toHaveBeenCalled()
  })

  it('comes back but the room is gone: not_found', async () => {
    const { hub, viewer } = await live()
    hub.joinResults.push({ ok: false, error: 'not_found' })
    hub.fireReconnecting()
    await hub.fireReconnected()
    expect(viewer.state.status).toBe('not_found')
  })
})

describe('commands with the PIN', () => {
  async function liveWithCommands() {
    const s = setup()
    s.hub.joinResults.push({ ok: true, hostOnline: true, commandsEnabled: true })
    await s.viewer.start()
    return s
  }

  it('the first command asks for the PIN and sends it among the arguments; the second does not ask', async () => {
    const { hub, viewer } = await liveWithCommands()
    const p1 = viewer.invoke('send_control', { sessionId: 's1', message: 'APPROVED' })
    await vi.waitFor(() => expect(viewer.state.pinPrompt).toBe(true))
    expect(hub.of('Request')).toHaveLength(0)

    viewer.providePin('4321')
    await vi.waitFor(() => expect(hub.of('Request')).toHaveLength(1))
    expect(hub.of('Request')[0].args).toEqual({ sessionId: 's1', message: 'APPROVED', pin: '4321' })
    hub.respond(hub.lastRequestId(), true)
    await p1

    const p2 = viewer.invoke('kill_session', { sessionId: 's1' })
    await vi.waitFor(() => expect(hub.of('Request')).toHaveLength(2))
    expect(viewer.state.pinPrompt).toBe(false)
    expect(hub.of('Request')[1].args.pin).toBe('4321')
    hub.respond(hub.lastRequestId(), true)
    await p2
  })

  it('giving up on the PIN cancels the command without sending anything', async () => {
    const { hub, viewer } = await liveWithCommands()
    const p = viewer.invoke('send_control', { sessionId: 's1', message: 'APPROVED' })
    await vi.waitFor(() => expect(viewer.state.pinPrompt).toBe(true))
    viewer.providePin(null)
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
    expect(hub.of('Request')).toHaveLength(0)
  })

  it('wrong PIN: it forgets it, and the next command asks again', async () => {
    const { hub, viewer } = await liveWithCommands()
    const p1 = viewer.invoke('send_control', { sessionId: 's1', message: 'APPROVED' })
    await vi.waitFor(() => expect(viewer.state.pinPrompt).toBe(true))
    viewer.providePin('0000')
    await vi.waitFor(() => expect(hub.of('Request')).toHaveLength(1))
    hub.respond(hub.lastRequestId(), false, null, { code: 'bad_pin', message: 'Wrong PIN.' })
    await expect(p1).rejects.toMatchObject({ code: 'bad_pin' })

    void viewer.invoke('send_control', { sessionId: 's1', message: 'APPROVED' }).catch(() => {})
    await vi.waitFor(() => expect(viewer.state.pinPrompt).toBe(true))
    viewer.providePin(null)
  })

  it('reads do not ask for the PIN and do not carry it', async () => {
    const { hub, viewer } = await liveWithCommands()
    const p = viewer.invoke('load_session', { sessionId: 's1' })
    await vi.waitFor(() => expect(hub.of('Request')).toHaveLength(1))
    expect(viewer.state.pinPrompt).toBe(false)
    expect(hub.of('Request')[0].args).toEqual({ sessionId: 's1' })
    hub.respond(hub.lastRequestId(), true, [])
    await p
  })

  it('save_local_atom goes nowhere: the copy is written by the PC', async () => {
    const { hub, viewer } = await liveWithCommands()
    expect(await viewer.invoke('save_local_atom', { atom: {} })).toBeNull()
    expect(hub.of('Request')).toHaveLength(0)
    expect(viewer.state.pinPrompt).toBe(false)
  })
})
