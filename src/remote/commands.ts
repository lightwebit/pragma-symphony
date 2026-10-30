// On the PC: runs a command that arrived from the web. It never calls the backend with the
// web's arguments: it goes through the desktop store's actions, with two intended consequences —
//   1. a double command is impossible: the check and the state change (`running`, phase) sit in
//      the same tick, so between a desktop Approve, a web one and the auto-confirm
//      firing the first wins and the others get `conflict`;
//   2. the desktop sees the action happen (atom, phase, spinner) with no special cases.
// Executable, config and folder are decided by the desktop: the local profile and the working dir
// of the project or session. Every atom written for a web command is marked `Remote`.

import type { CommandCommand } from './policy'
import type { SessionState } from '../stores/session'

/** A refusal with its protocol code (`conflict`, `not_allowed`, `bad_request`). */
export class CommandRefused extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'CommandRefused'
  }
}

interface Profile { label: string; binary: string; configDir?: string | null }
interface ProjectInfo { id: string; workingDir?: string | null }

/** The part of the sessions store needed here. */
export interface SessionActions {
  sessions: Record<string, SessionState>
  loadSession(id: string, opts?: { focus?: boolean }): Promise<void>
  findConflictingSession(projectId: string, workingDir: string): SessionState | null
  startSession(opts: Record<string, unknown>): Promise<string | null>
  sendControlTo(s: SessionState, message: any, binary?: string, configDir?: string, workingDir?: string, remote?: boolean): Promise<void>
  sendAnswerMessageTo(s: SessionState, msg: string, display: string, binary: string, configDir?: string, workingDir?: string, remote?: boolean): Promise<void>
  sendModifyPlanTo(s: SessionState, instructions: string, binary: string, configDir?: string, workingDir?: string, remote?: boolean): Promise<void>
  fixReviewFindingsFor(s: SessionState, binary: string, projectId: string, configDir?: string, workingDir?: string, remote?: boolean): Promise<void>
  acceptReviewFindingsFor(s: SessionState, remote?: boolean): void
  stopSession(id?: string, remote?: boolean): Promise<void>
}

export interface CommandDeps {
  session: SessionActions
  profiles(): Profile[]
  defaultProfileIndex(): number
  projects(): ProjectInfo[]
  /** The backend, for commands that do not touch a session (todo, scheduled). */
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>
  /** After a todo or scheduled command: the desktop's lists are re-read. */
  refreshLists(projectId: string | null): void
}

const CONTROL_WORDS = ['APPROVED', 'CONTINUE', 'FINALIZE', 'ABORT', 'SKIP_QUESTIONS']
const MODIFY_PREFIX = 'MODIFY_PLAN: '

