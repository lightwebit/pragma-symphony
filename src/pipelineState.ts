import type { PipelineOutcome, PipelineStep } from './stores/session'

// Visual state of the Pipeline button in the toolbar — same family as e2eState.ts and
// liveState.ts: a pure, testable function, the rule lives here and not in the component.
export type PipelineButtonState = 'off' | 'ready' | 'failed' | 'running'

export function pipelineButtonState(
  steps: PipelineStep[] | null | undefined,
  running: boolean,
  lastOutcome: PipelineOutcome | null,
): PipelineButtonState {
  if (running) return 'running'
  // A disabled step does not count: a pipeline with all steps off has
  // nothing to run, so the button must say "not configured" instead of
  // promising a run that would fail right away.
  if (!steps || !steps.some(s => s.enabled)) return 'off'
  if (!lastOutcome) return 'ready'
  return lastOutcome.passed ? 'ready' : 'failed'
}
