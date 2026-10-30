// The «web» side of the relay: the noema.tools page talks to the hub as a viewer and makes the
// rest of the app believe it is inside Tauri (`invoke`, `listen`). Like `bridge.ts`, it knows neither
// SignalR nor the browser directly: the hub comes from outside, so it can be tested with a fake one.

import { reactive } from 'vue'
import type { HubLike } from './bridge'
import { RESYNC_EVENT, webRouteOf } from './policy'

export type LinkStatus =
  | 'connecting'     // primo collegamento in corso
  | 'live'           // inside the room, the PC is there
  | 'host_offline'   // inside the room, but the PC dropped: waiting for it to come back
  | 'reconnecting'   // the viewer's network dropped: retrying by itself
  | 'no_token'       // opened without the full link
  | 'not_found'      // the link is no longer valid (Pragma is not shared, or was restarted)
  | 'closed'         // sharing ended while watching
  | 'room_full'
  | 'error'

export interface WebLinkState {
  status: LinkStatus
  hostOnline: boolean
  /** The «Allow commands from web» switch on the PC. Says whether it makes sense to show the buttons. */
  commandsEnabled: boolean
  closedReason: string | null
  error: string | null
  /** A command is waiting for the PIN: the page shows the prompt and answers with `providePin`. */
  pinPrompt: boolean
}

export interface ViewerDeps {
  createHub(): HubLike
  /** The link token (the `#t=` fragment of the URL), or null if missing. */
  token: string | null
}

interface EventMessage { seq: number; event: string; payload: unknown }
interface ResponseMessage {
  id: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string } | null
}
interface JoinResult {
  ok: boolean
  error?: string | null
  hostOnline?: boolean
  commandsEnabled?: boolean
}

/** A refusal that carries the protocol code (`not_allowed`, `pc_offline`…). */
export class RelayError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'RelayError'
  }
  // In the UI errors end up in `String(e)`: without the class name in front.
  override toString() { return this.message }
}

const REQUEST_TIMEOUT_MS = 40_000 // the relay times out at 30 s: here there is a second cordon
const JOIN_ERRORS: Record<string, { status: LinkStatus; message: string }> = {
  not_found: { status: 'not_found', message: 'This link is no longer active.' },
  room_full: { status: 'room_full', message: 'Too many people are watching this Pragma.' },
  not_allowed: { status: 'error', message: 'The relay refused this page.' },
}

type Listener = (e: { payload: unknown }) => void

