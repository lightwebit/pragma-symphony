import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// The web page that loses the network in the middle of a phase and comes back. Here the chain is the real one
// on the phone's side — fake relay → viewer (sequence, held events, realignment) →
// web store — and the «PC» is the state the bridge would show it: saved atoms, snapshot, events.
// The criterion: after the reconnection the phase, state and atoms on the web are those of the PC.

const t = vi.hoisted(() => {
  type Handler = (...a: any[]) => void
  const pc = {
    atoms: [] as any[],
    snap: null as any,
    sessions: [] as any[],
    requests: [] as string[],
  }
  const hub = {
    handlers: new Map<string, Handler>(),
    reconnecting: [] as Handler[],
    reconnected: [] as Handler[],
    seq: 0,
    online: true,
    async start() {},
    async stop() {},
    on(m: string, h: Handler) { this.handlers.set(m, h) },
    onreconnecting(cb: Handler) { this.reconnecting.push(cb) },
    onreconnected(cb: Handler) { this.reconnected.push(cb) },
    onclose() {},
    async invoke(method: string, msg: any): Promise<any> {
      if (method === 'Join') return { ok: true, hostOnline: true, commandsEnabled: false }
      if (method === 'Request') {
        pc.requests.push(msg.cmd)
        const result =
          msg.cmd === 'load_session' ? structuredClone(pc.atoms)
          : msg.cmd === 'pragma.snapshot' ? structuredClone(pc.snap)
          : msg.cmd === 'list_sessions' ? structuredClone(pc.sessions)
          : null
        queueMicrotask(() => this.handlers.get('Response')!({ id: msg.id, ok: true, result }))
      }
      return undefined
    },
    /** The PC publishes an event: it arrives only if the phone is online, but the sequence advances anyway. */
    publish(event: string, payload: unknown) {
      const seq = ++this.seq
      if (this.online) this.handlers.get('Event')!({ seq, event, payload })
    },
    dropNetwork() { this.online = false; this.reconnecting.forEach(h => h()) },
    async restoreNetwork() { this.online = true; await Promise.all(this.reconnected.map(h => h())) },
  }
  return { pc, hub }
})

vi.mock('../platform', async () => {
  const { createViewer } = await import('../remote/viewer')
  const viewer = createViewer({ token: 'A'.repeat(43), createHub: () => t.hub as any })
  return {
    IS_WEB: true,
    viewer,
    invoke: viewer.invoke,
    listen: viewer.listen,
    isPermissionGranted: vi.fn(async () => false),
    requestPermission: vi.fn(async () => 'denied'),
    sendNotification: vi.fn(),
  }
})

vi.mock('./projects', () => ({ useProjectStore: () => ({ setCurrentProject: vi.fn() }) }))

import * as platform from '../platform'
import { useSessionStore, type Atom } from './session'

const viewer = (platform as any).viewer as import('../remote/viewer').Viewer
const { pc, hub } = t
const SID = '22222222-2222-4222-8222-222222222222'

function atom(id: string, over: Partial<Atom> = {}): Atom {
  return {
    id, atomType: 'AgentNote', filePath: null, fileType: null, action: null, content: `note ${id}`,
    collapsed: false, source: 'Stdout', receivedAt: '2026-09-23T10:00:00Z', sessionId: SID, ...over,
  }
}

function snap(over: Record<string, unknown> = {}) {
  return {
    running: false, phase: null, turnEnd: null, autoConfirm: true, autoConfirmAt: null,
    lastError: null, usage: null, cache: null, ...over,
  }
}

/** The PC changes: first it updates what a re-read would answer, then it publishes. */
function pcState(over: Record<string, unknown>) {
  pc.snap = snap({ ...pc.snap, ...over })
  hub.publish('pragma:state', { sessionId: SID, payload: pc.snap })
}
function pcAtoms(...list: Atom[]) {
  pc.atoms.push(...list)
  hub.publish('atoms:batch', { sessionId: SID, payload: list })
}
function pcEvent(event: string, payload: unknown) {
  hub.publish(event, { sessionId: SID, payload })
}

const PLAN = atom('plan', { atomType: 'PragmaEvent', content: 'PLAN\nstep one\nstep two' })

async function openAwaitingApproval() {
  pc.atoms = [atom('a1'), PLAN]
  pc.snap = snap({ phase: 'awaiting_approval' })
  const store = useSessionStore()
  await store.initGlobalListeners()
  // The same hook as App.vue: on realignment the open session is re-read.
  viewer.onResync(async () => { if (store.sessionId) await store.refreshFromHost(store.sessionId) })
  await store.loadSession(SID)
  expect(store.sessions[SID].pragma.phase).toBe('awaiting_approval')
  return store
}

