import type { SessionCache } from './stores/session'

/** Below this threshold rewriting the context costs little: the warning would be just noise. */
export const CACHE_WARN_MIN_TOKENS = 50_000

/** Duration assumed when no recorded call declared it: the shortest,
 *  so when in doubt we warn instead of staying silent. */
const DEFAULT_TTL_SECS = 300

export interface ExpiredCache {
  contextTokens: number
  idleMinutes: number
  /** How many times more it costs to rewrite the context than to re-read it from the cache:
   *  read 0.1× the input, write 1.25× (5 minutes) or 2× (1 hour). Holds for every model. */
  rewriteVsRead: number
}

/** Has the session's cache expired, and is the context big enough to matter?
 *  `now` in milliseconds, passed in from outside because the UI updates it at intervals. */
export function expiredCache(cache: SessionCache | null, now: number): ExpiredCache | null {
  if (!cache || cache.contextTokens < CACHE_WARN_MIN_TOKENS) return null
  const last = Date.parse(cache.lastCallAt)
  if (Number.isNaN(last)) return null
  const ttl = cache.ttlSecs ?? DEFAULT_TTL_SECS
  const idleMs = now - last
  if (idleMs <= ttl * 1000) return null
  return {
    contextTokens: cache.contextTokens,
    idleMinutes: Math.floor(idleMs / 60_000),
    rewriteVsRead: ttl >= 3600 ? 20 : 12.5,
  }
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

export function formatIdle(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h}h ${m}min` : `${h}h`
}
