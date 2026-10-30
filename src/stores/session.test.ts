import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// Tauri events are global: the test captures the handlers installed by
// initGlobalListeners and calls them by hand, as the backend would.
const handlers = new Map<string, (e: { payload: unknown }) => void>()

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined)
vi.mock('../platform', () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    handlers.set(event, handler)
    return () => {}
  }),
  invoke: (...a: unknown[]) => invoke(...(a as [string, unknown])),
  IS_WEB: false,
  isPermissionGranted: vi.fn(async () => false),
  requestPermission: vi.fn(async () => 'denied'),
  sendNotification: vi.fn(),
}))

// The project store touches localStorage in setup: nothing is needed here beyond the method
// that followProjectOf might call.
const setCurrentProject = vi.fn()
vi.mock('./projects', () => ({ useProjectStore: () => ({ setCurrentProject }) }))

import { useSessionStore, dirKey, isSessionActive, type SessionState } from './session'
import { AUTO_CONFIRM_DELAY_MS } from '../PRAGMA_CONSTANTS'

/** Consegna un evento in busta `{ sessionId, payload }` come events.rs. */
function emit(event: string, sessionId: string, payload: unknown) {
  const h = handlers.get(event)
  if (!h) throw new Error(`no listener installed for ${event}`)
  h({ payload: { sessionId, payload } })
}

function state(init: Partial<SessionState> = {}): SessionState {
  return {
    id: 'x', projectId: 'p', atoms: [], running: false, stoppedByUser: false,
    newCount: 0, scrollLocked: true, lastError: null, title: '', workingDir: '',
    attachments: [], gitBranch: null, model: 'sonnet', usage: null, cache: null, turnEnd: null, stepTokenStart: null,
    completedSteps: [], reviewAccepted: false, reviewFixSent: false, binary: '', configDir: null, autoConfirm: false, autoConfirmAt: null, questionsThisTurn: false,
    pragma: {
      analysis: null, questions: null, plan: null, phase: null, report: null,
      tests: null, closing: null, rawNote: null, verify: null, review: null,
    },
    ...init,
  }
}

type Store = ReturnType<typeof useSessionStore>

/** Starts a real session going through the guard and the invoke, and returns its id. */
async function start(store: Store, projectId: string, workingDir: string, opts: Record<string, unknown> = {}) {
  invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'run_pragma') return (args as { newSessionId: string }).newSessionId
    return undefined
  })
  await store.startSession({
    prompt: 'do a thing', binary: 'claude', projectId, workingDir, ...opts,
  })
  return store.sessionId as string
}

beforeEach(() => {
  handlers.clear()
  invoke.mockReset()
  invoke.mockImplementation(async () => undefined)
  setActivePinia(createPinia())
})

describe('dirKey', () => {
  it('ignores separators and trailing slash', () => {
    expect(dirKey('C:\\proj\\app\\')).toBe(dirKey('C:/proj/app'))
    expect(dirKey('/home/u/app//')).toBe('/home/u/app')
  })

  it('is case-insensitive only on Windows paths', () => {
    expect(dirKey('C:\\Proj\\App')).toBe(dirKey('c:/proj/app'))
    expect(dirKey('/home/u/App')).not.toBe(dirKey('/home/u/app'))
  })
})

describe('isSessionActive', () => {
  it('is active while running', () => {
    expect(isSessionActive(state({ running: true }))).toBe(true)
  })

  it('is active even when stopped, if the protocol is waiting for an answer', () => {
    // The process is not there but the session will write to its working dir again:
    // for the one-session-per-directory guard it counts as much as one that is running.
    expect(isSessionActive(state({ running: false, pragma: { ...state().pragma, phase: 'awaiting_approval' } }))).toBe(true)
  })

  it('is not active if only opened to re-read it', () => {
    expect(isSessionActive(state())).toBe(false)
  })

  it('is not active if the protocol reached awaiting_close (terminal phase)', () => {
    // Found by testing live: nothing resets pragma.phase
    // to null after CLOSING ends the protocol, so without this exception
    // a fully finished session (VERIFY+REVIEW included) blocked a
    // new session on the same working dir forever.
    expect(isSessionActive(state({ running: false, pragma: { ...state().pragma, phase: 'awaiting_close' } }))).toBe(false)
  })
})

