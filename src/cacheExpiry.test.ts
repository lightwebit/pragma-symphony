import { describe, it, expect } from 'vitest'
import { expiredCache, formatIdle, formatTokens, CACHE_WARN_MIN_TOKENS } from './cacheExpiry'

const T0 = Date.parse('2026-09-23T13:50:00Z')
const min = (n: number) => T0 + n * 60_000

describe('expiredCache', () => {
  const big = { contextTokens: 279_000, ttlSecs: 3600, lastCallAt: '2026-09-23T13:50:00Z' }

  it('a 1-hour cache, resumed after 90 minutes', () => {
    expect(expiredCache(big, min(90))).toEqual({
      contextTokens: 279_000, idleMinutes: 90, rewriteVsRead: 20,
    })
  })

  it('says nothing while inside the cache lifetime', () => {
    expect(expiredCache(big, min(59))).toBeNull()
    expect(expiredCache(big, min(60))).toBeNull()
  })

  it('5-minute cache: expires sooner and costs 12.5× a read', () => {
    const c = { ...big, ttlSecs: 300 }
    expect(expiredCache(c, min(5))).toBeNull()
    expect(expiredCache(c, min(6))?.rewriteVsRead).toBe(12.5)
  })

  it('unknown lifetime: assume the shortest, warn when in doubt', () => {
    expect(expiredCache({ ...big, ttlSecs: null }, min(6))).not.toBeNull()
  })

  it('a small context does not deserve the warning', () => {
    expect(expiredCache({ ...big, contextTokens: CACHE_WARN_MIN_TOKENS - 1 }, min(600))).toBeNull()
  })

  it('no snapshot or unreadable date: no warning', () => {
    expect(expiredCache(null, min(600))).toBeNull()
    expect(expiredCache({ ...big, lastCallAt: 'boh' }, min(600))).toBeNull()
  })
})

describe('formatting', () => {
  it('tokens in thousands', () => {
    expect(formatTokens(278_769)).toBe('279k')
    expect(formatTokens(800)).toBe('800')
  })

  it('wait in minutes and hours', () => {
    expect(formatIdle(45)).toBe('45 min')
    expect(formatIdle(90)).toBe('1h 30min')
    expect(formatIdle(120)).toBe('2h')
  })
})
