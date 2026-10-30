import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// The store in the web build (IS_WEB = true): a viewer of a session running on the PC. Three things
// must differ from the desktop — it writes nothing, it has no timers of its own, it does not duplicate
// atoms after a realignment — and this file pins them down. The desktop is in session.test.ts.
const handlers = new Map<string, (e: { payload: unknown }) => void>()

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined)
vi.mock('../platform', () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    handlers.set(event, handler)
    return () => {}
  }),
  invoke: (...a: unknown[]) => invoke(...(a as [string, unknown])),
  IS_WEB: true,
  isPermissionGranted: vi.fn(async () => false),
  requestPermission: vi.fn(async () => 'denied'),
  sendNotification: vi.fn(),
}))

vi.mock('./projects', () => ({ useProjectStore: () => ({ setCurrentProject: vi.fn() }) }))

import { useSessionStore, type Atom } from './session'
import { AUTO_CONFIRM_DELAY_MS } from '../PRAGMA_CONSTANTS'

const SID = '11111111-1111-4111-8111-111111111111'

function atom(id: string, over: Partial<Atom> = {}): Atom {
  return {
    id, atomType: 'AgentNote', filePath: null, fileType: null, action: null, content: `note ${id}`,
    collapsed: false, source: 'Stdout', receivedAt: '2026-09-23T10:00:00Z', sessionId: SID, ...over,
  }
}

function emit(event: string, payload: unknown, sessionId = SID) {
  const h = handlers.get(event)
  if (!h) throw new Error(`no listener installed for ${event}`)
  h({ payload: { sessionId, payload } })
}

/** What the PC answers: the saved atoms and the session's live state. */
function host(opts: { atoms?: Atom[]; snapshot?: unknown } = {}) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'load_session') return opts.atoms ?? []
    if (cmd === 'pragma.snapshot') return opts.snapshot ?? null
    return undefined
  })
}

async function open(opts: Parameters<typeof host>[0] = {}) {
  host(opts)
  const store = useSessionStore()
  await store.initGlobalListeners()
  await store.loadSession(SID)
  return store
}

beforeEach(() => {
  handlers.clear()
  invoke.mockReset()
  setActivePinia(createPinia())
})

afterEach(() => { vi.useRealTimers() })

describe('opening a session from the web', () => {
  it('re-reads atoms and live state from the PC: running, which phase, how the turn ended', async () => {
    const store = await open({
      atoms: [atom('a1')],
      snapshot: {
        running: true, phase: 'awaiting_approval', turnEnd: { terminal: true, truncated: false },
        autoConfirm: true, lastError: 'ops', usage: null, cache: null,
      },
    })
    const s = store.sessions[SID]
    expect(s.atoms.map(a => a.id)).toEqual(['a1'])
    expect(s.running).toBe(true)
    expect(s.pragma.phase).toBe('awaiting_approval')
    expect(s.turnEnd).toEqual({ terminal: true, truncated: false })
    expect(s.autoConfirm).toBe(true)
    expect(s.lastError).toBe('ops')
    expect(invoke).toHaveBeenCalledWith('pragma.snapshot', { sessionId: SID })
  })

  it('a session not in memory on the PC stays as it is: saved atoms only', async () => {
    const store = await open({ atoms: [atom('a1')], snapshot: null })
    expect(store.sessions[SID].running).toBe(false)
    expect(store.sessions[SID].pragma.phase).toBeNull()
  })

  it('if the live state does not arrive, the session opens anyway', async () => {
    host({ atoms: [atom('a1')] })
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'pragma.snapshot') throw new Error('not_connected')
      return cmd === 'load_session' ? [atom('a1')] : undefined
    })
    const store = useSessionStore()
    await store.loadSession(SID)
    expect(store.sessions[SID].atoms).toHaveLength(1)
    expect(store.sessions[SID].lastError).toBeNull()
  })
})

describe('no duplicates after a realignment', () => {
  it('an atom already in the re-read list is not added a second time', async () => {
    const store = await open({ atoms: [atom('a1')] })
    emit('atoms:batch', [atom('a1'), atom('a2')])
    expect(store.sessions[SID].atoms.map(a => a.id)).toEqual(['a1', 'a2'])
  })

  it('a block made only of known atoms does not touch the new-atoms counter', async () => {
    const store = await open({ atoms: [atom('a1')] })
    store.sessions[SID].scrollLocked = false
    emit('atoms:batch', [atom('a1')])
    expect(store.sessions[SID].newCount).toBe(0)
    emit('atoms:batch', [atom('a3')])
    expect(store.sessions[SID].newCount).toBe(1)
  })

  it('a phase card already in the re-read list does not appear twice if the event arrives too', async () => {
    const store = await open({ atoms: [atom('p1', { atomType: 'PragmaEvent', content: 'ANALYSIS\nsame text' })] })
    emit('pragma:analysis', { text: 'same text' })
    const cards = store.sessions[SID].atoms.filter(a => a.atomType === 'PragmaEvent')
    expect(cards).toHaveLength(1)
    expect(store.sessions[SID].pragma.analysis).toEqual({ text: 'same text' })
  })

  it('a new phase event does, and updates the card', async () => {
    const store = await open()
    emit('pragma:plan', { steps: ['one', 'two'] })
    const cards = store.sessions[SID].atoms.filter(a => a.atomType === 'PragmaEvent')
    expect(cards.map(a => a.content)).toEqual(['PLAN\none\ntwo'])
    expect(store.sessions[SID].pragma.plan).toEqual({ steps: ['one', 'two'] })
  })
})