describe('event router', () => {
  it('delivers atoms to the envelope session, not to the focused one', async () => {
    const store = useSessionStore()
    await store.initGlobalListeners()
    const a = await start(store, 'p1', 'C:/a')
    const b = await start(store, 'p2', 'C:/b')
    expect(store.sessionId).toBe(b)

    const atom = { id: 'at1', atomType: 'AgentNote', filePath: null, fileType: null,
      action: null, content: 'from A', collapsed: false, source: 'Stdout',
      receivedAt: '', sessionId: a }
    emit('atoms:batch', a, [atom])

    expect(store.sessions[a].atoms.map(x => x.content)).toContain('from A')
    expect(store.sessions[b].atoms.map(x => x.content)).not.toContain('from A')
  })

  it('ignores events of sessions no longer in memory', async () => {
    const store = useSessionStore()
    await store.initGlobalListeners()
    expect(() => emit('atoms:batch', 'ghost-id', [])).not.toThrow()
    expect(store.sessions['ghost-id']).toBeUndefined()
  })

  it('the pragma phase lands on its own session, not on the active one', async () => {
    const store = useSessionStore()
    await store.initGlobalListeners()
    const a = await start(store, 'p1', 'C:/a')
    const b = await start(store, 'p2', 'C:/b')

    emit('pragma:phase', a, 'awaiting_approval')

    expect(store.sessions[a].pragma.phase).toBe('awaiting_approval')
    expect(store.sessions[b].pragma.phase).toBeNull()
    expect(store.pragmaPhase).toBeNull() // the proxy looks at B, which is focused
  })

  it('an error stops only the session that emitted it', async () => {
    const store = useSessionStore()
    await store.initGlobalListeners()
    const a = await start(store, 'p1', 'C:/a')
    const b = await start(store, 'p2', 'C:/b')

    emit('session:error', a, { code: 'spawn', message: 'boom' })

    expect(store.sessions[a].lastError).toBe('boom')
    expect(store.sessions[a].running).toBe(false)
    expect(store.sessions[b].lastError).toBeNull()
    expect(store.sessions[b].running).toBe(true)
  })

  it('the user stop does not become an error to show', async () => {
    const store = useSessionStore()
    await store.initGlobalListeners()
    const a = await start(store, 'p1', 'C:/a')
    store.sessions[a].stoppedByUser = true

    emit('session:error', a, { code: 'killed', message: 'process killed' })

    expect(store.sessions[a].lastError).toBeNull()
    expect(store.sessions[a].stoppedByUser).toBe(false)
  })

  it('session:complete switches off only its own session', async () => {
    const store = useSessionStore()
    await store.initGlobalListeners()
    const a = await start(store, 'p1', 'C:/a')
    const b = await start(store, 'p2', 'C:/b')

    emit('session:complete', a, null)

    expect(store.sessions[a].running).toBe(false)
    expect(store.sessions[b].running).toBe(true)
  })

  it('the new-atoms counter grows only when scroll is unlocked', async () => {
    const store = useSessionStore()
    await store.initGlobalListeners()
    const a = await start(store, 'p1', 'C:/a')

    emit('atoms:batch', a, [{ content: 'one' }])
    expect(store.sessions[a].newCount).toBe(0)

    store.sessions[a].scrollLocked = false
    emit('atoms:batch', a, [{ content: 'two' }, { content: 'three' }])
    expect(store.sessions[a].newCount).toBe(2)
  })

  it('token usage updates per session', async () => {
    const store = useSessionStore()
    await store.initGlobalListeners()
    const a = await start(store, 'p1', 'C:/a')
    const b = await start(store, 'p2', 'C:/b')

    emit('session:usage', a, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0,
      cacheWriteTokens: 0, model: 'sonnet', totalCostUsd: null })

    expect(store.sessions[a].usage?.inputTokens).toBe(10)
    expect(store.sessions[b].usage).toBeNull()
  })

  it('how the turn ended reaches its session and resets on the next turn', async () => {
    const store = useSessionStore()
    await store.initGlobalListeners()
    const a = await start(store, 'p1', 'C:/a')
    emit('pragma:turn_end', a, { terminal: false, truncated: false })
    emit('session:complete', a, null)
    expect(store.sessions[a].turnEnd).toEqual({ terminal: false, truncated: false })

    invoke.mockImplementation(async () => undefined)
    await store.startSession({ prompt: 'avanti', binary: 'claude', projectId: 'p1', workingDir: 'C:/a', resumeId: a })

    expect(store.sessions[a].turnEnd).toBeNull()
  })

  it('the cache snapshot goes to its session and a pure hit keeps the lifetime', async () => {
    const store = useSessionStore()
    await store.initGlobalListeners()
    const a = await start(store, 'p1', 'C:/a')
    const b = await start(store, 'p2', 'C:/b')

    emit('session:cache', a, { contextTokens: 40_000, ttlSecs: 3600, lastCallAt: '2026-09-23T08:00:00Z' })
    emit('session:cache', a, { contextTokens: 41_000, ttlSecs: null, lastCallAt: '2026-09-23T08:01:00Z' })

    expect(store.sessions[a].cache).toEqual({
      contextTokens: 41_000, ttlSecs: 3600, lastCallAt: '2026-09-23T08:01:00Z',
    })
    expect(store.sessions[b].cache).toBeNull()
  })
})

