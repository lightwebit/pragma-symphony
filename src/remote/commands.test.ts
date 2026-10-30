import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// On the PC: the web's commands executed by the real desktop store (IS_WEB = false). We look at what
// reaches the backend (`invoke`): execution arguments decided by the desktop, the `Remote` mark,
// no focus stolen, and the double command that does not go through.

const handlers = new Map<string, (e: { payload: unknown }) => void>()
const invoke = vi.fn(async (_cmd: string, _args?: any): Promise<unknown> => undefined)
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
vi.mock('../stores/projects', () => ({ useProjectStore: () => ({ setCurrentProject: vi.fn() }) }))

import { useSessionStore } from '../stores/session'
import { createCommandRunner, CommandRefused } from './commands'

const PROFILES = [
  { label: 'Claude', binary: 'C:/tools/claude.exe', configDir: 'C:/cfg' },
  { label: 'Other', binary: 'C:/tools/other.exe', configDir: null },
]
const PROJECTS = [
  { id: 'p1', workingDir: 'C:/work/shop' },
  { id: 'p2', workingDir: 'C:/work/blog' },
  { id: 'nodir', workingDir: null },
]

function emit(event: string, sessionId: string, payload: unknown) {
  handlers.get(event)!({ payload: { sessionId, payload } })
}

function setup() {
  const store = useSessionStore()
  const refreshLists = vi.fn()
  const runner = createCommandRunner({
    session: store as any,
    profiles: () => PROFILES,
    defaultProfileIndex: () => 0,
    projects: () => PROJECTS,
    invoke: (cmd, args) => invoke(cmd, args) as any,
    refreshLists,
  })
  return { store, runner, refreshLists }
}

const sends = () => invoke.mock.calls.filter(c => c[0] === 'send_control')

/** A session started from the desktop and stopped on the plan awaiting approval. */
async function awaitingApproval(store: ReturnType<typeof useSessionStore>) {
  await store.initGlobalListeners()
  await store.startSession({ prompt: 'plan it', binary: 'C:/tools/claude.exe', projectId: 'p1', workingDir: 'C:/work/shop' })
  const id = store.sessionId!
  emit('pragma:plan', id, { steps: ['one'] })
  emit('pragma:phase', id, 'awaiting_approval')
  emit('session:complete', id, null)
  invoke.mockClear()
  return id
}

beforeEach(() => {
  handlers.clear()
  invoke.mockReset()
  invoke.mockImplementation(async (cmd: string, args?: any) =>
    cmd === 'run_pragma' ? (args.newSessionId ?? args.existingSessionId) : undefined)
  setActivePinia(createPinia())
})

describe('Approve from the web', () => {
  it('goes through the desktop store: binary, config and folder of the session, atom marked Remote', async () => {
    const { store, runner } = setup()
    const id = await awaitingApproval(store)

    await runner.run('send_control', { sessionId: id, message: 'APPROVED' })

    expect(sends()).toHaveLength(1)
    expect(sends()[0][1]).toMatchObject({ sessionId: id, message: 'APPROVED', binary: 'C:/tools/claude.exe', workingDir: 'C:/work/shop' })
    const s = store.sessions[id]
    expect(s.running).toBe(true)
    expect(s.atoms.at(-1)).toMatchObject({ content: '✓ Plan approved', source: 'Remote' })
  })

  it('double Approve, desktop first: the web gets conflict and a single claude starts', async () => {
    const { store, runner } = setup()
    const id = await awaitingApproval(store)

    const desktop = store.sendControl('APPROVED', 'C:/tools/claude.exe')
    const web = runner.run('send_control', { sessionId: id, message: 'APPROVED' })

    await desktop
    await expect(web).rejects.toMatchObject({ code: 'conflict' })
    expect(sends()).toHaveLength(1)
  })

  it('double Approve, web first: the second is a conflict, and the desktop finds the session already running', async () => {
    const { store, runner } = setup()
    const id = await awaitingApproval(store)

    const first = runner.run('send_control', { sessionId: id, message: 'APPROVED' })
    const second = runner.run('send_control', { sessionId: id, message: 'APPROVED' })
    await first
    await expect(second).rejects.toBeInstanceOf(CommandRefused)
    expect(sends()).toHaveLength(1)
    // It is what keeps the desktop's Approve button disabled.
    expect(store.sessions[id].running).toBe(true)
  })

  it('a session waiting for nothing receives no controls', async () => {
    const { store, runner } = setup()
    const id = await awaitingApproval(store)
    emit('pragma:phase', id, null)
    await expect(runner.run('send_control', { sessionId: id, message: 'CONTINUE' })).rejects.toMatchObject({ code: 'conflict' })
    expect(sends()).toHaveLength(0)
  })
})

