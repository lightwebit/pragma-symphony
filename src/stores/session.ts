import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { listen, invoke, isPermissionGranted, requestPermission, sendNotification, IS_WEB } from '../platform'
import { useProjectStore } from './projects'
import { useSettingsStore } from './settings'
import type { ScheduledSession } from './scheduled'
import { AUTO_CONFIRM_DELAY_MS } from '../PRAGMA_CONSTANTS'
import { STATE_EVENT } from '../remote/policy'
import { type QuestionItem, groupQuestions, formatQuestions, answersMessage } from '../questions'

export interface Atom {
  id: string
  atomType: 'FileTouch' | 'Diff' | 'ToolUse' | 'Error' | 'AgentNote' | 'UserReply' | 'PragmaEvent'
  filePath: string | null
  fileType: 'Code' | 'Config' | 'Markup' | 'Style' | 'Build' | 'Data' | 'Other' | null
  action: 'Create' | 'Modify' | 'Delete' | null
  content: string
  collapsed: boolean
  /** `Remote`: the action arrived from the web and was executed by the desktop. */
  source: 'Stdout' | 'Stderr' | 'Remote'
  receivedAt: string
  sessionId: string
}

export interface SessionInfo {
  id: string
  projectId: string
  startedAt: string
  command: string | null
  title: string | null
  workingDir: string | null
  atomCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalCostUsd: number | null
  attachments: string[]
  gitBranch: string | null
  gitBase: string | null
  /** Alias of the first turn ('sonnet'/'opus'/'fable'). null = session created before
   *  this field existed — not an unknown value in the generic sense. */
  model: SessionModel | null
  /** Snapshot of the last API call. null on earlier sessions. */
  lastContextTokens: number | null
  cacheTtlSecs: number | null
  lastCallAt: string | null
}

// ---------------------------------------------------------------------------
// Pragma structured events
// QUESTIONS arrive grouped into questions with options (protocol.rs `group_questions`);
// TESTS stay one line per item and are shown as text, not as a checklist.
// ---------------------------------------------------------------------------
export interface PragmaAnalysis    { text: string }
export interface PragmaQuestions   { items: QuestionItem[] }
export interface PragmaPlan        { steps: string[] }
export interface PragmaStepComplete { step: number; result: string }
export interface PragmaReport      { text: string }
export interface PragmaTests       { items: string[] }
export interface PragmaClosing     { text: string }
export interface PragmaRawNote     { text: string }
export type PragmaPhase = 'awaiting_answers' | 'awaiting_approval' | 'awaiting_confirmation' | 'awaiting_close' | 'awaiting_review_decision'

// Emitted directly by verify.rs after a REPORT, when the project has a testCommand
// configured — not part of the marker protocol (no model writes this text).
export interface PragmaVerify {
  passed: boolean
  newFailures: string[]
  healed: string[]
  preexisting: string[]
  lintOutput: string | null
  undetermined: boolean
  rawTestOutput: string
}

// Emitted by review.rs after VERIFY — a separate Claude session (Opus) reviews the
// session diff with fresh eyes (). Like verify, it is not part of the marker
// protocol: no model writes this text into the dev session.
export interface ReviewFinding {
  severity: string
  file: string | null
  line: number | null
  summary: string
  detail: string | null
}

export interface PragmaReview {
  verdict: 'pass' | 'findings' | 'skipped' | 'error'
  findings: ReviewFinding[]
  note: string | null
  diffTruncated: boolean
  round: number
  usedInvariants: boolean
  filesChanged: number
  linesChanged: number
  /** Diff over the threshold — a candidate for a manual `/code-review ultra`. */
  deepReviewSuggested: boolean
  /** The diff touches sensitive surfaces: the review also included the
   *  security hand-off. It is not a second verdict, it is one more dimension. */
  securityPass: boolean
  /** The files that triggered the security hand-off. */
  sensitiveFiles: string[]
  /** true if they were recognised with the default patterns instead of the project's
   *  `sensitivePaths` — the UI uses it to suggest declaring them. */
  sensitiveFromDefaults: boolean
}

// Emitted by e2e.rs after an on-demand E2E run. Deliberately outside the
// session cycle: the E2E is never a gate (), so this never blocks VERIFY,
// REVIEW or anything else — it is informational, shown in TestsCard as its own level.
export interface PragmaE2e {
  passed: boolean
  failedScenarios: string[]
  undetermined: boolean
  timedOut: boolean
  command: string
  durationMs: number
  rawOutput: string
  runFile: string | null
}

// Outcome of the Live button — unlike PragmaE2e there is no pass/fail judged
// by a model: only the exit code, as for any shell command.
export interface PragmaLive {
  command: string
  output: string
  exitCode: number | null
  timedOut: boolean
  cancelled: boolean
  durationMs: number
}

export interface LiveOutputLine {
  line: string
  stderr: boolean
}

// — Local pipeline —
export interface PipelineStep {
  id: string
  label: string
  command: string
  /// 'command' = outcome from the exit code; 'verify' = delegates to the project's
  /// VERIFY phase (test_command + baseline of pre-existing failures).
  kind: string
  enabled: boolean
}

export interface PipelineStepOutcome {
  id: string
  label: string
  kind: string
  command: string
  passed: boolean
  skipped: boolean
  exitCode: number | null
  timedOut: boolean
  cancelled: boolean
  durationMs: number
  output: string
  newFailures?: string[]
}

export interface PipelineOutcome {
  passed: boolean
  steps: PipelineStepOutcome[]
  durationMs: number
  stoppedEarly: boolean
}

// Aliases sent to Rust, which maps each of them to an explicit `--model` id.
export type SessionModel = 'sonnet' | 'opus' | 'fable'

export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  model: string
  totalCostUsd: number | null
}

/** How the last turn ended (`pragma:turn_end`). `terminal`: the model emitted
 *  a phase marker, so the UI knows what to offer. `truncated`: the process died or
 *  closed with an error, and the last section may be half-written. */
export interface TurnEnd {
  terminal: boolean
  truncated: boolean
}

/** What the last API call left in the cache: it tells, before a resume,
 *  whether the cache has expired and how much context would have to be rewritten. */
export interface SessionCache {
  contextTokens: number
  /** 300 or 3600; null if no recorded call wrote to the cache. */
  ttlSecs: number | null
  lastCallAt: string
}

// ---------------------------------------------------------------------------
// Parallel sessions
//
// The state is no longer "the session" but a map of sessions: each has its own
// atoms, its own pragma phase, its own running flag. Tauri events are global, so
// they arrive in a `{ sessionId, payload }` envelope (see src-tauri/src/events.rs) and
// a single set of listeners routes them to the right record — installed once,
// no longer created and destroyed with every session.
//
// The consumers (App.vue, the cards, the composables) keep reading `store.atoms`,
// `store.running`, `store.pragmaPlan`…: they are computeds pointing at the active
// session, so the refactor does not spread to the whole UI.
// ---------------------------------------------------------------------------

/** Key of the session not yet started: the title, working dir and attachments the
 *  user is preparing live here until there is a real id from the backend. */
export const DRAFT_KEY = '__draft__'

export interface PragmaState {
  analysis: PragmaAnalysis | null
  questions: PragmaQuestions | null
  plan: PragmaPlan | null
  phase: PragmaPhase | null
  report: PragmaReport | null
  tests: PragmaTests | null
  closing: PragmaClosing | null
  rawNote: PragmaRawNote | null
  verify: PragmaVerify | null
  review: PragmaReview | null
}