describe('one-session-per-directory guard — parallelism only between different projects', () => {
  it('refuses a second session on the same project', async () => {
    const store = useSessionStore()
    await start(store, 'p1', 'C:/a')
    invoke.mockClear()

    await expect(start(store, 'p1', 'C:/altra-dir')).rejects.toThrow(/still active/i)
    expect(invoke).not.toHaveBeenCalledWith('run_pragma', expect.anything())
  })

  it('refuses two different projects on the same working dir', async () => {
    const store = useSessionStore()
    await start(store, 'p1', 'C:\\Proj\\App')
    invoke.mockClear()

    // Same dir written differently: the guard normalizes like dir_key in Rust.
    await expect(start(store, 'p2', 'c:/proj/app/')).rejects.toThrow(/session branch/i)
    expect(invoke).not.toHaveBeenCalledWith('run_pragma', expect.anything())
  })

  it('refuses even when the session is stopped but waiting for an answer', async () => {
    const store = useSessionStore()
    await store.initGlobalListeners()
    const a = await start(store, 'p1', 'C:/a')
    emit('session:complete', a, null)
    emit('pragma:phase', a, 'awaiting_answers')
    expect(store.sessions[a].running).toBe(false)

    await expect(start(store, 'p1', 'C:/a')).rejects.toThrow(/still active/i)
  })

  it('admits two different projects on different directories', async () => {
    const store = useSessionStore()
    const a = await start(store, 'p1', 'C:/a')
    const b = await start(store, 'p2', 'C:/b')

    expect(a).not.toBe(b)
    expect(store.sessions[a].running).toBe(true)
    expect(store.sessions[b].running).toBe(true)
    expect(store.liveSessions).toHaveLength(2)
  })

  it('a session merely opened does not block the project', async () => {
    const store = useSessionStore()
    await store.initGlobalListeners()
    const a = await start(store, 'p1', 'C:/a')
    emit('session:complete', a, null) // finished: neither running nor waiting

    const b = await start(store, 'p1', 'C:/a')
    expect(b).not.toBe(a)
    expect(store.sessions[b].running).toBe(true)
  })

  it('a superseded session (resumed with a summary) no longer blocks the project', async () => {
    const store = useSessionStore()
    await store.initGlobalListeners()
    const a = await start(store, 'p1', 'C:/a')
    emit('session:complete', a, null)
    emit('pragma:phase', a, 'awaiting_confirmation')
    await expect(start(store, 'p1', 'C:/a')).rejects.toThrow(/still active/i)

    store.supersedeSession(a)

    const b = await start(store, 'p1', 'C:/a')
    expect(b).not.toBe(a)
  })

  it('supersedeSession does not touch a running session', async () => {
    const store = useSessionStore()
    const a = await start(store, 'p1', 'C:/a')
    store.sessions[a].pragma.phase = 'awaiting_confirmation'

    store.supersedeSession(a)

    expect(store.sessions[a].pragma.phase).toBe('awaiting_confirmation')
  })

  it('the refusal message names the session in progress', async () => {
    const store = useSessionStore()
    const a = await start(store, 'p1', 'C:/a', { title: 'refactor parser' })
    expect(store.sessions[a].title).toBe('refactor parser')

    await expect(start(store, 'p1', 'C:/a')).rejects.toThrow(/refactor parser/)
  })
})

