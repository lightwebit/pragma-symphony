// Bridge between Pragma on the PC and the noema.tools relay (the local frontend
// is the one talking to the relay). It forwards the events the UI already receives and answers the reads
// the web asks for, after checking them here.
//
// Nothing in this file knows Tauri or SignalR directly: hub, `listen` and `invoke` come
// from outside, so the behaviour can be tested with a fake hub.

import { reactive } from 'vue'
import {
  FORWARDED_EVENTS, PROTOCOL_VERSION, RESYNC_EVENT, STATE_EVENT,
  cleanArgs, cleanCommandArgs, isCommandCommand, isReadCommand, redactSettings,
  type CommandCommand,
} from './policy'

/** The part of `HubConnection` the bridge needs. */
export interface HubLike {
  start(): Promise<void>
  stop(): Promise<void>
  invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T>
  on(method: string, handler: (...args: any[]) => void): void
  onreconnecting(cb: (error?: Error) => void): void
  onreconnected(cb: () => void): void
  onclose(cb: (error?: Error) => void): void
}

export interface BridgeDeps {
  createHub(url: string): HubLike
  listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<() => void>
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>
  /** Live state of a session from the store, or null if it is not in memory. */
  snapshot(sessionId: string): unknown
  appVersion: string
  /** Commands from the web. Absent = no commands, whatever the relay asks. */
  commands?: {
    /** «Allow commands from web» acceso E un PIN impostato. */
    enabled(): boolean
    checkPin(pin: unknown): Promise<boolean>
    /** Runs the already-cleaned command; a refusal carries `code` (`conflict`, `not_allowed`…). */
    run(cmd: CommandCommand, args: Record<string, unknown>): Promise<unknown>
  }
}

export interface BridgeConfig {
  hubUrl: string
  hostSecret: string
}

export type ShareStatus = 'off' | 'connecting' | 'on' | 'reconnecting' | 'error'

export interface BridgeState {
  status: ShareStatus
  viewerCount: number
  /** Link to send to the phone; empty until sharing. */
  link: string
  error: string | null
}

interface HostRequest { rid: string; cmd: string; args: unknown }
interface OpenRoomResult { ok: boolean; error?: string | null }
interface QueuedEvent { seq: number; event: string; payload: unknown; size: number }

// Protocol limits.
const MAX_QUEUE_MESSAGES = 500
const MAX_QUEUE_BYTES = 5 * 1024 * 1024
const MAX_MESSAGE_BYTES = 1_900_000 // below the hub's 2 MB, with margin for the envelope
const CLOSE_TIMEOUT_MS = 2000
/** Wrong PINs before commands lock until the next sharing. */
export const MAX_BAD_PINS = 5

export const DEFAULT_HUB_URL = 'https://noema.tools/hubs/pragma-live'

/** 32 random bytes in base64url (43 characters): it is the link, so it must be unpredictable. */
export function newToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The key travels to the configured URL: in plain text only to the machine itself. */
export function validateHubUrl(raw: string): string | null {
  let url: URL
  try { url = new URL(raw) } catch { return 'The relay URL is not a valid URL.' }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:' && local) return null
  return 'The relay URL must be https (plain http only for localhost).'
}

const OPEN_ERRORS: Record<string, string> = {
  unauthorized: 'The relay refused the access key.',
  bad_request: 'The relay rejected the connection (protocol mismatch).',
}

interface Run {
  hub: HubLike
  cfg: BridgeConfig
  token: string
  seq: number
  pending: QueuedEvent[]
  pendingBytes: number
  pumping: boolean
  unlisten: Array<() => void>
  stopping: boolean
  /** Consecutive wrong PINs in this sharing; at `MAX_BAD_PINS` commands lock. */
  badPins: number
  locked: boolean
}