export interface SessionState {
  /** null until the session has been started (draft record). */
  id: string | null
  projectId: string
  atoms: Atom[]
  running: boolean
  stoppedByUser: boolean
  newCount: number
  scrollLocked: boolean
  lastError: string | null
  title: string
  workingDir: string
  attachments: string[]
  gitBranch: string | null
  model: SessionModel
  usage: SessionUsage | null
  cache: SessionCache | null
  /** In memory only: it is not rebuilt when a session is reopened from the DB. */
  turnEnd: TurnEnd | null
  stepTokenStart: SessionUsage | null
  completedSteps: PragmaStepComplete[]
  reviewAccepted: boolean
  /** True after a click on "Fix": hides the button until a new review
   *  arrives. Needed because the fix turn may end without a REPORT phase
   *  (the model answers with a note instead of following the protocol) — in that
   *  case `review_fix` does not re-launch the review and the card would stay attached
   *  forever to the old findings with Fix still clickable. */
  reviewFixSent: boolean
  pragma: PragmaState
  /** Profile the session started with. Used to send it a control even
   *  when it is not the focused one: a background session cannot depend on the
   *  profile currently selected in the UI. */
  binary: string
  configDir: string | null
  /** Continues by itself after AWAITING_CONFIRMATION. It is a property of the session,
   *  not of the screen: the timer must fire even while looking at something else, and
   *  must *not* fire just because we switched to look at this one. */
  autoConfirm: boolean
  /** When the automatic Continue fires (epoch ms), or null if no timer is running. On the
   *  desktop the timer writes it; on the web it comes from the PC (snapshot and `pragma:state`) and only serves to
   *  say «continues by itself» instead of «waits for you». */
  autoConfirmAt: number | null
  /** The turn in progress emitted QUESTIONS. If it still ends with a PLAN awaiting
   *  confirmation, auto-confirm must not fire: the question would pass in silence
   *  and the model would apply its default. It is cleared only at the end of the
   *  process: an AWAITING_ANSWERS emitted mid-turn must not reopen the door. */
  questionsThisTurn: boolean
}

/** What `pragma.snapshot` answers: the live state of a session on the PC. */
interface HostSnapshot {
  running: boolean
  phase: PragmaPhase | null
  turnEnd: TurnEnd | null
  autoConfirm: boolean
  /** Absent from a PC running an earlier version: it is null. */
  autoConfirmAt?: number | null
  lastError: string | null
  usage: SessionUsage | null
  cache: SessionCache | null
}

export interface StartSessionOptions {
  prompt: string
  binary: string
  projectId: string
  configDir?: string | null
  workingDir?: string | null
  profileLabel?: string | null
  title?: string | null
  model?: SessionModel
  /** Present = that session is continued instead of opening a new one. */
  resumeId?: string | null
  attachments?: string[]
  stepByStep?: boolean
  autoConfirm?: boolean
  /** Command from the web: the session does not take focus on the desktop (whoever is at the PC must
   *  not see the screen change) and the prompt atom is marked `Remote`. */
  remote?: boolean
  /** Id to give the new session: the one the web has already created on its side. */
  sessionId?: string | null
}

/** Envelope of every session-bound event — see src-tauri/src/events.rs. */
interface SessionEvent<T> { sessionId: string; payload: T }

export function emptyPragma(): PragmaState {
  return {
    analysis: null, questions: null, plan: null, phase: null, report: null,
    tests: null, closing: null, rawNote: null, verify: null, review: null,
  }
}

export function createSessionState(init: Partial<SessionState> = {}): SessionState {
  return {
    id: null,
    projectId: '',
    atoms: [],
    running: false,
    stoppedByUser: false,
    newCount: 0,
    scrollLocked: true,
    lastError: null,
    title: '',
    workingDir: '',
    attachments: [],
    gitBranch: null,
    model: 'sonnet',
    usage: null,
    cache: null,
    turnEnd: null,
    stepTokenStart: null,
    completedSteps: [],
    reviewAccepted: false,
    reviewFixSent: false,
    pragma: emptyPragma(),
    binary: '',
    configDir: null,
    autoConfirm: false,
    autoConfirmAt: null,
    questionsThisTurn: false,
    ...init,
  }
}

/** A session is "active" if the process is running or if the protocol is
 *  paused waiting for the user: in both cases it will write to its working
 *  dir again, so no other session can take it (one session per directory). A session
 *  merely *opened* to re-read it blocks nothing.
 *
 *  `awaiting_close` is the exception: it is the terminal phase (the model emitted
 *  AWAITING_CLOSE after CLOSING, PragmaPanel already labels it "done") — no
 *  later turn will bring it back to writing in the working dir, so it must not
 *  block a new session on the same dir. Without this exception a
 *  session with a plan — that is, almost every real session — stays "active"
 *  forever in the guard's eyes, because nothing resets `pragma.phase` to `null`
 *  after the protocol closes (found by testing live: the second session on
 *  the scratch target was refused even after REVIEW had passed). */
export function isSessionActive(s: SessionState): boolean {
  return s.running || (s.pragma.phase !== null && s.pragma.phase !== 'awaiting_close')
}

/** Comparison between working dirs — twin of `dir_key` in session_locks.rs, with what
 *  can be done without a filesystem: uniform separators, no trailing slash, and
 *  case-insensitive when the path looks like a Windows one. */
