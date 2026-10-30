import type { PragmaE2e } from './stores/session'

// Visual state of the E2E button in the toolbar. Extracted from App.vue to be a pure,
// testable function: the rule that an E2E failure is not a blocking
// error lives here, and must be protected from a silent regression.
export type E2eButtonState = 'off' | 'ready' | 'failed' | 'running'

export function e2eButtonState(
  configuredCommand: string | null | undefined,
  running: boolean,
  lastOutcome: PragmaE2e | null,
): E2eButtonState {
  if (running) return 'running'
  if (!configuredCommand) return 'off'
  return lastOutcome && !lastOutcome.passed ? 'failed' : 'ready'
}