describe('the other answers', () => {
  it('Modify plan: message intact to the backend, Remote trace', async () => {
    const { store, runner } = setup()
    const id = await awaitingApproval(store)
    await runner.run('send_control', { sessionId: id, message: 'MODIFY_PLAN: fewer steps' })
    expect(sends()[0][1]).toMatchObject({ message: 'MODIFY_PLAN: fewer steps' })
    expect(store.sessions[id].atoms.at(-1)).toMatchObject({ content: '✎ Modify plan: fewer steps', source: 'Remote' })
  })

  it('answers to a question: the message composed by the web arrives as is', async () => {
    const { store, runner } = setup()
    const id = await awaitingApproval(store)
    emit('pragma:phase', id, 'awaiting_answers')
    await runner.run('send_control', { sessionId: id, message: 'ANSWERS:\nQ1: yes' })
    expect(sends()[0][1]).toMatchObject({ message: 'ANSWERS:\nQ1: yes' })
    expect(store.sessions[id].atoms.at(-1)?.source).toBe('Remote')
  })

  it('free text outside a question is bad_request', async () => {
    const { store, runner } = setup()
    const id = await awaitingApproval(store)
    await expect(runner.run('send_control', { sessionId: id, message: 'rm -rf /' })).rejects.toMatchObject({ code: 'bad_request' })
    expect(sends()).toHaveLength(0)
  })
})

describe('start from the web', () => {
  it('new session: project folder, local profile, web id, and the desktop stays where it was', async () => {
    const { store, runner } = setup()
    await store.initGlobalListeners()
    const before = store.sessionId

    const id = await runner.run('run_pragma', {
      prompt: 'add pagination', projectId: 'p2', existingSessionId: null, newSessionId: 'web-new-id',
      title: 'from phone', model: 'opus', profileLabel: 'Other', stepByStep: false, autoConfirm: true,
    })

    expect(id).toBe('web-new-id')
    const call = invoke.mock.calls.find(c => c[0] === 'run_pragma')![1]
    expect(call).toMatchObject({
      prompt: 'add pagination', binary: 'C:/tools/other.exe', configDir: null, workingDir: 'C:/work/blog',
      projectId: 'p2', model: 'opus', attachments: [], newSessionId: 'web-new-id',
    })
    expect(store.sessionId).toBe(before) // niente fuoco rubato
    expect(store.sessions['web-new-id'].autoConfirm).toBe(true)
    expect(store.sessions['web-new-id'].atoms[0]).toMatchObject({ content: 'add pagination', source: 'Remote' })
  })

  it('a profile the PC does not have: the default is used, never an executable chosen by the web', async () => {
    const { store, runner } = setup()
    await store.initGlobalListeners()
    await runner.run('run_pragma', { prompt: 'x', projectId: 'p1', newSessionId: 'n1', profileLabel: 'C:/evil.exe' })
    expect(invoke.mock.calls.find(c => c[0] === 'run_pragma')![1].binary).toBe('C:/tools/claude.exe')
  })

  it('project without a folder: not_allowed, nothing launched', async () => {
    const { runner } = setup()
    await expect(runner.run('run_pragma', { prompt: 'x', projectId: 'nodir', newSessionId: 'n1' }))
      .rejects.toMatchObject({ code: 'not_allowed' })
    expect(invoke).not.toHaveBeenCalledWith('run_pragma', expect.anything())
  })

  it('a session already active on the same project: conflict', async () => {
    const { store, runner } = setup()
    await awaitingApproval(store) // p1, waiting: still active
    await expect(runner.run('run_pragma', { prompt: 'x', projectId: 'p1', newSessionId: 'n2' }))
      .rejects.toMatchObject({ code: 'conflict' })
  })
})

describe('stop and lists', () => {
  it('Stop: stops the running session, leaving a trace; on a stopped one it is a conflict', async () => {
    const { store, runner } = setup()
    const id = await awaitingApproval(store)
    await expect(runner.run('kill_session', { sessionId: id })).rejects.toMatchObject({ code: 'conflict' })

    await runner.run('send_control', { sessionId: id, message: 'APPROVED' })
    await runner.run('kill_session', { sessionId: id })
    expect(invoke).toHaveBeenCalledWith('kill_session', { sessionId: id })
    expect(store.sessions[id].atoms.some(a => a.content === '■ Stopped from the web' && a.source === 'Remote')).toBe(true)
  })

  it('a session scheduled from the web goes to the project folder and without attachments', async () => {
    const { runner, refreshLists } = setup()
    await runner.run('create_scheduled_session', { projectId: 'p1', prompt: 'later', runAt: '2030-01-01T00:00:00Z' })
    expect(invoke).toHaveBeenCalledWith('create_scheduled_session', expect.objectContaining({ workingDir: 'C:/work/shop', attachments: [] }))
    expect(refreshLists).toHaveBeenCalledWith('p1')
  })

  it('save_local_atom is accepted and ignored: the web does not write to the DB', async () => {
    const { runner } = setup()
    expect(await runner.run('save_local_atom', {})).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })
})