export function dirKey(dir: string): string {
  const normalized = dir.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  return /^[a-zA-Z]:/.test(normalized) ? normalized.toLowerCase() : normalized
}

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<Record<string, SessionState>>({ [DRAFT_KEY]: createSessionState() })
  const activeKey = ref<string>(DRAFT_KEY)

  const current = computed<SessionState>(
    () => sessions.value[activeKey.value] ?? sessions.value[DRAFT_KEY],
  )

  /** Writable proxy onto a field of the active session. */
  function field<K extends keyof SessionState>(key: K) {
    return computed<SessionState[K]>({
      get: () => current.value[key],
      set: (v) => { current.value[key] = v },
    })
  }

  function pragmaField<K extends keyof PragmaState>(key: K) {
    return computed<PragmaState[K]>({
      get: () => current.value.pragma[key],
      set: (v) => { current.value.pragma[key] = v },
    })
  }

  const atoms                = field('atoms')
  const running              = field('running')
  const newCount             = field('newCount')
  const scrollLocked         = field('scrollLocked')
  const lastError            = field('lastError')
  const sessionTitle         = field('title')
  const sessionWorkingDir    = field('workingDir')
  const sessionAttachments   = field('attachments')
  const sessionGitBranch     = field('gitBranch')
  const sessionModel         = field('model')
  const sessionUsage         = field('usage')
  const sessionCache         = field('cache')
  const turnEnd              = field('turnEnd')
  const autoConfirmAt        = field('autoConfirmAt')
  const stepTokenStart       = field('stepTokenStart')
  const completedSteps       = field('completedSteps')
  const reviewAccepted       = field('reviewAccepted')
  const reviewFixSent        = field('reviewFixSent')

  const pragmaAnalysis  = pragmaField('analysis')
  const pragmaQuestions = pragmaField('questions')
  const pragmaPlan      = pragmaField('plan')
  const pragmaPhase     = pragmaField('phase')
  const pragmaReport    = pragmaField('report')
  const pragmaTests     = pragmaField('tests')
  const pragmaClosing   = pragmaField('closing')
  const pragmaRawNote   = pragmaField('rawNote')
  const pragmaVerify    = pragmaField('verify')
  const pragmaReview    = pragmaField('review')

  const sessionId = computed(() => current.value.id)

  /** Live sessions (running or paused on the protocol), draft excluded. */
  const liveSessions = computed<SessionState[]>(
    () => Object.values(sessions.value).filter(s => s.id !== null && isSessionActive(s)),
  )

  const runningSessions = computed<SessionState[]>(
    () => Object.values(sessions.value).filter(s => s.id !== null && s.running),
  )

  function isRunning(id: string): boolean {
    return sessions.value[id]?.running ?? false
  }

  function isActive(id: string): boolean {
    const s = sessions.value[id]
    return s ? isSessionActive(s) : false
  }

  // Saved sessions list
  const savedSessions = ref<SessionInfo[]>([])

  // Current project — updated by App.vue when the user changes project.
  const activeProjectId = ref<string>('')

  // The E2E outcome does not belong to a session: the button is per project and can be
  // pressed with no session open. That is why it stays outside the map.
  const pragmaE2e  = ref<PragmaE2e | null>(null)
  const e2eRunning = ref(false)

  // Same principle for the Live button, plus the output lines that arrive
  // while it runs — it is the reason the button exists: watching the command
  // scroll by, not just the final outcome at the end of the run.
  const pragmaLive       = ref<PragmaLive | null>(null)
  const liveRunning      = ref(false)
  const liveOutputLines  = ref<LiveOutputLine[]>([])

  // Pipeline: same principle (per project, not per session). The output is a
  // step-index → lines map, because each step has its own box.
  const pipelineOutcome  = ref<PipelineOutcome | null>(null)
  const pipelineRunning  = ref(false)
  const pipelineOutput   = ref<Record<number, LiveOutputLine[]>>({})
  /// Index of the step currently running, to highlight it while it runs.
  const pipelineStepIdx  = ref<number | null>(null)

  // -------------------------------------------------------------------------
  // Event router
  // -------------------------------------------------------------------------

  function target(sessionId: string): SessionState | null {
    return sessions.value[sessionId] ?? null
  }

  function pushAtomTo(s: SessionState, content: string, atomType: Atom['atomType'] = 'UserReply', remote = false) {
    // On the web the phase atoms are rebuilt from events, but the saved copy is the PC's:
    // nothing is written here, and after a realignment the same event may arrive
    // inside the re-read list too — it is recognised by content, the ids are local.
    if (IS_WEB && atomType === 'PragmaEvent' && s.atoms.some(a => a.atomType === 'PragmaEvent' && a.content === content)) return
    const atom: Atom = {
      id: crypto.randomUUID(),
      atomType,
      filePath: null,
      fileType: null,
      action: null,
      content,
      collapsed: false,
      source: remote ? 'Remote' : 'Stdout',
      receivedAt: new Date().toISOString(),
      sessionId: s.id ?? '',
    }
    s.atoms.push(atom)
    if (s.id && !IS_WEB) {
      invoke('save_local_atom', { atom }).catch(() => {})
    }
  }

  // Auto-confirm timers, one per session. Outside the reactive state: they are
  // handles, not data to display.
  const autoConfirmTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // The AWAITING_CONFIRMATION marker arrives while the turn's process is still
  // writing, so the marker *arms* auto-confirm and the timer starts only once the turn has closed
  // (`session:complete`). It used to start from the marker: if the turn had not exited within the delay, its
  // `session:complete` arrived after the Continue and set `running` back to false while the
  // new turn was running, with two `claude` processes straddling the same session. The manual buttons
  // do not suffer from it: they are disabled while `running` is true.
  const autoConfirmArmed = new Set<string>()

  function cancelAutoConfirm(id: string) {
    autoConfirmArmed.delete(id)
    const t = autoConfirmTimers.get(id)
    if (t) { clearTimeout(t); autoConfirmTimers.delete(id) }
    const s = sessions.value[id]
    if (s) s.autoConfirmAt = null
  }

  function scheduleAutoConfirm(s: SessionState) {
    // The auto-confirm timer belongs to the PC. On the web it would start a second CONTINUE on the
    // same phase, next to the one the PC sends by itself.
    if (IS_WEB || !s.id) return
    cancelAutoConfirm(s.id)
    const id = s.id
    s.autoConfirmAt = Date.now() + AUTO_CONFIRM_DELAY_MS
    autoConfirmTimers.set(id, setTimeout(() => {
      autoConfirmTimers.delete(id)
      const target = sessions.value[id]
      if (target) target.autoConfirmAt = null
      // Re-checks at firing time: in the meantime the user may have
      // approved, stopped or aborted by hand.
      if (!target || !target.autoConfirm || target.pragma.phase !== 'awaiting_confirmation') return
      void sendControlTo(target, 'CONTINUE')
    }, AUTO_CONFIRM_DELAY_MS))
  }

  let globalListenersReady = false

  /** Installs the listeners once, for the whole life of the app: with several
   *  sessions running they can no longer be tied to the lifecycle of one. */
  async function initGlobalListeners() {
    if (globalListenersReady) return
    globalListenersReady = true

    /** Delivers the payload to the envelope's session; ignores events of
     *  sessions no longer in memory (closed or deleted while they arrived). */
    function route<T>(event: string, handler: (s: SessionState, payload: T) => void) {
      return listen<SessionEvent<T>>(event, (e) => {
        const s = target(e.payload?.sessionId)
        if (!s) return
        handler(s, e.payload.payload)
      })
    }

    await route<Atom[]>('atoms:batch', (s, incoming) => {
      // On the web, after a realignment, the same atom may arrive both in the re-read list and
      // in the held-back events: the ids are stable, so the one already present is discarded.
      let fresh = incoming
      if (IS_WEB && s.atoms.length > 0) {
        const known = new Set(s.atoms.map(a => a.id))
        fresh = incoming.filter(a => !known.has(a.id))
      }
      if (fresh.length === 0) return
      s.atoms.push(...fresh)
      if (!s.scrollLocked) s.newCount += fresh.length
    })

    await route<null>('session:complete', (s) => {
      const armed = !!s.id && autoConfirmArmed.delete(s.id)
      const askedQuestions = s.questionsThisTurn
      s.running = false
      s.questionsThisTurn = false
      // A truncated turn may have left the PLAN half-written: no automatic Continue, as for
      // VERIFY/REVIEW after a truncated REPORT. The user sees the warning and decides.
      if (armed && !askedQuestions && !s.turnEnd?.truncated && s.autoConfirm
          && s.pragma.phase === 'awaiting_confirmation') {
        scheduleAutoConfirm(s)
      }
      fetchSavedSessions()
    })

    await route<{ code: string; message: string }>('session:error', (s, err) => {
      if (s.stoppedByUser) {
        s.stoppedByUser = false
      } else {
        s.lastError = err.message
      }
      s.running = false
      s.questionsThisTurn = false
      fetchSavedSessions()
    })

    await route<PragmaAnalysis>('pragma:analysis', (s, p) => {
      s.pragma.analysis = p
      pushAtomTo(s, `ANALYSIS\n${p.text}`, 'PragmaEvent')
    })
    await route<PragmaQuestions>('pragma:questions', (s, p) => {
      s.pragma.questions = p
      s.questionsThisTurn = true
      pushAtomTo(s, `QUESTIONS\n${formatQuestions(p.items)}`, 'PragmaEvent')
    })
    await route<PragmaPlan>('pragma:plan', (s, p) => {
      s.pragma.plan = p
      pushAtomTo(s, `PLAN\n${p.steps.join('\n')}`, 'PragmaEvent')
    })
    await route<PragmaPhase>('pragma:phase', (s, p) => {
      s.pragma.phase = p
      if (p === 'awaiting_confirmation' && s.autoConfirm && !s.questionsThisTurn && s.id) {
        autoConfirmArmed.add(s.id)
      }
    })
    await route<PragmaReport>('pragma:report', (s, p) => {
      s.pragma.report = p
      pushAtomTo(s, `REPORT\n${p.text}`, 'PragmaEvent')
    })
    await route<PragmaTests>('pragma:tests', (s, p) => {
      s.pragma.tests = p
      pushAtomTo(s, `TESTS\n${p.items.join('\n')}`, 'PragmaEvent')
    })
    await route<PragmaStepComplete>('pragma:step_complete', (s, p) => {
      s.completedSteps.push(p)
      pushAtomTo(s, `STEP ${p.step}\n${p.result}`, 'PragmaEvent')
      s.stepTokenStart = s.usage ? { ...s.usage } : null
    })
    await route<PragmaClosing>('pragma:closing', (s, p) => {
      s.pragma.closing = p
      pushAtomTo(s, `CLOSING\n${p.text}`, 'PragmaEvent')
    })
    await route<PragmaRawNote>('pragma:raw_note', (s, p) => {
      s.pragma.rawNote = p
      pushAtomTo(s, `RAW_NOTE\n${p.text}`, 'PragmaEvent')
    })
    await route<PragmaVerify>('pragma:verify', (s, p) => {
      s.pragma.verify = p
      pushAtomTo(s, `VERIFY\n${JSON.stringify(p)}`, 'PragmaEvent')
    })
    await route<PragmaReview>('pragma:review', (s, p) => {
      s.pragma.review = p
      s.reviewAccepted = false
      s.reviewFixSent = false
      pushAtomTo(s, `REVIEW\n${JSON.stringify(p)}`, 'PragmaEvent')
    })
    // Web: the live state the PC changes by itself, without a backend event (Approve or Stop
    // pressed there, the auto-confirm timer). A session not in memory here may have
    // just been born on the PC: if the list does not know it, it is re-read.
    if (IS_WEB) {
      await listen<SessionEvent<HostSnapshot>>(STATE_EVENT, (e) => {
        const id = e.payload?.sessionId
        if (!id || !e.payload.payload) return
        const t = sessions.value[id]
        if (t) applySnapshot(t, e.payload.payload)
        else if (!savedSessions.value.some(x => x.id === id)) void fetchSavedSessions()
      })
    }

    await route<SessionUsage>('session:usage', (s, p) => {
      s.usage = p
    })
    await route<TurnEnd>('pragma:turn_end', (s, p) => {
      s.turnEnd = p
    })
    await route<SessionCache>('session:cache', (s, p) => {
      // A pure hit does not say the lifetime: it stays that of the call that wrote.
      s.cache = { ...p, ttlSecs: p.ttlSecs ?? s.cache?.ttlSecs ?? null }
    })
    await route<{ branch: string }>('session:git_branch', (s, p) => {
      s.gitBranch = p.branch
      const saved = savedSessions.value.find(x => x.id === s.id)
      if (saved) saved.gitBranch = p.branch
    })

    await listen<string>('session:debug', (event) => {
      console.log('[pragma debug]', event.payload)
    })

    // Scheduled sessions: outside the router because the session does not exist yet
    // in `sessions` when the event arrives — this very event is what creates it.
    await listen<{ scheduled: ScheduledSession; sessionId: string; binary: string; configDir: string | null }>(
      'scheduler:fired',
      (e) => {
        const { scheduled, sessionId, binary, configDir } = e.payload
        adoptScheduledSession({
          sessionId,
          projectId: scheduled.projectId,
          prompt: scheduled.prompt,
          title: scheduled.title,
          workingDir: scheduled.workingDir,
          model: (scheduled.model as SessionModel) || 'sonnet',
          autoConfirm: scheduled.autoConfirm,
          binary,
          configDir,
        })
      },
    )

    // Outside the router: E2E is per project, not per session.
    await listen<PragmaE2e>('pragma:e2e', (e) => {
      pragmaE2e.value = e.payload
    })

    // Streaming of the Live button, line by line — see runner::LineSink on the Rust side.
    await listen<{ runId: string; line: string; stderr: boolean }>('pragma:live-output', (e) => {
      liveOutputLines.value.push({ line: e.payload.line, stderr: e.payload.stderr })
    })

    // Pipeline streaming: every line carries the index of the step that
    // produced it, without which we would not know which box to write it in.
    await listen<{ runId: string; stepIndex: number; line: string; stderr: boolean }>(
      'pragma:pipeline-output',
      (e) => {
        const idx = e.payload.stepIndex
        if (!pipelineOutput.value[idx]) pipelineOutput.value[idx] = []
        pipelineOutput.value[idx].push({ line: e.payload.line, stderr: e.payload.stderr })
        pipelineStepIdx.value = idx
      },
    )
  }

  // -------------------------------------------------------------------------
  // E2E
  // -------------------------------------------------------------------------

  /// Launches the project's E2E run. It does not touch the session state: E2E is
  /// not a gate and must not be able to make a session look "busy".
  async function runE2e(
    projectId: string,
    workingDir: string,
    binary: string,
    configDir?: string,
    timeoutSecs?: number,
  ): Promise<PragmaE2e> {
    e2eRunning.value = true
    try {
      const outcome = await invoke<PragmaE2e>('run_e2e_suite', {
        projectId,
        workingDir,
        binary,
        configDir: configDir ?? null,
        timeoutSecs: timeoutSecs ?? null,
      })
      pragmaE2e.value = outcome
      return outcome
    } finally {
      e2eRunning.value = false
    }
  }

  async function stopE2e() {
    await invoke('stop_e2e_run')
  }

  // -------------------------------------------------------------------------
  // Live (on-demand build/start button)
  // -------------------------------------------------------------------------

  /// Launches the project's live command. `unbounded` chooses one-shot vs
  /// long-running: it is not deduced from the stack, the user declares it in the UI.
  async function runLive(
    projectId: string,
    workingDir: string,
    unbounded: boolean,
    timeoutSecs?: number,
  ): Promise<PragmaLive> {
    liveRunning.value = true
    liveOutputLines.value = []
    try {
      const outcome = await invoke<PragmaLive>('run_live_command', {
        projectId,
        workingDir,
        unbounded,
        timeoutSecs: timeoutSecs ?? null,
      })
      pragmaLive.value = outcome
      return outcome
    } finally {
      liveRunning.value = false
    }
  }

  async function stopLive() {
    await invoke('stop_live_run')
  }

  // -------------------------------------------------------------------------
  // Local pipeline
  // -------------------------------------------------------------------------

  async function runPipeline(
    projectId: string,
    workingDir: string,
    binary: string,
    configDir?: string,
    stepTimeoutSecs?: number,
  ): Promise<PipelineOutcome> {
    pipelineRunning.value = true
    pipelineOutput.value = {}
    pipelineStepIdx.value = null
    pipelineOutcome.value = null
    try {
      const outcome = await invoke<PipelineOutcome>('run_project_pipeline', {
        projectId,
        workingDir,
        binary,
        configDir: configDir ?? null,
        stepTimeoutSecs: stepTimeoutSecs ?? null,
      })
      pipelineOutcome.value = outcome
      return outcome
    } finally {
      pipelineRunning.value = false
      pipelineStepIdx.value = null
    }
  }

  async function stopPipeline() {
    await invoke('stop_pipeline_run')
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  /** Keeps in memory only what is needed: the active session, the live ones and the
   *  draft. The others reload from the DB in one invoke when needed. */
  function pruneClosedSessions() {
    for (const [key, s] of Object.entries(sessions.value)) {
      if (key === DRAFT_KEY || key === activeKey.value) continue
      if (!isSessionActive(s)) delete sessions.value[key]
    }
  }

  function setActive(key: string) {
    activeKey.value = key
    pruneClosedSessions()
  }

  /**
   * One-session-per-directory guard — frontend twin of the one in session_locks.rs. Parallelism is
   * allowed only between different projects: two sessions on the same project (or the
   * same working dir) fight over the session branch and overwrite each other's
   * files. Here the message arrives before the process even starts — never a silent
   * start, never a "nothing happened".
   */
  function findConflictingSession(projectId: string, workingDir: string): SessionState | null {
    const key = workingDir ? dirKey(workingDir) : ''
    for (const s of Object.values(sessions.value)) {
      if (s.id === null || !isSessionActive(s)) continue
      if (s.projectId === projectId) return s
      if (key && s.workingDir && dirKey(s.workingDir) === key) return s
    }
    return null
  }

  function conflictMessage(other: SessionState): string {
    const label = other.title || other.id?.slice(0, 8) || 'unknown'
    return `Session "${label}" is still active on this project/directory. `
      + 'Parallel sessions are allowed only across different projects — '
      + 'two on the same working directory would fight over the session branch.'
  }

  async function startSession(opts: StartSessionOptions) {
    const {
      prompt, binary, projectId, configDir, workingDir, profileLabel,
      title, model, resumeId, attachments, stepByStep, autoConfirm, remote,
    } = opts

    let s: SessionState
    let newSessionId: string | null = null

    if (resumeId) {
      s = sessions.value[resumeId] ?? (sessions.value[resumeId] = createSessionState({
        id: resumeId, projectId, workingDir: workingDir ?? '',
      }))
      if (!remote) setActive(resumeId)
      if (s.atoms.length > 0) {
        pushAtomTo(s, '\x00separator')
      }
      // A new prompt on the same session is new work: the previous turn's cards
      // (CLOSING, REPORT, TESTS…) must not stay there saying "done" while this one runs.
      // The separator above does the same in restorePragmaFromAtoms.
      resetTurnState(s)
      if (model) s.model = model
    } else {
      const conflict = findConflictingSession(projectId, workingDir ?? '')
      if (conflict) throw new Error(conflictMessage(conflict))

      // The id is generated by the frontend and passed to the backend: the record must exist
      // before the invoke, otherwise the events emitted while `run_pragma` has
      // not yet returned would find no session to be delivered to.
      newSessionId = opts.sessionId || crypto.randomUUID()
      s = createSessionState({
        id: newSessionId,
        projectId,
        title: title || '',
        workingDir: workingDir ?? '',
        model: model ?? 'sonnet',
      })
      sessions.value[newSessionId] = s
      if (!remote) {
        setActive(newSessionId)
        resetDraft()
      }
    }

    s.newCount = 0
    s.scrollLocked = true
    s.running = true
    s.turnEnd = null
    s.lastError = null
    s.pragma.phase = null
    s.binary = binary
    s.configDir = configDir ?? null
    s.autoConfirm = autoConfirm ?? false
    if (s.id) cancelAutoConfirm(s.id)

    // Prompt as the first visible atom, before the invoke.
    const promptAtom: Atom = {
      id: crypto.randomUUID(),
      atomType: 'UserReply',
      filePath: null,
      fileType: null,
      action: null,
      content: prompt,
      collapsed: false,
      source: remote ? 'Remote' : 'Stdout',
      receivedAt: new Date().toISOString(),
      sessionId: s.id ?? '',
    }
    s.atoms.push(promptAtom)

    try {
      const id = await invoke<string>('run_pragma', {
        prompt,
        binary,
        projectId,
        configDir: configDir ?? null,
        workingDir: workingDir ?? null,
        profileLabel: profileLabel ?? null,
        title: title ?? null,
        model: model ?? null,
        attachments: attachments ?? [],
        existingSessionId: resumeId ?? null,
        newSessionId,
        stepByStep: stepByStep ?? false,
        // On the web auto-confirm belongs to the PC: it travels with the command because the desktop
        // store sets it. The backend does not read it.
        ...(IS_WEB ? { autoConfirm: autoConfirm ?? false } : {}),
      })
      promptAtom.sessionId = id
      // On the web the saved copy is written by the PC.
      if (!IS_WEB) invoke('save_local_atom', { atom: promptAtom }).catch(() => {})
      if (!resumeId) {
        // New session: inject at the top of the list immediately
        savedSessions.value = [
          {
            id,
            projectId,
            title: null,
            startedAt: new Date().toISOString(),
            command: prompt,
            workingDir: workingDir ?? null,
            atomCount: 0,
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
            totalCostUsd: null,
            attachments: attachments ?? [],
            gitBranch: null,
            gitBase: null,
            lastContextTokens: null, cacheTtlSecs: null, lastCallAt: null,
            model: model ?? 'sonnet',
          },
          ...savedSessions.value.filter(x => x.id !== id),
        ]
      }
    } catch (e) {
      // Start refused (working dir guard, invalid binary…): the session
      // exists nowhere, so the record disappears and we go back to the draft
      // with the attachments intact — the user's prompt is not lost.
      s.running = false
      if (newSessionId) {
        delete sessions.value[newSessionId]
        if (!remote) {
          setActive(DRAFT_KEY)
          sessions.value[DRAFT_KEY].attachments = attachments ?? []
          sessions.value[DRAFT_KEY].title = title || ''
        }
      }
      throw e
    }
    return s.id
  }

  /**
   * Adopts a session started by the scheduler (`scheduler:fired`, see
   * src-tauri/src/scheduler.rs). Without this step the session would really run
   * but the UI would stay mute: `route()` above delivers events only to sessions
   * already present in `sessions`, and in the scheduled flow nobody ever went through
   * `startSession()` to create their state — it is born on the Rust side, not from an invoke here.
   *
   * It does not call `setActive`: a session that started by itself must not steal focus from
   * whoever is working. It stays visible as "running" in the session list and in the
   * "elsewhere" strip if it is on another project, exactly like a
   * manual session started on a project that is not the focused one.
   */
  function adoptScheduledSession(p: {
    sessionId: string
    projectId: string
    prompt: string
    title: string | null
    workingDir: string | null
    model: SessionModel
    autoConfirm: boolean
    binary: string
    configDir: string | null
  }) {
    const s = createSessionState({
      id: p.sessionId,
      projectId: p.projectId,
      title: p.title || '',
      workingDir: p.workingDir ?? '',
      model: p.model,
    })
    s.running = true
    s.turnEnd = null
    s.autoConfirm = p.autoConfirm
    s.binary = p.binary
    s.configDir = p.configDir
    sessions.value[p.sessionId] = s

    const promptAtom: Atom = {
      id: crypto.randomUUID(),
      atomType: 'UserReply',
      filePath: null,
      fileType: null,
      action: null,
      content: p.prompt,
      collapsed: false,
      source: 'Stdout',
      receivedAt: new Date().toISOString(),
      sessionId: p.sessionId,
    }
    s.atoms.push(promptAtom)
    invoke('save_local_atom', { atom: promptAtom }).catch(() => {})

    // Injected at the top of the list only if it is the project being looked at now
    // — otherwise it would show another project's session in the wrong list.
    if (p.projectId === activeProjectId.value) {
      savedSessions.value = [
        {
          id: p.sessionId,
          projectId: p.projectId,
          title: p.title,
          startedAt: new Date().toISOString(),
          command: p.prompt,
          workingDir: p.workingDir,
          atomCount: 0,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
          totalCostUsd: null,
          attachments: [],
          gitBranch: null,
          gitBase: null,
          lastContextTokens: null, cacheTtlSecs: null, lastCallAt: null,
          model: p.model,
        },
        ...savedSessions.value.filter(x => x.id !== p.sessionId),
      ]
    }

    void notifyScheduledStarted(p.title || p.prompt.slice(0, 60))
  }

  /** System notification when a scheduled session starts by itself — it is the only
   *  case where the start itself is worth a notification: whoever pressed a manual Run
   *  already knows. Same gate (permission, settings) as useSessionNotifications.ts. */
  async function notifyScheduledStarted(label: string) {
    const settings = useSettingsStore()
    if (!settings.settings.notificationsEnabled) return
    let granted = await isPermissionGranted()
    if (!granted) granted = (await requestPermission()) === 'granted'
    if (!granted) return
    sendNotification({ title: 'Pragma Symphony — Scheduled session started', body: label })
  }

  /** Clears what describes a single turn of work: the panel cards, the steps, the review. */
  function resetTurnState(s: SessionState) {
    s.pragma = emptyPragma()
    s.reviewAccepted = false
    s.reviewFixSent = false
    s.completedSteps = []
  }

  /** Restores structured pragma fields from PragmaEvent atoms of a loaded session. */
  function restorePragmaFromAtoms(s: SessionState, atomList: Atom[]) {
    resetTurnState(s)

    for (const atom of atomList) {
      // The separator marks a new prompt on the same session: only the last work counts.
      if (atom.atomType === 'UserReply' && atom.content === '\x00separator') {
        resetTurnState(s)
        continue
      }
      if (atom.atomType !== 'PragmaEvent') continue
      const body = atom.content
      if (body.startsWith('ANALYSIS\n')) {
        s.pragma.analysis = { text: body.slice('ANALYSIS\n'.length).trim() }
      } else if (body.startsWith('QUESTIONS\n')) {
        const items = groupQuestions(body.slice('QUESTIONS\n'.length).split('\n'))
        if (items.length) s.pragma.questions = { items }
      } else if (body.startsWith('PLAN\n')) {
        const steps = body.slice('PLAN\n'.length).split('\n')
          .map(l => l.replace(/^[-*]\s+/, '').trim())
          .filter(l => l && !/^-+$/.test(l))
        if (steps.length) s.pragma.plan = { steps }
      } else if (/^STEP \d+\n/.test(body)) {
        const m = body.match(/^STEP (\d+)\n(.*)$/s)
        if (m) s.completedSteps.push({ step: parseInt(m[1]), result: m[2].trim() })
      } else if (body.startsWith('REPORT\n')) {
        s.pragma.report = { text: body.slice('REPORT\n'.length).trim() }
      } else if (body.startsWith('TESTS\n')) {
        const items = body.slice('TESTS\n'.length).split('\n')
          .map(l => l.replace(/^-\s*/, '').trim()).filter(l => l && !/^-+$/.test(l))
        if (items.length) s.pragma.tests = { items }
      } else if (body.startsWith('CLOSING\n')) {
        s.pragma.closing = { text: body.slice('CLOSING\n'.length).trim() }
      } else if (body.startsWith('RAW_NOTE\n')) {
        s.pragma.rawNote = { text: body.slice('RAW_NOTE\n'.length).trim() }
      } else if (body.startsWith('VERIFY\n')) {
        try {
          s.pragma.verify = JSON.parse(body.slice('VERIFY\n'.length))
        } catch {
          // Ignora payload malformati da versioni precedenti.
        }
      } else if (body.startsWith('REVIEW\n')) {
        try {
          s.pragma.review = JSON.parse(body.slice('REVIEW\n'.length))
        } catch {
          // Ignora payload malformati da versioni precedenti.
        }
      }
    }
  }

  /**
   * Opens a session. If it is already in memory (because it is running in parallel) it is a
   * simple focus change: no kill, no reload — the session I leave keeps
   * working. Otherwise it is rebuilt from the saved atoms.
   */
  /** `focus: false`: loads it into memory without bringing it into focus — it serves the web command
   *  on a session the desktop has not opened since it started. */
  async function loadSession(id: string, { focus = true }: { focus?: boolean } = {}) {
    if (sessions.value[id]) {
      if (!focus) return
      setActive(id)
      followProjectOf(sessions.value[id])
      return
    }

    const si = savedSessions.value.find(x => x.id === id)
    const s = createSessionState({
      id,
      projectId: si?.projectId ?? activeProjectId.value,
      title: si?.title || '',
      workingDir: si?.workingDir || '',
      attachments: si?.attachments ?? [],
      gitBranch: si?.gitBranch ?? null,
      model: si?.model ?? 'sonnet',
      usage: si
        ? { inputTokens: si.inputTokens, outputTokens: si.outputTokens,
            cacheReadTokens: si.cacheReadTokens, cacheWriteTokens: si.cacheWriteTokens,
            model: '', totalCostUsd: si.totalCostUsd }
        : null,
      cache: si?.lastCallAt && si.lastContextTokens != null
        ? { contextTokens: si.lastContextTokens, ttlSecs: si.cacheTtlSecs, lastCallAt: si.lastCallAt }
        : null,
    })
    sessions.value[id] = s
    if (focus) setActive(id)

    try {
      const loaded = await invoke<Atom[]>('load_session', { sessionId: id })
      // Re-reading from sessions.value[id] is necessary: Vue wraps nested
      // objects in a reactive proxy on read only, not on write, so
      // mutating `s` (the raw pre-proxy reference) after the await would not
      // trigger any UI update even though the underlying data changes.
      const target = sessions.value[id]
      if (target) {
        target.atoms = loaded
        restorePragmaFromAtoms(target, loaded)
      }
      if (IS_WEB) await applyHostSnapshot(id)
    } catch (e) {
      const target = sessions.value[id] ?? s
      target.lastError = String(e)
    }
  }

  /** The live state that on the PC lives only in memory (`pragma.snapshot`): whether it is running,
   *  which phase it is in, how the last turn ended. Not needed on the desktop — the memory is its own. */
  async function applyHostSnapshot(id: string) {
    try {
      const snap = await invoke<HostSnapshot | null>('pragma.snapshot', { sessionId: id })
      const t = sessions.value[id]
      if (!snap || !t) return
      applySnapshot(t, snap)
    } catch {
      // The view stays as it is: the next realignment retries.
    }
  }

  /** The PC's live state on top of the local one. Same step for the answer to `pragma.snapshot`
   *  (opening, realignment) and for the `pragma:state` event (live change). */
  function applySnapshot(t: SessionState, snap: HostSnapshot) {
    t.running = !!snap.running
    t.pragma.phase = snap.phase ?? null
    t.turnEnd = snap.turnEnd ?? null
    t.autoConfirm = !!snap.autoConfirm
    t.autoConfirmAt = snap.autoConfirmAt ?? null
    t.lastError = snap.lastError ?? null
    if (snap.usage) t.usage = snap.usage
    if (snap.cache) t.cache = snap.cache
  }

  /** Web: re-reads the open session from the PC — atoms, cards, phase and state — after a reconnection or
   *  lost events. Events arriving in the meantime are held back by the platform. */
  async function refreshFromHost(id: string) {
    const t = sessions.value[id]
    if (!t) return
    const loaded = await invoke<Atom[]>('load_session', { sessionId: id })
    const target = sessions.value[id]
    if (!target) return
    target.atoms = loaded
    restorePragmaFromAtoms(target, loaded)
    await applyHostSnapshot(id)
  }

  /** Switching to a session of another project brings the project along: the
   *  left list and the working dir must tell the same session. */
  function followProjectOf(s: SessionState) {
    if (!s.projectId || s.projectId === activeProjectId.value) return
    const projects = useProjectStore()
    projects.setCurrentProject(s.projectId)
  }

  /** Loads the list of saved sessions for the given project (or the active one). */
  async function fetchSavedSessions(projectId?: string) {
    const pid = projectId ?? activeProjectId.value
    if (!pid) { savedSessions.value = []; return }
    if (projectId) activeProjectId.value = projectId
    try {
      const fromDb = await invoke<SessionInfo[]>('list_sessions', { projectId: pid })
      // This project's live sessions stay visible even if the DB does not
      // have them yet: without this, a freshly started session would vanish from the list.
      const missing = liveSessions.value
        .filter(s => s.projectId === pid && !fromDb.find(x => x.id === s.id))
        .map(s => savedSessions.value.find(x => x.id === s.id))
        .filter((x): x is SessionInfo => !!x)
      savedSessions.value = missing.length ? [...missing, ...fromDb] : fromDb
    } catch (e) {
      console.error('list_sessions:', e)
    }
  }

  /** Full-text search over sessions in a project. */
  async function searchSessions(query: string, projectId?: string): Promise<SessionInfo[]> {
    const pid = projectId ?? activeProjectId.value
    if (!pid) return []
    try {
      return await invoke<SessionInfo[]>('search_sessions', { projectId: pid, query })
    } catch (e) {
      console.error('search_sessions:', e)
      return []
    }
  }

  /** Duplicates the current session in the DB and opens it. */
  async function duplicateCurrentSession() {
    const s = current.value
    if (!s.id) return
    try {
      const newId = await invoke<string>('duplicate_session', { sessionId: s.id })
      await fetchSavedSessions()
      await loadSession(newId)
    } catch (e) {
      s.lastError = String(e)
    }
  }

  /** Writes the session JSON to <exportDir>/<project-slug>/ and returns the path. */
  async function exportCurrentSession(): Promise<string | null> {
    const s = current.value
    if (!s.id) return null
    try {
      return await invoke<string>('export_session_to_file', { sessionId: s.id })
    } catch (e) {
      s.lastError = String(e)
      return null
    }
  }

  /** Generates the session Markdown and writes it to <exportDir>/<project-slug>/. */
  async function exportCurrentSessionMarkdown(workingDir?: string): Promise<string | null> {
    const s = current.value
    if (!s.id) return null
    try {
      const dbAtoms = await invoke<Atom[]>('load_session', { sessionId: s.id })
      const md = buildMarkdown(dbAtoms, s.id, s.title, s.attachments, s.model, workingDir || s.workingDir)
      return await invoke<string>('export_session_to_markdown', { sessionId: s.id, content: md })
    } catch (e) {
      s.lastError = String(e)
      return null
    }
  }

  function buildMarkdown(
    atomList: Atom[],
    sid: string,
    title: string,
    attachments?: string[],
    model?: string,
    workingDir?: string,
  ): string {
    const lines: string[] = []
    const heading = title || 'Pragma Session'
    lines.push(`# ${heading}`)
    lines.push(`**Session:** \`${sid}\`  `)
    lines.push(`**Date:** ${new Date().toISOString().slice(0, 10)}`)
    if (model) lines.push(`**Model:** ${model}`)
    if (workingDir) lines.push(`**Working dir:** \`${workingDir}\``)
    if (attachments && attachments.length > 0)
      lines.push(`**Attachments:** ${attachments.map(a => `\`${a}\``).join(', ')}`)
    lines.push('')

    const pragma = atomList.filter(a => a.atomType === 'PragmaEvent')
    const userReplies = atomList.filter(a => a.atomType === 'UserReply')
    const agentNotes = atomList.filter(a => a.atomType === 'AgentNote')
    const errors = atomList.filter(a => a.atomType === 'Error')
    const toolCount = atomList.filter(a => ['FileTouch', 'Diff', 'ToolUse'].includes(a.atomType)).length

    if (userReplies.length > 0) {
      lines.push('---', '', '## Prompt', '')
      lines.push(userReplies[0].content.trim())
      for (const r of userReplies.slice(1)) {
        lines.push('', `**User reply:** ${r.content.trim()}`)
      }
      lines.push('')
    }

    for (const atom of pragma) {
      const body = atom.content
      if (body.startsWith('ANALYSIS\n')) {
        lines.push('---', '', '## Analysis', '', body.slice('ANALYSIS\n'.length).trim(), '')
      } else if (body.startsWith('QUESTIONS\n')) {
        lines.push('---', '', '## Questions', '', body.slice('QUESTIONS\n'.length).trim(), '')
      } else if (body.startsWith('PLAN\n')) {
        lines.push('---', '', '## Plan', '', body.slice('PLAN\n'.length).trim(), '')
      } else if (body.startsWith('REPORT\n')) {
        lines.push('---', '', '## Report', '', body.slice('REPORT\n'.length).trim(), '')
      } else if (/^STEP \d+\n/.test(body)) {
        const match = body.match(/^(STEP \d+)\n(.*)$/s)
        if (match) lines.push('', `### ${match[1]}`, '', match[2].trim(), '')
      } else if (body.startsWith('RAW_NOTE\n')) {
        lines.push('---', '', '## Response', '', body.slice('RAW_NOTE\n'.length).trim(), '')
      }
    }

    // If Claude responded without pragma markers and no raw_note, include the raw agent notes
    if (pragma.length === 0 && agentNotes.length > 0) {
      lines.push('---', '', '## Response', '')
      for (const note of agentNotes) {
        const text = note.content.trim()
        if (text) lines.push(text, '')
      }
    }

    if (errors.length > 0) {
      lines.push('---', '', '## Errors', '')
      for (const e of errors) lines.push(`> ⚠ ${e.content.trim()}`, '')
    }

    if (toolCount > 0) {
      lines.push('---', '', `*File operations: ${toolCount}*`, '')
    }

    return lines.join('\n')
  }

  type ControlMessage = 'APPROVED' | 'CONTINUE' | 'FINALIZE' | 'ABORT' | 'SKIP_QUESTIONS'

  /** Sends a control message to a waiting session (--resume). */
  async function sendControl(
    message: ControlMessage,
    binary: string,
    configDir?: string,
    workingDir?: string,
  ) {
    await sendControlTo(current.value, message, binary, configDir, workingDir)
  }

  /**
   * Explicit variant on the session: automatic controls (auto-confirm) and
   * those launched from the list must be able to reach a session that is not
   * the focused one, using *its* profile and not the one selected now.
   */
  async function sendControlTo(
    s: SessionState,
    message: ControlMessage,
    binary?: string,
    configDir?: string,
    workingDir?: string,
    remote = false,
  ) {
    if (!s.id) { console.warn('[sendControl] sessionId is null — ignoring', message); return }
    const bin = binary || s.binary
    // On the web the binary is always empty (settings hide it): the bridge uses its own.
    // We go on, so whoever presses Approve reads the relay's answer instead of a mute button.
    if (!bin && !IS_WEB) { console.warn('[sendControl] no binary for session', s.id); return }
    const labelMap: Record<string, string> = {
      APPROVED: '✓ Plan approved',
      CONTINUE: '→ Continue',
      FINALIZE: '→ Finalize',
      ABORT: '✗ Abort',
      SKIP_QUESTIONS: '→ Skip questions',
    }
    pushAtomTo(s, labelMap[message] ?? `→ ${message}`, 'UserReply', remote)
    cancelAutoConfirm(s.id)
    s.pragma.phase = null
    s.running = true
    s.turnEnd = null
    try {
      await invoke('send_control', {
        sessionId: s.id,
        message,
        binary: bin,
        configDir: configDir ?? s.configDir ?? null,
        workingDir: workingDir || s.workingDir || null,
        model: s.model,
      })
    } catch (e) {
      await failCommand(s, e)
    }
  }

  /** A command failed. On the desktop the session stops running; on the web the PC did
   *  nothing, so the phase and state cleared in advance go back to the PC's. Then the reason is shown. */
  async function failCommand(s: SessionState, e: unknown) {
    if (IS_WEB && s.id) await refreshFromHost(s.id).catch(() => {})
    else s.running = false
    s.lastError = String(e)
  }

  /** Sends answers to blocking questions. */
  async function sendAnswers(
    answers: Record<string, string>,
    binary: string,
    configDir?: string,
    workingDir?: string,
  ) {
    if (Object.keys(answers).length === 0) return
    const msg = answersMessage(answers)
    const answersDisplay = Object.entries(answers).map(([k, v]) => `${k}: ${v}`).join('\n')
    await sendAnswerMessageTo(current.value, msg, answersDisplay, binary, configDir, workingDir)
  }

  /** The answers already composed into a message, on an explicit session: the web sends them
   *  this way, and the desktop executes them without having to rebuild them. */
  async function sendAnswerMessageTo(
    s: SessionState,
    msg: string,
    display: string,
    binary: string,
    configDir?: string,
    workingDir?: string,
    remote = false,
  ) {
    if (!s.id) return
    pushAtomTo(s, display, 'UserReply', remote)
    s.pragma.phase = null
    s.running = true
    s.turnEnd = null
    try {
      await invoke('send_control', {
        sessionId: s.id,
        message: msg,
        binary,
        configDir: configDir ?? null,
        workingDir: workingDir ?? s.workingDir ?? null,
        model: s.model,
      })
    } catch (e) {
      await failCommand(s, e)
    }
  }

  /** Sends plan modification instructions. */
  async function sendModifyPlan(
    instructions: string,
    binary: string,
    configDir?: string,
    workingDir?: string,
  ) {
    await sendModifyPlanTo(current.value, instructions, binary, configDir, workingDir)
  }

  async function sendModifyPlanTo(
    s: SessionState,
    instructions: string,
    binary: string,
    configDir?: string,
    workingDir?: string,
    remote = false,
  ) {
    if (!s.id) { console.warn('[sendModifyPlan] sessionId is null — ignoring'); return }
    // From the web a trace stays of who asked for the change; on the desktop as before.
    if (remote) pushAtomTo(s, `✎ Modify plan: ${instructions}`, 'UserReply', true)
    s.running = true
    s.turnEnd = null
    try {
      await invoke('send_control', {
        sessionId: s.id,
        message: `MODIFY_PLAN: ${instructions}`,
        binary,
        configDir: configDir ?? null,
        workingDir: workingDir ?? s.workingDir ?? null,
        model: s.model,
      })
    } catch (e) {
      await failCommand(s, e)
    }
  }

  /**
   * Review "Fix": sends the findings back to the dev session as a corrective turn,
   * then re-reviews the result. Convergence rule: max 2 Fix→Review rounds,
   * enforced by `canFixReview` — past that the decision is the user's.
   */
  async function fixReviewFindings(
    binary: string,
    projectId: string,
    configDir?: string,
    workingDir?: string,
  ) {
    await fixReviewFindingsFor(current.value, binary, projectId, configDir, workingDir)
  }

  async function fixReviewFindingsFor(
    s: SessionState,
    binary: string,
    projectId: string,
    configDir?: string,
    workingDir?: string,
    remote = false,
  ) {
    const review = s.pragma.review
    if (!s.id || !review || review.findings.length === 0) return
    const dir = workingDir || s.workingDir
    if (!dir) {
      s.lastError = 'Review fix requires a working directory.'
      return
    }
    pushAtomTo(s, `→ Fix ${review.findings.length} review finding(s)`, 'UserReply', remote)
    s.pragma.phase = null
    s.running = true
    s.turnEnd = null
    s.reviewFixSent = true
    try {
      await invoke('review_fix', {
        sessionId: s.id,
        findings: review.findings,
        binary,
        configDir: configDir ?? null,
        workingDir: dir,
        projectId,
        round: review.round,
      })
    } catch (e) {
      s.lastError = String(e)
      s.running = false
      s.reviewFixSent = false
    }
  }

  /**
   * Review "Accept": proceed despite the findings. They stay visible in the card and
   * in the session atoms — accepting is a decision on the record, not a dismissal.
   */
  function acceptReviewFindings() {
    const s = current.value
    acceptReviewFindingsFor(s)
    // On the web Accept calls no backend command: without this request it would stay
    // only on the phone (`pragma.review_accept`).
    if (IS_WEB && s.id) {
      invoke('pragma.review_accept', { sessionId: s.id }).catch((e) => failCommand(s, e))
    }
  }

  function acceptReviewFindingsFor(s: SessionState, remote = false) {
    if (!s.pragma.review) return
    s.reviewAccepted = true
    s.pragma.phase = null
    pushAtomTo(s, `✓ Accepted ${s.pragma.review.findings.length} review finding(s)`, 'UserReply', remote)
  }

  /** Max 2 Fix→Review rounds — round is 0-based on the first review. */
  const canFixReview = computed(() => (current.value.pragma.review?.round ?? 0) < 2)

  async function deleteSession(id: string) {
    try {
      if (sessions.value[id]?.running) {
        await invoke('kill_session', { sessionId: id }).catch(() => {})
      }
      await invoke('delete_session', { sessionId: id })
      cancelAutoConfirm(id)
      savedSessions.value = savedSessions.value.filter(s => s.id !== id)
      delete sessions.value[id]
      if (activeKey.value === id) newSession()
    } catch (e) {
      current.value.lastError = String(e)
    }
  }

  /** Stops the active session (or the one indicated: from the list a parallel session
   *  can be stopped too without having to switch to it). */
  async function stopSession(id?: string, remote = false) {
    const s = id ? sessions.value[id] : current.value
    if (!s || !s.id || !s.running) return
    if (remote) pushAtomTo(s, '■ Stopped from the web', 'UserReply', true)
    s.stoppedByUser = true
    s.autoConfirm = false
    cancelAutoConfirm(s.id)
    try {
      await invoke('kill_session', { sessionId: s.id })
    } catch (e) {
      console.error('kill_session:', e)
      s.stoppedByUser = false
    }
    s.pragma.phase = null
    s.running = false
  }

  function toggleCollapse(atomId: string) {
    const atom = current.value.atoms.find(a => a.id === atomId)
    if (atom) atom.collapsed = !atom.collapsed
  }

  function setScrollLocked(locked: boolean) {
    current.value.scrollLocked = locked
    if (locked) current.value.newCount = 0
  }

  function resetDraft() {
    sessions.value[DRAFT_KEY] = createSessionState()
  }

  /**
   * Goes back to the draft to compose a new session. It no longer kills anything: the
   * session that was running continues on its own and stays reachable from the
   * list — that is the whole point of parallel sessions.
   */
  function newSession() {
    resetDraft()
    setActive(DRAFT_KEY)
  }

  /**
   * Session `id` is continued by a new one (restart with a summary after the cache
   * expired): it is no longer waiting for the user, so it must not keep the
   * working dir busy for the one-session-per-directory guard nor offer buttons that would resume it. In
   * memory only: reopening it from the list, the phase goes back to the one saved in the atoms.
   */
  function supersedeSession(id: string) {
    const s = sessions.value[id]
    if (!s || s.running) return
    cancelAutoConfirm(id)
    s.pragma.phase = null
  }

  return {
    // state of the active session (proxy)
    atoms,
    sessionId,
    sessionTitle,
    running,
    newCount,
    scrollLocked,
    lastError,
    pragmaAnalysis,
    pragmaQuestions,
    pragmaPlan,
    pragmaPhase,
    pragmaReport,
    pragmaTests,
    pragmaClosing,
    pragmaRawNote,
    pragmaVerify,
    pragmaReview,
    reviewAccepted,
    reviewFixSent,
    completedSteps,
    sessionUsage,
    sessionCache,
    turnEnd,
    autoConfirmAt,
    sessionModel,
    stepTokenStart,
    sessionWorkingDir,
    sessionAttachments,
    sessionGitBranch,
    // sessioni parallele
    sessions,
    liveSessions,
    runningSessions,
    isRunning,
    isActive,
    // resto
    savedSessions,
    pragmaE2e,
    e2eRunning,
    pragmaLive,
    liveRunning,
    liveOutputLines,
    pipelineOutcome,
    pipelineRunning,
    pipelineOutput,
    pipelineStepIdx,
    initGlobalListeners,
    runE2e,
    stopE2e,
    runLive,
    stopLive,
    runPipeline,
    stopPipeline,
    canFixReview,
    fixReviewFindings,
    fixReviewFindingsFor,
    acceptReviewFindings,
    acceptReviewFindingsFor,
    findConflictingSession,
    startSession,
    adoptScheduledSession,
    deleteSession,
    stopSession,
    sendControl,
    sendControlTo,
    sendAnswers,
    sendAnswerMessageTo,
    sendModifyPlan,
    sendModifyPlanTo,
    loadSession,
    activeProjectId,
    fetchSavedSessions,
    searchSessions,
    duplicateCurrentSession,
    refreshFromHost,
    exportCurrentSession,
    exportCurrentSessionMarkdown,
    toggleCollapse,
    setScrollLocked,
    newSession,
    supersedeSession,
  }
})
