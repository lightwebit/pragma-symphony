import { describe, it, expect } from 'vitest'
import { liveButtonState } from './liveState'
import type { PragmaLive } from './stores/session'

function outcome(overrides: Partial<PragmaLive> = {}): PragmaLive {
  return {
    command: 'npm run tauri dev',
    output: '',
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    durationMs: 1200,
    ...overrides,
  }
}

describe('liveButtonState', () => {
  it('is off when the project has no live command', () => {
    expect(liveButtonState(null, false, null)).toBe('off')
    expect(liveButtonState('', false, null)).toBe('off')
    expect(liveButtonState(undefined, false, null)).toBe('off')
  })

  it('is ready once a command is configured and nothing has run', () => {
    expect(liveButtonState('cargo build', false, null)).toBe('ready')
  })

  it('is ready after a clean exit', () => {
    expect(liveButtonState('cargo build', false, outcome())).toBe('ready')
  })

  it('is failed after a non-zero exit code', () => {
    const failed = outcome({ exitCode: 1 })
    expect(liveButtonState('cargo build', false, failed)).toBe('failed')
  })

  it('is failed after a timeout even if exitCode looks clean', () => {
    const timedOut = outcome({ exitCode: null, timedOut: true })
    expect(liveButtonState('cargo build', false, timedOut)).toBe('failed')
  })

  it('is failed after a manual cancel — an interrupted run is not a success', () => {
    const cancelled = outcome({ exitCode: null, cancelled: true })
    expect(liveButtonState('cargo build', false, cancelled)).toBe('failed')
  })

  it('running wins over every other state', () => {
    expect(liveButtonState(null, true, null)).toBe('running')
    expect(liveButtonState('cargo build', true, outcome({ exitCode: 1 }))).toBe('running')
  })
})
