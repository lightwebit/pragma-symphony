// Tab layout of the web version on a narrow screen. Below this width the three desktop panels
// (sessions · stream · pragma, designed for 1400+ px) become one panel at a time.
// At 900 px the stream would be left with ~380 px between the two side panels: better one whole than three squeezed.
export const MOBILE_MAX_PX = 899

export type MobileTab = 'sessions' | 'stream' | 'pragma'

/** The tab after the focused session changes. Whoever opens a session from the list wants to see it,
 *  and the stream is the complete view (in focus mode it also contains analysis, plan and report); if
 *  there is no longer a focused session, the only thing to do is pick one. */
export function tabAfterSessionChange(current: MobileTab, sessionId: string | null): MobileTab {
  if (!sessionId) return 'sessions'
  return current === 'sessions' ? 'stream' : current
}

/** Phases in which the session waits for a decision: the Pragma tab flags it with a dot.
 *  A confirmation with the auto-confirm timer running on the PC waits for nobody. */
export function pragmaWantsAttention(phase: string | null | undefined, autoConfirmAt: number | null = null): boolean {
  if (phase === 'awaiting_confirmation') return autoConfirmAt === null
  return phase === 'awaiting_approval' || phase === 'awaiting_answers'
}
