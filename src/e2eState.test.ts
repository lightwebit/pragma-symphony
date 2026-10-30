import { describe, it, expect } from 'vitest'
import { e2eButtonState } from './e2eState'
import type { PragmaE2e } from './stores/session'

function outcome(overrides: Partial<PragmaE2e> = {}): PragmaE2e {
  return {
    passed: true,
    failedScenarios: [],
    undetermined: false,
    timedOut: false,
    command: 'npx playwright test',
    durationMs: 1200,
    rawOutput: '',
    runFile: null,
    ...overrides,
  }
}

describe('e2eButtonState', () => {
  it('is off when the project has no e2e command', () => {
    expect(e2eButtonState(null, false, null)).toBe('off')
    expect(e2eButtonState('', false, null)).toBe('off')
    expect(e2eButtonState(undefined, false, null)).toBe('off')
  })

  it('is ready once a command is configured and nothing has run', () => {
    expect(e2eButtonState('npx playwright test', false, null)).toBe('ready')
  })

  it('is ready after a passing run', () => {
    expect(e2eButtonState('npx playwright test', false, outcome())).toBe('ready')
  })

  it('is failed after a failing run', () => {
    const failed = outcome({ passed: false, failedScenarios: ['login flow'] })
    expect(e2eButtonState('npx playwright test', false, failed)).toBe('failed')
  })

  it('is failed after an undetermined run — an unreliable result is never a green', () => {
    const undetermined = outcome({ passed: false, undetermined: true })
    expect(e2eButtonState('npx playwright test', false, undetermined)).toBe('failed')
  })

  it('running wins over every other state', () => {
    // Even without a configured command: if a run is in progress the state must say so,
    // otherwise the button would lie exactly while it is working.
    expect(e2eButtonState(null, true, null)).toBe('running')
    expect(e2eButtonState('npx playwright test', true, outcome({ passed: false }))).toBe('running')
  })
})
