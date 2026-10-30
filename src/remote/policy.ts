// Rules of the bridge towards the relay.
// They are the FIRST line of defence: the relay applies the same lists, but it is the second. There is
// deliberately nothing to configure here — changing what can be done from the web means
// changing code and going through a review.

export const PROTOCOL_VERSION = 1

/** Read-only commands the web may ask for. Commands that change something
 *  (start, approval, todo…) come with the «Allow commands» switch. */
export const READ_COMMANDS = [
  'list_projects',
  'get_project',
  'list_sessions',
  'search_sessions',
  'load_session',
  'list_scheduled_sessions',
  'list_todos',
  'get_settings',
  'pragma.snapshot',
] as const

export type ReadCommand = (typeof READ_COMMANDS)[number]

/** Commands that change something. The bridge refuses them while commands are not
 *  enabled; the web version forwards them anyway, because the relay's refusal tells
 *  the user *why* («Commands from the web are switched off on the PC»). */
export const COMMAND_COMMANDS = [
  'run_pragma', 'send_control', 'review_fix', 'kill_session', 'save_local_atom',
  'create_scheduled_session', 'cancel_scheduled_session', 'reschedule_scheduled_session',
  'run_scheduled_session_now',
  'create_todo', 'set_todo_done', 'update_todo_text', 'delete_todo', 'clear_done_todos',
  'pragma.review_accept',
] as const

export type CommandCommand = (typeof COMMAND_COMMANDS)[number]

export function isCommandCommand(cmd: unknown): cmd is CommandCommand {
  return typeof cmd === 'string' && (COMMAND_COMMANDS as readonly string[]).includes(cmd)
}

// Command arguments, a whitelist like for reads: what is not listed never
// reaches execution. `binary`, `configDir`, `workingDir` and
// `attachments` are missing on purpose: the web expresses an intention, the desktop decides with what and where to run it.
// The PIN travels among the arguments but is not listed: the bridge strips it.
type ArgKind = 'id' | 'id?' | 'text' | 'text?' | 'bool' | 'bool?' | 'model?'

const MAX_TEXT_CHARS = 100_000
const MODELS = ['sonnet', 'opus', 'fable']

const COMMAND_ARG_KEYS: Record<CommandCommand, Record<string, ArgKind>> = {
  run_pragma: {
    prompt: 'text', projectId: 'id', existingSessionId: 'id?', newSessionId: 'id?',
    title: 'text?', model: 'model?', profileLabel: 'text?', stepByStep: 'bool?', autoConfirm: 'bool?',
  },
  send_control: { sessionId: 'id', message: 'text' },
  review_fix: { sessionId: 'id' },
  kill_session: { sessionId: 'id' },
  save_local_atom: {},
  create_scheduled_session: {
    projectId: 'id', prompt: 'text', runAt: 'id', profileLabel: 'text?', model: 'model?',
    title: 'text?', stepByStep: 'bool?', autoConfirm: 'bool?',
  },
  cancel_scheduled_session: { id: 'id' },
  reschedule_scheduled_session: { id: 'id', runAt: 'id' },
  run_scheduled_session_now: { id: 'id' },
  create_todo: { projectId: 'id', text: 'text' },
  set_todo_done: { id: 'id', done: 'bool' },
  update_todo_text: { id: 'id', text: 'text' },
  delete_todo: { id: 'id' },
  clear_done_todos: { projectId: 'id' },
  'pragma.review_accept': { sessionId: 'id' },
}

/** Cleaned arguments of a command, or `null` if one is missing or has the wrong type. Absent
 *  optional ones become `null`. */
export function cleanCommandArgs(cmd: CommandCommand, args: unknown): Record<string, unknown> | null {
  const src = args !== null && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {}
  const out: Record<string, unknown> = {}
  for (const [key, kind] of Object.entries(COMMAND_ARG_KEYS[cmd])) {
    const v = src[key]
    const optional = kind.endsWith('?')
    if (optional && (v === undefined || v === null)) { out[key] = null; continue }
    switch (kind.replace('?', '')) {
      case 'id':
        if (typeof v !== 'string' || v.length === 0 || v.length > MAX_ARG_CHARS) return null
        break
      case 'text':
        if (typeof v !== 'string' || v.length > MAX_TEXT_CHARS || (!optional && v.trim() === '')) return null
        break
      case 'bool':
        if (typeof v !== 'boolean') return null
        break
      case 'model':
        if (typeof v !== 'string' || !MODELS.includes(v)) return null
        break
    }
    out[key] = v
  }
  return out
}