export function createBridge(deps: BridgeDeps) {
  const state = reactive<BridgeState>({ status: 'off', viewerCount: 0, link: '', error: null })
  let run: Run | null = null

  function fail(message: string) {
    state.status = 'error'
    state.error = message
    state.link = ''
    state.viewerCount = 0
  }

  async function openRoom(r: Run): Promise<OpenRoomResult> {
    return r.hub.invoke<OpenRoomResult>('OpenRoom', {
      hostSecret: r.cfg.hostSecret,
      token: r.token,
      protocolVersion: PROTOCOL_VERSION,
      appVersion: deps.appVersion,
      commandsEnabled: commandsOn(r),
    })
  }

  function commandsOn(r: Run): boolean {
    return !r.locked && !!deps.commands?.enabled()
  }

  /** The commands switch changed on the PC (or they locked): the relay and the viewers know right away. */
  function syncCommands() {
    const r = run
    if (!r || state.status !== 'on') return
    r.hub.invoke('SetCommandsEnabled', commandsOn(r)).catch(() => { /* lo ripete la riapertura */ })
  }

  // -- events towards the relay ------------------------------------------------

  function push(r: Run, event: string, payload: unknown, size: number) {
    r.pending.push({ seq: ++r.seq, event, payload, size })
    r.pendingBytes += size
    if (r.pending.length > MAX_QUEUE_MESSAGES || r.pendingBytes > MAX_QUEUE_BYTES) {
      // Very slow network: better to drop the queue and make the viewers realign than to pile up.
      r.pending.length = 0
      r.pendingBytes = 0
      r.pending.push({ seq: ++r.seq, event: RESYNC_EVENT, payload: null, size: 0 })
    }
    if (!r.pumping) void pump(r)
  }

  async function pump(r: Run) {
    r.pumping = true
    try {
      while (r.pending.length > 0) {
        const item = r.pending.shift()!
        r.pendingBytes -= item.size
        try {
          await r.hub.invoke('Publish', { seq: item.seq, event: item.event, payload: item.payload })
        } catch {
          // Connection dropped: lost events are recovered by realigning after the reconnection.
        }
      }
    } finally {
      r.pumping = false
    }
  }

  function onLocalEvent(r: Run, event: string, payload: unknown) {
    if (state.status !== 'on' || r.stopping) return
    const size = JSON.stringify(payload ?? null).length
    if (size > MAX_MESSAGE_BYTES) {
      push(r, RESYNC_EVENT, null, 0) // an event that is too big is not sent: realign instead
      return
    }
    push(r, event, payload ?? null, size)
  }

  // -- requests from the relay ------------------------------------------------

  async function answer(r: Run, req: HostRequest) {
    // A malformed message (broken or compromised relay) does not even have a `rid` to answer:
    // it is discarded, instead of ending in an unhandled exception.
    if (!req || typeof req !== 'object' || typeof req.rid !== 'string' || typeof req.cmd !== 'string') return
    const reply = (ok: boolean, result: unknown, error?: { code: string; message: string }) =>
      r.hub.invoke('Respond', { rid: req.rid, ok, result: ok ? (result ?? null) : null, error: ok ? null : error })
        .catch(() => { /* the relay will time the request out */ })

    if (isCommandCommand(req.cmd)) {
      await answerCommand(r, req, reply)
      return
    }
    if (!isReadCommand(req.cmd)) {
      await reply(false, null, { code: 'not_allowed', message: 'Command not allowed.' })
      return
    }
    const args = cleanArgs(req.cmd, req.args)
    if (!args) {
      await reply(false, null, { code: 'bad_request', message: 'Missing or invalid arguments.' })
      return
    }

    let result: unknown
    try {
      if (req.cmd === 'pragma.snapshot') result = deps.snapshot(args.sessionId) ?? null
      else if (req.cmd === 'get_settings') result = redactSettings(await deps.invoke('get_settings'))
      else result = await deps.invoke(req.cmd, args)
    } catch (e) {
      await reply(false, null, { code: 'backend_error', message: String(e) })
      return
    }

    if (JSON.stringify(result ?? null).length > MAX_MESSAGE_BYTES) {
      await reply(false, null, { code: 'too_large', message: 'The answer is too large.' })
      return
    }
    await reply(true, result)
  }

  /** A command from the web: switch, PIN, cleaned arguments, then the desktop store. */
  async function answerCommand(
    r: Run,
    req: HostRequest,
    reply: (ok: boolean, result: unknown, error?: { code: string; message: string }) => Promise<unknown>,
  ) {
    const cmd = req.cmd as CommandCommand
    const c = deps.commands
    if (r.locked) {
      await reply(false, null, { code: 'locked', message: 'Too many wrong PINs — commands are locked until sharing is restarted on the PC.' })
      return
    }
    if (!c || !c.enabled()) {
      await reply(false, null, { code: 'not_allowed', message: 'Commands from the web are switched off on the PC.' })
      return
    }
    const raw = req.args !== null && typeof req.args === 'object' ? (req.args as Record<string, unknown>) : {}
    if (!(await c.checkPin(raw.pin))) {
      r.badPins++
      if (r.badPins >= MAX_BAD_PINS) {
        r.locked = true
        syncCommands()
        await reply(false, null, { code: 'locked', message: 'Too many wrong PINs — commands are locked until sharing is restarted on the PC.' })
      } else {
        await reply(false, null, { code: 'bad_pin', message: 'Wrong PIN.' })
      }
      return
    }
    r.badPins = 0
    const args = cleanCommandArgs(cmd, raw)
    if (!args) {
      await reply(false, null, { code: 'bad_request', message: 'Missing or invalid arguments.' })
      return
    }
    let result: unknown
    try {
      result = await c.run(cmd, args)
    } catch (e) {
      const code = e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string'
        ? (e as { code: string }).code
        : 'backend_error'
      await reply(false, null, { code, message: e instanceof Error ? e.message : String(e) })
      return
    }
    await reply(true, result ?? null)
  }

  // -- ciclo di vita ----------------------------------------------------------

  async function teardown(r: Run) {
    r.stopping = true
    for (const un of r.unlisten) { try { un() } catch { /* already removed */ } }
    r.unlisten = []
    try { await r.hub.stop() } catch { /* already closed */ }
  }

  /** Opens sharing. Returns true if the room is open; if not, `state.error` says why. */
  async function start(cfg: BridgeConfig): Promise<boolean> {
    if (run || state.status === 'connecting' || state.status === 'on' || state.status === 'reconnecting') return false
    state.error = null

    if (!cfg.hostSecret.trim()) { fail('Set the access key in Settings first.'); return false }
    const badUrl = validateHubUrl(cfg.hubUrl)
    if (badUrl) { fail(badUrl); return false }

    state.status = 'connecting'
    const hub = deps.createHub(cfg.hubUrl)
    const r: Run = {
      hub, cfg, token: newToken(), seq: 0, pending: [], pendingBytes: 0,
      pumping: false, unlisten: [], stopping: false, badPins: 0, locked: false,
    }
    run = r

    hub.on('Request', (req: HostRequest) => { if (!r.stopping) void answer(r, req) })
    hub.on('ViewerCount', (m: { count: number }) => { if (!r.stopping) state.viewerCount = m.count })
    hub.onreconnecting(() => { if (!r.stopping) state.status = 'reconnecting' })
    hub.onreconnected(async () => {
      if (r.stopping) return
      try {
        const res = await openRoom(r)
        if (!res.ok) throw new Error(OPEN_ERRORS[res.error ?? ''] ?? 'The relay refused the connection.')
        state.status = 'on'
        push(r, RESYNC_EVENT, null, 0) // events emitted while we were offline did not arrive
      } catch (e) {
        await teardown(r)
        run = null
        fail(e instanceof Error ? e.message : String(e))
      }
    })
    hub.onclose((e) => {
      if (r.stopping) return
      void teardown(r).then(() => {
        run = null
        fail(e ? `Connection to the relay lost: ${e.message}` : 'Connection to the relay closed.')
      })
    })

    try {
      await hub.start()
      const res = await openRoom(r)
      if (!res.ok) {
        await teardown(r)
        run = null
        fail(OPEN_ERRORS[res.error ?? ''] ?? 'The relay refused the connection.')
        return false
      }
    } catch (e) {
      await teardown(r)
      run = null
      fail(`Could not reach the relay: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }

    for (const name of FORWARDED_EVENTS) {
      try {
        r.unlisten.push(await deps.listen<unknown>(name, (e) => onLocalEvent(r, name, e.payload)))
      } catch (e) {
        await teardown(r)
        run = null
        fail(`Could not listen to ${name}: ${String(e)}`)
        return false
      }
    }

    state.link = `${new URL(cfg.hubUrl).origin}/pragma-symphony/live#t=${r.token}`
    state.viewerCount = 0
    state.status = 'on'
    return true
  }

  /** Closes sharing: the link dies right away. `app_closing` is for Pragma closing. */
  async function stop(reason: 'stopped' | 'app_closing' = 'stopped') {
    const r = run
    if (!r) return
    run = null
    state.status = 'off'
    state.link = ''
    state.viewerCount = 0
    state.error = null
    r.stopping = true
    // The clean close has a maximum time: a relay that does not answer does not hold Pragma hostage.
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      r.hub.invoke('CloseRoom', { reason }).catch(() => {}),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, CLOSE_TIMEOUT_MS) }),
    ])
    clearTimeout(timer)
    await teardown(r)
  }

  /** A session's live state changed on the PC: it goes out as `pragma:state`, in the same
   *  queue and with the same sequence as the events, so it arrives after the ones that caused it. */
  function publishState(sessionId: string, snapshot: unknown) {
    const r = run
    if (!r || !snapshot) return
    onLocalEvent(r, STATE_EVENT, { sessionId, payload: snapshot })
  }

  return { state, start, stop, publishState, syncCommands }
}

export type Bridge = ReturnType<typeof createBridge>