describe('the web writes nothing and has no timers of its own', () => {
  it('phase events cause no save_local_atom', async () => {
    await open()
    emit('pragma:analysis', { text: 'a' })
    emit('pragma:plan', { steps: ['x'] })
    emit('pragma:report', { text: 'r' })
    expect(invoke.mock.calls.map(c => c[0])).not.toContain('save_local_atom')
  })

  it('l\'auto-conferma non parte da sola: il timer è del PC', async () => {
    vi.useFakeTimers()
    const store = await open({ snapshot: { running: true, phase: null, turnEnd: null, autoConfirm: true, lastError: null, usage: null, cache: null } })
    // On the web `binary` is empty and `sendControlTo` would exit on its own before calling the backend:
    // one is given, so a timer that did fire would produce a visible send_control.
    store.sessions[SID].binary = 'claude'
    emit('pragma:phase', 'awaiting_confirmation')
    emit('session:complete', null)

    await vi.advanceTimersByTimeAsync(AUTO_CONFIRM_DELAY_MS * 3)
    expect(invoke.mock.calls.map(c => c[0])).not.toContain('send_control')
  })
})

describe('a command from the web reaches the relay, and if refused it shows', () => {
  const waiting = { running: false, phase: 'awaiting_approval', turnEnd: null, autoConfirm: false, lastError: null, usage: null, cache: null }
  const refuse = () => {
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'send_control') throw new Error('Commands from the web are switched off on the PC.')
      return base(cmd, args)
    })
  }

  it('Approve with an empty binary (always the case on the web) still calls the backend', async () => {
    const store = await open({ snapshot: waiting })
    expect(store.sessions[SID].binary).toBeFalsy()
    refuse()
    await store.sendControl('APPROVED', '')
    expect(invoke.mock.calls.map(c => c[0])).toContain('send_control')
  })

  it('on refusal shows why and puts the phase back as on the PC', async () => {
    const store = await open({ snapshot: waiting })
    refuse()
    await store.sendControl('APPROVED', '')
    const s = store.sessions[SID]
    expect(s.lastError).toContain('switched off on the PC')
    expect(s.pragma.phase).toBe('awaiting_approval')
    expect(s.running).toBe(false)
  })

  it('also holds for answers to questions and for plan edits', async () => {
    const store = await open({ snapshot: { ...waiting, phase: 'awaiting_answers' } })
    refuse()
    await store.sendAnswers({ q1: 'yes' }, '')
    expect(store.sessions[SID].lastError).toContain('switched off on the PC')
    expect(store.sessions[SID].pragma.phase).toBe('awaiting_answers')

    store.sessions[SID].lastError = null
    await store.sendModifyPlan('cambia', '')
    expect(store.sessions[SID].lastError).toContain('switched off on the PC')
    expect(store.sessions[SID].pragma.phase).toBe('awaiting_answers')
  })
})

describe('realignment of the open session', () => {
  it('replaces atoms with the PC ones, rebuilds the cards and takes the live state', async () => {
    const store = await open({ atoms: [atom('a1')], snapshot: { running: true, phase: null, turnEnd: null, autoConfirm: false, lastError: null, usage: null, cache: null } })
    expect(store.sessions[SID].running).toBe(true)

    host({
      atoms: [atom('a1'), atom('a2'), atom('r1', { atomType: 'PragmaEvent', content: 'REPORT\ndone' })],
      snapshot: { running: false, phase: 'awaiting_close', turnEnd: { terminal: true, truncated: false }, autoConfirm: false, lastError: null, usage: null, cache: null },
    })
    await store.refreshFromHost(SID)

    const s = store.sessions[SID]
    expect(s.atoms.map(a => a.id)).toEqual(['a1', 'a2', 'r1'])
    expect(s.pragma.report).toEqual({ text: 'done' })
    expect(s.running).toBe(false)
    expect(s.pragma.phase).toBe('awaiting_close')
  })

  it('a session not open on the web is not touched', async () => {
    host({ atoms: [atom('a1')] })
    const store = useSessionStore()
    await store.refreshFromHost('mai-aperta')
    expect(invoke).not.toHaveBeenCalled()
  })
})