/** How the web version treats a command: `read` and `command` go to the relay; `desktop_only`
 *  does not even get there (no network round trip for something that cannot be done). */
export function webRouteOf(cmd: string): 'read' | 'command' | 'desktop_only' {
  if ((READ_COMMANDS as readonly string[]).includes(cmd)) return 'read'
  if ((COMMAND_COMMANDS as readonly string[]).includes(cmd)) return 'command'
  return 'desktop_only'
}

/** Events forwarded to the relay: the 18 in the `{ sessionId, payload }` envelope plus the 4 scheduler ones.
 *  `session:debug` (it repeats every stdout line) and the E2E, Live and
 *  Pipeline events stay out: they belong to no session and are desktop-only features. */
export const FORWARDED_EVENTS = [
  'atoms:batch', 'session:complete', 'session:error', 'session:usage', 'session:cache',
  'session:git_branch', 'pragma:analysis', 'pragma:questions', 'pragma:plan', 'pragma:phase',
  'pragma:step_complete', 'pragma:report', 'pragma:tests', 'pragma:closing', 'pragma:raw_note',
  'pragma:verify', 'pragma:review', 'pragma:turn_end',
  'scheduler:fired', 'scheduler:queued', 'scheduler:missed', 'scheduler:failed',
] as const

/** Synthetic bridge event: «you lost something, realign». */
export const RESYNC_EVENT = 'pragma:resync'

/** Synthetic bridge event: a session's live state changed on the PC — in the
 *  `{ sessionId, payload }` envelope, with `payload` equal to the `pragma.snapshot` reply. It covers
 *  what changes on the desktop without a backend event: Approve/Continue/Stop pressed on the PC,
 *  the auto-confirm timer, a new session. */
export const STATE_EVENT = 'pragma:state'

export function isReadCommand(cmd: unknown): cmd is ReadCommand {
  return typeof cmd === 'string' && (READ_COMMANDS as readonly string[]).includes(cmd)
}

const MAX_ARG_CHARS = 512

// For each command, the only arguments that pass — all strings. The web never chooses
// anything else: every unlisted key is thrown away, not forwarded to the backend.
const ARG_KEYS: Record<ReadCommand, readonly string[]> = {
  list_projects: [],
  get_project: ['id'],
  list_sessions: ['projectId'],
  search_sessions: ['projectId', 'query'],
  load_session: ['sessionId'],
  list_scheduled_sessions: ['projectId'],
  list_todos: ['projectId'],
  get_settings: [],
  'pragma.snapshot': ['sessionId'],
}

/** Cleaned arguments for `invoke`, or `null` if missing or of the wrong type. */
export function cleanArgs(cmd: ReadCommand, args: unknown): Record<string, string> | null {
  const src = args !== null && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {}
  const out: Record<string, string> = {}
  for (const key of ARG_KEYS[cmd]) {
    const v = src[key]
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_ARG_CHARS) return null
    out[key] = v
  }
  return out
}

/** Settings as the web sees them: interface preferences only. A whitelist, not a blacklist:
 *  a field added tomorrow (a secret, a path) does not leave until someone decides it.
 *  Out by construction: binary and config-folder paths, the DB, the export folder,
 *  the last working dir and the whole `remote` block with the access key. */
export function redactSettings(raw: unknown): Record<string, unknown> {
  const s = (raw ?? {}) as Record<string, unknown>
  const profiles = Array.isArray(s.profiles) ? s.profiles : []
  return {
    profiles: profiles.map((p) => {
      const prof = (p ?? {}) as Record<string, unknown>
      return { label: prof.label ?? '', binary: '', configDir: null, language: prof.language ?? null }
    }),
    dbPath: null,
    notificationsEnabled: s.notificationsEnabled ?? false,
    soundEnabled: s.soundEnabled ?? true,
    defaultProfileIndex: s.defaultProfileIndex ?? 0,
    exportDir: null,
    diffAlwaysOpen: s.diffAlwaysOpen ?? false,
    lastWorkingDir: null,
    models: s.models ?? null,
    sessionBranchEnabled: s.sessionBranchEnabled ?? false,
    e2eEnabled: s.e2eEnabled ?? true,
  }
}
