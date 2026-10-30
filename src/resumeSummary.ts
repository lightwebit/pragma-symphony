import type { SessionState, PragmaPhase } from './stores/session'
import { formatQuestions } from './questions'

/** Ceiling for each block of text: the summary must stay small, that is its purpose. */
const MAX_BLOCK_CHARS = 3000
const MAX_FILES = 40

function clip(text: string): string {
  const t = text.trim()
  return t.length > MAX_BLOCK_CHARS ? `${t.slice(0, MAX_BLOCK_CHARS)}\n[…truncated]` : t
}

/** Prompts written by the user: the turn separator and the labels of the
 *  controls (Approve, Continue, Fix…) are excluded, which the store also records as UserReply. */
function userPrompts(s: SessionState): string[] {
  return s.atoms
    .filter(a => a.atomType === 'UserReply')
    .map(a => a.content)
    .filter(c => c !== '\x00separator' && !c.startsWith('✓ ') && !c.startsWith('→ '))
}

function whereItStopped(phase: PragmaPhase | null, s: SessionState): string {
  switch (phase) {
    case 'awaiting_answers': return 'You had asked the questions below; they were never answered.'
    case 'awaiting_approval': return 'The plan below was waiting for approval.'
    case 'awaiting_confirmation': {
      const done = s.completedSteps.length
      return done
        ? `Step ${done} was done; the next step was waiting for confirmation.`
        : 'The plan below was waiting for confirmation.'
    }
    case 'awaiting_review_decision': return 'A review of the work was waiting for a decision.'
    case 'awaiting_close': return 'The work had been reported as finished.'
    default: return 'The session stopped mid-turn (for example, a usage limit was reached).'
  }
}

/**
 * Prompt to restart with a new session instead of `--resume` when the cache has
 * expired. Everything comes from data already structured in the store — zero tokens to
 * build it — and replaces the conversation: the model re-reads only the files that are needed.
 */
export function buildResumePrompt(s: SessionState): string {
  const parts: string[] = []
  const label = s.title ? `"${s.title}"` : `${s.id?.slice(0, 8) ?? 'unknown'}`
  parts.push(
    `Continue the work of a previous session (${label}). Its context cache expired, so this is `
    + 'a fresh session: the summary below replaces that conversation. Re-read files only where you need them.',
  )

  const prompts = userPrompts(s)
  if (prompts.length) parts.push(`## Original request\n${clip(prompts[0])}`)
  if (prompts.length > 1) parts.push(`## Latest message from the user\n${clip(prompts[prompts.length - 1])}`)

  const p = s.pragma
  if (p.analysis?.text) parts.push(`## Analysis\n${clip(p.analysis.text)}`)
  if (p.plan?.steps.length) {
    parts.push(`## Plan\n${p.plan.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}`)
  }
  if (s.completedSteps.length) {
    parts.push(`## Completed steps\n${s.completedSteps.map(c => `- Step ${c.step}: ${clip(c.result)}`).join('\n')}`)
  }
  if (p.report?.text) parts.push(`## Report\n${clip(p.report.text)}`)

  const files = [...new Set(
    s.atoms.filter(a => a.atomType === 'FileTouch' && a.filePath).map(a => a.filePath as string),
  )]
  if (files.length) {
    const shown = files.slice(0, MAX_FILES).map(f => `- ${f}`)
    if (files.length > MAX_FILES) shown.push(`- …and ${files.length - MAX_FILES} more`)
    parts.push(`## Files touched\n${shown.join('\n')}`)
  }

  let stopped = `## Where it stopped\n${whereItStopped(p.phase, s)}`
  if (p.phase === 'awaiting_answers' && p.questions?.items.length) {
    stopped += `\n${formatQuestions(p.questions.items)}`
  }
  parts.push(stopped)

  return parts.join('\n\n')
}