/** What the web must have equal to the PC. */
function view(store: ReturnType<typeof useSessionStore>) {
  const s = store.sessions[SID]
  return {
    running: s.running, phase: s.pragma.phase, turnEnd: s.turnEnd,
    autoConfirm: s.autoConfirm, autoConfirmAt: s.autoConfirmAt,
  }
}
function truth() {
  const { running, phase, turnEnd, autoConfirm, autoConfirmAt } = pc.snap
  return { running, phase, turnEnd, autoConfirm, autoConfirmAt }
}

beforeEach(async () => {
  setActivePinia(createPinia())
  pc.atoms = []; pc.snap = null; pc.sessions = []; pc.requests = []
  hub.online = true
  await viewer.start()
})

describe('live, without realignment', () => {
  it('Approve pressed on the PC: the web stops showing «waiting» and knows it is running', async () => {
    const store = await openAwaitingApproval()
    pc.requests = []

    pcState({ running: true, phase: null })
    await vi.waitFor(() => expect(view(store)).toEqual(truth()))
    expect(store.sessions[SID].running).toBe(true)
    // No re-read: the state arrived with the event.
    expect(pc.requests).toEqual([])
  })

  it('the auto-confirm timer on the PC is visible, and disappears when it fires', async () => {
    const store = await openAwaitingApproval()
    pcState({ phase: 'awaiting_confirmation', autoConfirmAt: 1_790_000_000_000 })
    await vi.waitFor(() => expect(store.sessions[SID].autoConfirmAt).toBe(1_790_000_000_000))

    pcState({ running: true, phase: null, autoConfirmAt: null })
    await vi.waitFor(() => expect(view(store)).toEqual(truth()))
  })

  it('a session born on the PC appears in the web list', async () => {
    const store = await openAwaitingApproval()
    await store.fetchSavedSessions('p1')
    pc.requests = []
    pc.sessions = [{ id: 'nuova', projectId: 'p1', title: 'nuova', startedAt: '2026-09-23T10:00:00Z' }]

    hub.publish('pragma:state', { sessionId: 'nuova', payload: snap({ running: true }) })
    await vi.waitFor(() => expect(store.savedSessions.map(s => s.id)).toContain('nuova'))
    expect(pc.requests).toEqual(['list_sessions'])
  })
})

describe('the network drops mid-phase and comes back', () => {
  it('phase, state and atoms after the reconnection are those of the PC', async () => {
    const store = await openAwaitingApproval()

    hub.dropNetwork()
    expect(viewer.state.status).toBe('reconnecting')

    // All of this happens on the PC while the phone is on standby, and the web does not receive it.
    pcState({ running: true, phase: null })
    pcAtoms(atom('a2'), atom('a3'))
    pcEvent('pragma:phase', 'awaiting_confirmation')
    pcEvent('pragma:turn_end', { terminal: true, truncated: false })
    pcState({ running: false, phase: 'awaiting_confirmation', turnEnd: { terminal: true, truncated: false }, autoConfirmAt: 1_790_000_000_000 })
    expect(store.sessions[SID].pragma.phase).toBe('awaiting_approval') // the web has seen nothing

    await hub.restoreNetwork()
    await vi.waitFor(() => expect(viewer.state.status).toBe('live'))
    await vi.waitFor(() => expect(view(store)).toEqual(truth()))
    expect(store.sessions[SID].atoms.map(a => a.id)).toEqual(pc.atoms.map(a => a.id))
    expect(store.sessions[SID].pragma.plan).toEqual({ steps: ['step one', 'step two'] })

    // The PC resumes publishing: a block that repeats an already re-read atom does not double it.
    pcAtoms(atom('a4'))
    hub.publish('atoms:batch', { sessionId: SID, payload: [atom('a3'), atom('a4')] })
    // …and the PC's timer fires: the web follows it without another re-read.
    pcState({ running: true, phase: null, autoConfirmAt: null })
    await vi.waitFor(() => expect(view(store)).toEqual(truth()))
    expect(store.sessions[SID].atoms.map(a => a.id)).toEqual(['a1', 'plan', 'a2', 'a3', 'a4'])
  })

  it('even if it drops after the phase has changed and returns after the turn ended, nothing of the earlier state remains', async () => {
    const store = await openAwaitingApproval()
    hub.dropNetwork()
    pcState({ running: true, phase: null })
    pcAtoms(atom('r', { atomType: 'PragmaEvent', content: 'REPORT\nfatto' }))
    pcState({ running: false, phase: 'awaiting_close', autoConfirmAt: null, turnEnd: { terminal: true, truncated: false } })

    await hub.restoreNetwork()
    await vi.waitFor(() => expect(view(store)).toEqual(truth()))
    expect(store.sessions[SID].pragma.report).toEqual({ text: 'fatto' })
  })
})
