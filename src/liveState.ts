import type { PragmaLive } from './stores/session'

// Visual state of the Live button in the toolbar — same principle as e2eState.ts:
// pure testable function, extracted from the component. Unlike E2E there is no
// pass/fail judgement: "failed" here only means "the last run did not
// end cleanly" (non-zero exit code, timeout, or interrupted).
export type LiveButtonState = 'off' | 'ready' | 'failed' | 'running'

export function liveButtonState(
  configuredCommand: string | null | undefined,
  running: boolean,
  lastOutcome: PragmaLive | null,
): LiveButtonState {
  if (running) return 'running'
  if (!configuredCommand) return 'off'
  if (!lastOutcome) return 'ready'
  const cleanExit = !lastOutcome.timedOut && !lastOutcome.cancelled && lastOutcome.exitCode === 0
  return cleanExit ? 'ready' : 'failed'
}