export function createViewer(deps: ViewerDeps) {
  const state = reactive<WebLinkState>({
    status: deps.token ? 'connecting' : 'no_token',
    hostOnline: false,
    commandsEnabled: false,
    closedReason: null,
    error: null,
    pinPrompt: false,
  })

  // The command PIN: asked at the first command, kept only in memory, forgotten if the PC
  // refuses it. Closing the tab loses it, which is intended.
  let pin: string | null = null
  let pinWaiter: ((p: string | null) => void) | null = null

  function askPin(): Promise<string | null> {
    pinWaiter?.(null)
    state.pinPrompt = true
    return new Promise((resolve) => { pinWaiter = resolve })
  }

  /** The answer to the PIN request: the PIN, or null if the user gave up. */
  function providePin(p: string | null) {
    const w = pinWaiter
    pinWaiter = null
    state.pinPrompt = false
    w?.(p)
  }

  const listeners = new Map<string, Set<Listener>>()
  const resyncHandlers = new Set<() => Promise<void> | void>()
  const pending = new Map<string, {
    resolve(v: unknown): void
    reject(e: unknown): void
    timer: ReturnType<typeof setTimeout>
  }>()
  let counter = 0
  let hub: HubLike | null = null
  let lastSeq: number | null = null
  let resyncing = false
  let resyncAgain = false
  let held: EventMessage[] = []
  let ready: Promise<void> | null = null

  // -- richieste ---------------------------------------------------------------

  function rejectAllPending(reason: Error) {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(reason) }
    pending.clear()
  }

  function settle(m: ResponseMessage) {
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    clearTimeout(p.timer)
    if (m.ok) p.resolve(m.result ?? null)
    else p.reject(new RelayError(m.error?.code ?? 'backend_error', m.error?.message ?? 'The PC could not do that.'))
  }

  async function invoke<T>(cmd: string, args?: unknown): Promise<T> {
    // Things that make no sense on the web do not even make the network round trip; and `file_exists`
    // probes the PC's disk, where attachments by definition are not: here it is «exists».
    if (cmd === 'file_exists') return true as T
    if (webRouteOf(cmd) === 'desktop_only') {
      throw new RelayError('desktop_only', 'This is only available in the desktop app.')
    }

    if (ready) await ready
    if (state.status !== 'live' && state.status !== 'host_offline') {
      throw new RelayError('not_connected', 'Not connected to Pragma.')
    }

    const isCommand = webRouteOf(cmd) === 'command'
    if (isCommand) {
      // The saved copy of the atoms is written by the PC: nothing to send.
      if (cmd === 'save_local_atom') return null as T
      if (!state.commandsEnabled) {
        throw new RelayError('not_allowed', 'Commands from the web are switched off on the PC.')
      }
      if (!pin) pin = await askPin()
      if (!pin) throw new RelayError('cancelled', 'Cancelled — no PIN entered.')
      args = { ...((args ?? {}) as Record<string, unknown>), pin }
    }

    const id = `${Date.now().toString(36)}-${(++counter).toString(36)}`
    const answer = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new RelayError('timeout', 'Pragma did not answer in time.'))
      }, REQUEST_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
    })
    try {
      await hub!.invoke('Request', { id, cmd, args: args ?? {} })
    } catch (e) {
      const p = pending.get(id)
      if (p) { clearTimeout(p.timer); pending.delete(id) }
      throw new RelayError('relay_error', e instanceof Error ? e.message : String(e))
    }
    if (!isCommand) return answer as Promise<T>
    return (answer as Promise<T>).catch((e) => {
      // Wrong PIN, or commands locked on the PC: asked again next time.
      if (e instanceof RelayError && (e.code === 'bad_pin' || e.code === 'locked')) pin = null
      throw e
    })
  }

  // -- eventi ------------------------------------------------------------------

  async function listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<() => void> {
    let set = listeners.get(event)
    if (!set) { set = new Set(); listeners.set(event, set) }
    set.add(cb as Listener)
    return () => { set!.delete(cb as Listener) }
  }

  function deliver(m: EventMessage) {
    for (const cb of listeners.get(m.event) ?? []) cb({ payload: m.payload })
  }

  function onResync(cb: () => Promise<void> | void): () => void {
    resyncHandlers.add(cb)
    return () => { resyncHandlers.delete(cb) }
  }

  /** Realignment: incoming events are held back, the lists are re-read
   *  from the PC, then they are released. Whoever receives them discards duplicates by id. */
  async function resync() {
    if (resyncing) { resyncAgain = true; return }
    resyncing = true
    try {
      do {
        resyncAgain = false
        // `async` so that even a handler that throws synchronously does not stop the others.
        await Promise.allSettled([...resyncHandlers].map(async (h) => h()))
      } while (resyncAgain)
    } finally {
      resyncing = false
      const queued = held
      held = []
      for (const m of queued) deliver(m)
    }
  }

  function onEvent(m: EventMessage) {
    // A gap in the sequence means lost events: it realigns instead of showing a session full of holes.
    const gap = lastSeq !== null && m.seq !== lastSeq + 1
    lastSeq = m.seq
    if (m.event === RESYNC_EVENT) { void resync(); return }
    // The realignment starts first (sets `resyncing` immediately): even the event that
    // revealed the gap is held back, not delivered before the lists are re-read.
    if (gap) void resync()
    if (resyncing) held.push(m)
    else deliver(m)
  }

  // -- collegamento ------------------------------------------------------------

  async function join(): Promise<boolean> {
    const res = await hub!.invoke<JoinResult>('Join', { token: deps.token })
    if (!res.ok) {
      const known = JOIN_ERRORS[res.error ?? '']
      state.status = known?.status ?? 'error'
      state.error = known?.message ?? 'Could not join.'
      return false
    }
    state.hostOnline = !!res.hostOnline
    state.commandsEnabled = !!res.commandsEnabled
    state.status = state.hostOnline ? 'live' : 'host_offline'
    state.error = null
    return true
  }

  function closeHub() {
    const h = hub
    hub = null
    if (h) void h.stop().catch(() => {})
  }

  /** Opens the connection. Whoever calls `invoke` before it finishes waits here. */
  function start(): Promise<void> {
    if (ready) return ready
    if (!deps.token) return (ready = Promise.resolve())

    hub = deps.createHub()
    hub.on('Event', (m: EventMessage) => onEvent(m))
    hub.on('Response', (m: ResponseMessage) => settle(m))
    hub.on('HostStatus', (m: { online: boolean; commandsEnabled: boolean }) => {
      const cameBack = m.online && !state.hostOnline
      state.hostOnline = m.online
      state.commandsEnabled = m.commandsEnabled
      if (state.status === 'live' || state.status === 'host_offline') {
        state.status = m.online ? 'live' : 'host_offline'
      }
      if (!m.online) rejectAllPending(new RelayError('pc_offline', 'The PC is offline.'))
      if (cameBack) void resync()
    })
    hub.on('Closed', (m: { reason: string }) => {
      state.status = 'closed'
      state.closedReason = m.reason
      state.hostOnline = false
      rejectAllPending(new RelayError('closed', 'Sharing has stopped.'))
      closeHub()
    })
    hub.onreconnecting(() => {
      if (state.status === 'live' || state.status === 'host_offline') state.status = 'reconnecting'
      rejectAllPending(new RelayError('not_connected', 'Connection lost.'))
    })
    hub.onreconnected(async () => {
      // A new connection is a connection with no role: it re-enters the room with the token.
      lastSeq = null
      try {
        if (await join()) await resync()
      } catch (e) {
        state.status = 'error'
        state.error = e instanceof Error ? e.message : String(e)
      }
    })
    hub.onclose((e) => {
      if (state.status === 'closed' || state.status === 'not_found') return
      state.status = 'error'
      state.error = e ? `Connection lost: ${e.message}` : 'Connection closed.'
      rejectAllPending(new RelayError('not_connected', 'Connection lost.'))
    })

    const h = hub
    ready = (async () => {
      try {
        await h.start()
        await join()
      } catch (e) {
        state.status = 'error'
        state.error = `Could not reach the relay: ${e instanceof Error ? e.message : String(e)}`
      }
    })()
    return ready
  }

  return { state, invoke, listen, onResync, start, stop: closeHub, providePin }
}

export type Viewer = ReturnType<typeof createViewer>