export function createCommandRunner(deps: CommandDeps) {
  function profileFor(label: unknown): Profile {
    const list = deps.profiles()
    const p = list.find(x => x.label === label) ?? list[deps.defaultProfileIndex()] ?? list[0]
    if (!p || !p.binary) throw new CommandRefused('not_allowed', 'No Claude profile is configured on the PC.')
    return p
  }

  function projectDir(projectId: unknown): string {
    const p = deps.projects().find(x => x.id === projectId)
    if (!p) throw new CommandRefused('not_allowed', 'Unknown project.')
    if (!p.workingDir) throw new CommandRefused('not_allowed', 'This project has no working directory on the PC.')
    return p.workingDir
  }

  /** The session in memory on the desktop; if it is not there (opened on the web but never on the PC since it
   *  started) it is loaded without bringing it into focus. */
  async function sessionOf(id: unknown): Promise<SessionState> {
    const sid = String(id)
    if (!deps.session.sessions[sid]) await deps.session.loadSession(sid, { focus: false })
    const s = deps.session.sessions[sid]
    if (!s) throw new CommandRefused('not_allowed', 'Unknown session.')
    return s
  }

  function busy(s: SessionState): never {
    throw new CommandRefused('conflict', s.running
      ? 'The session is already running — someone got there first.'
      : 'Nothing is waiting for a decision in this session.')
  }

  async function run(cmd: CommandCommand, a: Record<string, unknown>): Promise<unknown> {
    switch (cmd) {
      case 'save_local_atom':
        return null // the saved copy is written by the desktop, marked `Remote`

      case 'run_pragma': {
        const p = profileFor(a.profileLabel)
        const resumeId = a.existingSessionId as string | null
        let projectId = a.projectId as string
        let workingDir: string
        if (resumeId) {
          const s = await sessionOf(resumeId)
          if (s.running) busy(s)
          projectId = s.projectId || projectId
          workingDir = s.workingDir || projectDir(projectId)
        } else {
          workingDir = projectDir(projectId)
          const other = deps.session.findConflictingSession(projectId, workingDir)
          if (other) throw new CommandRefused('conflict', 'Another session is still active on this project.')
        }
        return deps.session.startSession({
          prompt: a.prompt, binary: p.binary, configDir: p.configDir ?? null, profileLabel: p.label,
          projectId, workingDir, title: a.title, model: a.model ?? undefined,
          resumeId, sessionId: a.newSessionId, attachments: [],
          stepByStep: !!a.stepByStep, autoConfirm: !!a.autoConfirm, remote: true,
        })
      }

      case 'send_control': {
        const s = await sessionOf(a.sessionId)
        if (s.running || s.pragma.phase === null) busy(s)
        const p = profileFor(null)
        const bin = s.binary || p.binary
        const cfg = s.binary ? (s.configDir ?? undefined) : (p.configDir ?? undefined)
        const msg = a.message as string
        if (CONTROL_WORDS.includes(msg)) {
          await deps.session.sendControlTo(s, msg, bin, cfg, s.workingDir || undefined, true)
        } else if (msg.startsWith(MODIFY_PREFIX)) {
          if (s.pragma.phase !== 'awaiting_approval') busy(s)
          await deps.session.sendModifyPlanTo(s, msg.slice(MODIFY_PREFIX.length), bin, cfg, s.workingDir || undefined, true)
        } else if (s.pragma.phase === 'awaiting_answers') {
          await deps.session.sendAnswerMessageTo(s, msg, msg, bin, cfg, s.workingDir || undefined, true)
        } else {
          throw new CommandRefused('bad_request', 'Not a message this session is waiting for.')
        }
        return null
      }

      case 'review_fix': {
        const s = await sessionOf(a.sessionId)
        if (s.running || s.pragma.phase === null || !s.pragma.review) busy(s)
        const p = profileFor(null)
        await deps.session.fixReviewFindingsFor(
          s, s.binary || p.binary, s.projectId, (s.binary ? s.configDir : p.configDir) ?? undefined,
          s.workingDir || undefined, true)
        return null
      }

      case 'pragma.review_accept': {
        const s = await sessionOf(a.sessionId)
        if (s.running || s.pragma.phase === null || !s.pragma.review) busy(s)
        deps.session.acceptReviewFindingsFor(s, true)
        return null
      }

      case 'kill_session': {
        const s = await sessionOf(a.sessionId)
        if (!s.running) throw new CommandRefused('conflict', 'The session is not running.')
        await deps.session.stopSession(s.id!, true)
        return null
      }

      case 'create_scheduled_session': {
        // Project folder and no attachments; the binary is chosen by the scheduler from the local profile.
        const workingDir = projectDir(a.projectId)
        const row = await deps.invoke('create_scheduled_session', { ...a, workingDir, attachments: [] })
        deps.refreshLists(a.projectId as string)
        return row
      }

      default: {
        // Existing todos and scheduled sessions: nothing to run on the PC besides the command itself.
        const result = await deps.invoke(cmd, a)
        deps.refreshLists((a.projectId as string | undefined) ?? null)
        return result
      }
    }
  }

  return { run }
}
