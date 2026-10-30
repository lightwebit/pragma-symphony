// On the PC: watches the live state of sessions and sends it to the web when it changes.
// Backend events are not enough: Approve, Continue and Stop pressed on the desktop, the auto-confirm
// timer and a freshly started session change the state only in the store's
// memory. Without this, on the phone a session approved from the PC would stay «awaiting
// approval» for the whole turn.

/** What matters to the web about a session: if it changes, it is published. Usage and cache do not — they change on
 *  every model call and already have their own event. */
export interface LiveState {
  running: boolean
  phase: string | null
  turnEnd: unknown
  autoConfirm: boolean
  autoConfirmAt: number | null
  lastError: string | null
}

export function stateKey(s: LiveState): string {
  return JSON.stringify([s.running, s.phase, s.turnEnd ?? null, s.autoConfirm, s.autoConfirmAt, s.lastError])
}

/** Compares the current keys with those already published and says which sessions changed.
 *  A session seen for the first time counts as changed: on the web it may have just been born. */
export function createStateDiffer() {
  let last = new Map<string, string>()
  return function changed(current: Map<string, string>): string[] {
    const out: string[] = []
    for (const [id, key] of current) if (last.get(id) !== key) out.push(id)
    last = current
    return out
  }
}
