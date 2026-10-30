import { describe, it, expect } from 'vitest'
import { relativeTime } from './scheduled'

describe('relativeTime', () => {
  const now = new Date('2026-08-16T12:00:00Z')

  it('rounds a near-future instant to "now"', () => {
    expect(relativeTime('2026-08-16T12:00:30Z', now)).toBe('now')
  })

  it('formats +90s in minutes', () => {
    expect(relativeTime('2026-08-16T12:01:30Z', now)).toBe('in 2m')
  })

  it('formats +3h with no leftover minutes', () => {
    expect(relativeTime('2026-08-16T15:00:00Z', now)).toBe('in 3h')
  })

  it('formats +3h12m keeping both units', () => {
    expect(relativeTime('2026-08-16T15:12:00Z', now)).toBe('in 3h 12m')
  })

  it('formats +2d in days', () => {
    expect(relativeTime('2026-08-18T12:00:00Z', now)).toBe('in 2d')
  })

  it('formats a past instant with "ago"', () => {
    expect(relativeTime('2026-08-16T11:55:00Z', now)).toBe('5m ago')
  })
})