describe('backend refusal', () => {
  it('goes back to the draft without losing prompt and attachments', async () => {
    const store = useSessionStore()
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'run_pragma') throw new Error('working directory is busy')
      return undefined
    })

    await expect(store.startSession({
      prompt: 'x', binary: 'claude', projectId: 'p1', workingDir: 'C:/a',
      title: 'titolo', attachments: ['C:/a/note.md'],
    })).rejects.toThrow(/busy/)

    // No phantom record: only the draft, which took over what the user had prepared.
    expect(Object.values(store.sessions).filter(s => s.id !== null)).toHaveLength(0)
    expect(store.sessionAttachments).toEqual(['C:/a/note.md'])
    expect(store.sessionTitle).toBe('titolo')
    expect(store.running).toBe(false)
  })
})

describe('auto-confirm per session', () => {
  // The timer's expiry is what the web receives to say «continue by itself».
  it('writes the deadline when Continue is armed, and clears it when it fires or is cancelled', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-23T12:00:00Z'))
      const store = useSessionStore()
      await store.initGlobalListeners()
      const a = await start(store, 'p1', 'C:/a', { autoConfirm: true })
      expect(store.sessions[a].autoConfirmAt).toBeNull()

      emit('pragma:phase', a, 'awaiting_confirmation')
      // Armed but with the turn still open: no timer, hence no expiry.
      expect(store.sessions[a].autoConfirmAt).toBeNull()
      emit('session:complete', a, null)
      expect(store.sessions[a].autoConfirmAt).toBe(Date.now() + AUTO_CONFIRM_DELAY_MS)

      vi.advanceTimersByTime(AUTO_CONFIRM_DELAY_MS + 10)
      expect(store.sessions[a].autoConfirmAt).toBeNull()

      // Second round: this time the user presses Continue by hand before the timer.
      emit('pragma:phase', a, 'awaiting_confirmation')
      emit('session:complete', a, null)
      expect(store.sessions[a].autoConfirmAt).not.toBeNull()
      await store.sendControl('CONTINUE', 'claude')
      expect(store.sessions[a].autoConfirmAt).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues the background session, not the focused one', async () => {
    vi.useFakeTimers()
    try {
      const store = useSessionStore()
      await store.initGlobalListeners()
      const a = await start(store, 'p1', 'C:/a', { autoConfirm: true })
      const b = await start(store, 'p2', 'C:/b', { autoConfirm: false })
      expect(store.sessionId).toBe(b)
      invoke.mockClear()

      emit('pragma:phase', a, 'awaiting_confirmation')
      emit('pragma:phase', b, 'awaiting_confirmation')
      emit('session:complete', a, null)
      emit('session:complete', b, null)
      vi.advanceTimersByTime(AUTO_CONFIRM_DELAY_MS + 10)

      const controls = invoke.mock.calls.filter(c => c[0] === 'send_control')
      expect(controls).toHaveLength(1)
      expect(controls[0][1]).toMatchObject({ sessionId: a, message: 'CONTINUE' })
      expect(store.sessions[b].pragma.phase).toBe('awaiting_confirmation')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not continue if the phase changed in the meantime', async () => {
    vi.useFakeTimers()
    try {
      const store = useSessionStore()
      await store.initGlobalListeners()
      const a = await start(store, 'p1', 'C:/a', { autoConfirm: true })
      invoke.mockClear()

      emit('pragma:phase', a, 'awaiting_confirmation')
      emit('session:complete', a, null)
      store.sessions[a].pragma.phase = null // l'utente ha approvato o fermato a mano
      vi.advanceTimersByTime(AUTO_CONFIRM_DELAY_MS + 10)

      expect(invoke.mock.calls.filter(c => c[0] === 'send_control')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not continue if the same turn emitted QUESTIONS and PLAN', async () => {
    vi.useFakeTimers()
    try {
      const store = useSessionStore()
      await store.initGlobalListeners()
      const a = await start(store, 'p1', 'C:/a', { autoConfirm: true })
      invoke.mockClear()

      emit('pragma:questions', a, { items: [{ text: 'lo tengo o lo sostituisco?', options: [] }] })
      emit('pragma:plan', a, { steps: ['1. fare'] })
      emit('pragma:phase', a, 'awaiting_confirmation')
      emit('session:complete', a, null)
      vi.advanceTimersByTime(AUTO_CONFIRM_DELAY_MS + 10)

      expect(invoke.mock.calls.filter(c => c[0] === 'send_control')).toHaveLength(0)
      expect(store.sessions[a].pragma.phase).toBe('awaiting_confirmation')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not continue even if between QUESTIONS and PLAN the turn emitted AWAITING_ANSWERS', async () => {
    vi.useFakeTimers()
    try {
      const store = useSessionStore()
      await store.initGlobalListeners()
      const a = await start(store, 'p1', 'C:/a', { autoConfirm: true })
      invoke.mockClear()

      emit('pragma:questions', a, { items: [{ text: 'lo tengo o lo sostituisco?', options: [] }] })
      emit('pragma:phase', a, 'awaiting_answers')
      emit('pragma:plan', a, { steps: ['1. fare'] })
      emit('pragma:phase', a, 'awaiting_confirmation')
      emit('session:complete', a, null)
      vi.advanceTimersByTime(AUTO_CONFIRM_DELAY_MS + 10)

      expect(invoke.mock.calls.filter(c => c[0] === 'send_control')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a turn with QUESTIONS that ended in error does not block auto-confirm of the next turn', async () => {
    vi.useFakeTimers()
    try {
      const store = useSessionStore()
      await store.initGlobalListeners()
      const a = await start(store, 'p1', 'C:/a', { autoConfirm: true })

      emit('pragma:questions', a, { items: [{ text: 'quale?', options: [] }] })
      emit('session:error', a, { code: 'x', message: 'boom' })
      invoke.mockClear()

      emit('pragma:plan', a, { steps: ['1. fare'] })
      emit('pragma:phase', a, 'awaiting_confirmation')
      emit('session:complete', a, null)
      vi.advanceTimersByTime(AUTO_CONFIRM_DELAY_MS + 10)

      expect(invoke.mock.calls.filter(c => c[0] === 'send_control')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the QUESTIONS of an earlier turn do not block the PLAN of the next turn', async () => {
    vi.useFakeTimers()
    try {
      const store = useSessionStore()
      await store.initGlobalListeners()
      const a = await start(store, 'p1', 'C:/a', { autoConfirm: true })

      emit('pragma:questions', a, { items: [{ text: 'quale?', options: [] }] })
      emit('pragma:phase', a, 'awaiting_answers')
      emit('session:complete', a, null)
      invoke.mockClear()

      emit('pragma:plan', a, { steps: ['1. fare'] })
      emit('pragma:phase', a, 'awaiting_confirmation')
      emit('session:complete', a, null)
      vi.advanceTimersByTime(AUTO_CONFIRM_DELAY_MS + 10)

      const controls = invoke.mock.calls.filter(c => c[0] === 'send_control')
      expect(controls).toHaveLength(1)
      expect(controls[0][1]).toMatchObject({ sessionId: a, message: 'CONTINUE' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for the end of the turn: the marker alone does not send Continue', async () => {
    vi.useFakeTimers()
    try {
      const store = useSessionStore()
      await store.initGlobalListeners()
      const a = await start(store, 'p1', 'C:/a', { autoConfirm: true })
      invoke.mockClear()

      // The marker arrives while the turn's process is still writing: no Continue, however
      // much time passes, until the turn is closed.
      emit('pragma:phase', a, 'awaiting_confirmation')
      vi.advanceTimersByTime(AUTO_CONFIRM_DELAY_MS * 10)
      expect(invoke.mock.calls.filter(c => c[0] === 'send_control')).toHaveLength(0)

      emit('pragma:turn_end', a, { terminal: true, truncated: false })
      emit('session:complete', a, null)
      vi.advanceTimersByTime(AUTO_CONFIRM_DELAY_MS + 10)

      const controls = invoke.mock.calls.filter(c => c[0] === 'send_control')
      expect(controls).toHaveLength(1)
      // The continuation turn runs: no late `session:complete` from the previous turn
      // can set `running` back to false.
      expect(store.sessions[a].running).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not continue a truncated turn by itself: the PLAN may be half-written', async () => {
    vi.useFakeTimers()
    try {
      const store = useSessionStore()
      await store.initGlobalListeners()
      const a = await start(store, 'p1', 'C:/a', { autoConfirm: true })
      invoke.mockClear()

      emit('pragma:phase', a, 'awaiting_confirmation')
      emit('pragma:turn_end', a, { terminal: true, truncated: true })
      emit('session:complete', a, null)
      vi.advanceTimersByTime(AUTO_CONFIRM_DELAY_MS + 10)

      expect(invoke.mock.calls.filter(c => c[0] === 'send_control')).toHaveLength(0)
      expect(store.sessions[a].pragma.phase).toBe('awaiting_confirmation')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('session switch', () => {
  it('switching to another session does not stop the one that is running', async () => {
    const store = useSessionStore()
    const a = await start(store, 'p1', 'C:/a')
    const b = await start(store, 'p2', 'C:/b')

    await store.loadSession(a)

    expect(store.sessionId).toBe(a)
    expect(store.sessions[b].running).toBe(true)
    expect(invoke).not.toHaveBeenCalledWith('kill_session', expect.anything())
    // A session already in memory is not reloaded from the DB: it is only a focus change.
    expect(invoke).not.toHaveBeenCalledWith('load_session', expect.anything())
  })

  it('newSession goes back to the draft leaving the others alive', async () => {
    const store = useSessionStore()
    const a = await start(store, 'p1', 'C:/a')

    store.newSession()

    expect(store.sessionId).toBeNull()
    expect(store.sessions[a].running).toBe(true)
    expect(store.liveSessions.map(s => s.id)).toEqual([a])
  })

  it('closed sessions do not stay in memory after a switch', async () => {
    const store = useSessionStore()
    await store.initGlobalListeners()
    const a = await start(store, 'p1', 'C:/a')
    emit('session:complete', a, null)
    const b = await start(store, 'p2', 'C:/b')

    expect(store.sessions[a]).toBeUndefined()
    expect(store.sessions[b].running).toBe(true)
  })
})

describe('adoptScheduledSession — sessions started by the scheduler', () => {
  // Targeted regression: route() (used by initGlobalListeners) delivers events
  // only to sessions already present in `sessions`. In the manual flow the state is born
  // from startSession() *before* the invoke; in the scheduled flow it is born on the Rust side,
  // so without adoptScheduledSession the session would really run but the UI
  // would stay mute — exactly the bug this test blocks.
  it('creates the session state and makes it reachable from the event router', async () => {
    const store = useSessionStore()
    await store.initGlobalListeners()

    store.adoptScheduledSession({
      sessionId: 'sched-1',
      projectId: 'p1',
      prompt: 'do the scheduled thing',
      title: 'Nightly build',
      workingDir: 'C:/a',
      model: 'sonnet',
      autoConfirm: true,
      binary: 'claude',
      configDir: null,
    })

    expect(store.sessions['sched-1'].running).toBe(true)
    expect(store.sessions['sched-1'].atoms).toHaveLength(1)

    emit('atoms:batch', 'sched-1', [{ content: 'streamed output' }])
    expect(store.sessions['sched-1'].atoms).toHaveLength(2)
  })

  it('does not steal focus from the active session', async () => {
    const store = useSessionStore()
    const a = await start(store, 'p1', 'C:/a')

    store.adoptScheduledSession({
      sessionId: 'sched-2',
      projectId: 'p2',
      prompt: 'x',
      title: null,
      workingDir: 'C:/b',
      model: 'sonnet',
      autoConfirm: false,
      binary: 'claude',
      configDir: null,
    })

    expect(store.sessionId).toBe(a)
    expect(store.sessions['sched-2'].running).toBe(true)
  })

  it('injects into savedSessions only if the project is the focused one', async () => {
    const store = useSessionStore()
    store.activeProjectId = 'p1'

    store.adoptScheduledSession({
      sessionId: 'sched-3',
      projectId: 'p2',
      prompt: 'other project',
      title: null,
      workingDir: null,
      model: 'sonnet',
      autoConfirm: false,
      binary: 'claude',
      configDir: null,
    })

    expect(store.savedSessions.find(s => s.id === 'sched-3')).toBeUndefined()
  })

  it('scheduler:fired adopts the session with the event fields', async () => {
    const store = useSessionStore()
    await store.initGlobalListeners()

    const h = handlers.get('scheduler:fired')
    expect(h).toBeDefined()
    h!({
      payload: {
        scheduled: {
          id: 'row-1', projectId: 'p1', prompt: 'hello', runAt: '2026-08-16T21:30:00Z',
          workingDir: 'C:/a', profileLabel: null, model: 'opus', attachments: [],
          title: 'Scheduled task', stepByStep: false, autoConfirm: true, status: 'fired',
          sessionId: 'sched-4', lastError: null, createdAt: '', updatedAt: '',
        },
        sessionId: 'sched-4',
        binary: 'claude',
        configDir: '/cfg',
      },
    })

    const s = store.sessions['sched-4']
    expect(s).toBeDefined()
    expect(s.title).toBe('Scheduled task')
    expect(s.model).toBe('opus')
    expect(s.binary).toBe('claude')
    expect(s.configDir).toBe('/cfg')
    expect(s.running).toBe(true)
  })
})

describe('export Markdown', () => {
  function atom(atomType: string, content: string) {
    return {
      id: crypto.randomUUID(), atomType, filePath: null, fileType: null, action: null, content,
      collapsed: false, source: 'Stdout', receivedAt: '2026-09-19T10:00:00Z', sessionId: 's',
    }
  }

  async function exportedMarkdown(atoms: unknown[]): Promise<string> {
    const store = useSessionStore()
    await start(store, 'p1', 'C:/w')
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'load_session') return atoms
      if (cmd === 'export_session_to_markdown') return 'written'
      return undefined
    })
    await store.exportCurrentSessionMarkdown()
    const call = invoke.mock.calls.find(c => c[0] === 'export_session_to_markdown')
    return (call?.[1] as { content: string }).content
  }

  it('without protocol markers it falls back to the raw notes', async () => {
    const md = await exportedMarkdown([
      atom('UserReply', 'do a thing'),
      atom('AgentNote', 'plain answer without markers'),
    ])
    expect(md).toContain('## Response')
    expect(md).toContain('plain answer without markers')
  })

  it('with protocol markers it exports the sections', async () => {
    const md = await exportedMarkdown([
      atom('PragmaEvent', 'ANALYSIS\nthe analysis text'),
    ])
    expect(md).toContain('## Analysis')
    expect(md).toContain('the analysis text')
  })
})

describe('a new prompt on the same session', () => {
  function ev(content: string, atomType = 'PragmaEvent') {
    return { id: crypto.randomUUID(), atomType, filePath: null, fileType: null, action: null,
      content, collapsed: false, source: 'Stdout', receivedAt: '', sessionId: 's1' }
  }

  // Real case: the right column still said SESSION COMPLETE
  // from the previous work while the new one was running.
  it('clears the cards of the previous work', async () => {
    const store = useSessionStore()
    await store.initGlobalListeners()
    const id = await start(store, 'p1', 'C:/w')
    emit('pragma:closing', id, { text: 'The first task is closed' })
    emit('pragma:report', id, { text: 'The first task is done' })
    emit('pragma:step_complete', id, { step: 1, result: 'ok' })
    emit('session:complete', id, null)
    expect(store.sessions[id].pragma.closing).not.toBeNull()

    invoke.mockImplementation(async (cmd: string) => (cmd === 'run_pragma' ? id : undefined))
    await store.startSession({
      prompt: 'run the next task', binary: 'claude', projectId: 'p1', workingDir: 'C:/w', resumeId: id,
    })

    const s = store.sessions[id]
    expect(s.pragma.closing).toBeNull()
    expect(s.pragma.report).toBeNull()
    expect(s.completedSteps).toEqual([])
    expect(s.running).toBe(true)
  })

  it('reopened from the DB, shows only the cards after the last separator', async () => {
    const store = useSessionStore()
    invoke.mockImplementation(async (cmd: string) => (cmd === 'load_session'
      ? [
          ev('PLAN\n1. vecchio'),
          ev('CLOSING\nThe first task is closed'),
          ev('\x00separator', 'UserReply'),
          ev('PLAN\n1. nuovo'),
        ]
      : undefined))

    await store.loadSession('s1')

    const s = store.sessions.s1
    expect(s.pragma.plan).toEqual({ steps: ['1. nuovo'] })
    expect(s.pragma.closing).toBeNull()
  })
})
