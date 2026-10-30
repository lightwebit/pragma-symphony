import { describe, it, expect } from 'vitest'
import { pipelineButtonState } from './pipelineState'
import type { PipelineOutcome, PipelineStep } from './stores/session'

function step(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return {
    id: '1',
    label: 'Build',
    command: 'cargo build',
    kind: 'command',
    enabled: true,
    ...overrides,
  }
}

function outcome(overrides: Partial<PipelineOutcome> = {}): PipelineOutcome {
  return {
    passed: true,
    steps: [],
    durationMs: 1200,
    stoppedEarly: false,
    ...overrides,
  }
}

describe('pipelineButtonState', () => {
  it('is off with no steps at all', () => {
    expect(pipelineButtonState(null, false, null)).toBe('off')
    expect(pipelineButtonState(undefined, false, null)).toBe('off')
    expect(pipelineButtonState([], false, null)).toBe('off')
  })

  it('is off when every step is disabled — there is nothing to run', () => {
    const allDisabled = [step({ enabled: false }), step({ id: '2', enabled: false })]
    expect(pipelineButtonState(allDisabled, false, null)).toBe('off')
  })

  it('is ready when at least one step is enabled', () => {
    const mixed = [step({ enabled: false }), step({ id: '2', enabled: true })]
    expect(pipelineButtonState(mixed, false, null)).toBe('ready')
  })

  it('is ready after a passing run', () => {
    expect(pipelineButtonState([step()], false, outcome())).toBe('ready')
  })

  it('is failed after a failing run', () => {
    expect(pipelineButtonState([step()], false, outcome({ passed: false }))).toBe('failed')
  })

  it('running wins over every other state', () => {
    expect(pipelineButtonState(null, true, null)).toBe('running')
    expect(pipelineButtonState([step()], true, outcome({ passed: false }))).toBe('running')
  })
})
