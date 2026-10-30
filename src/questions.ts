/** A model question and, if the user has to choose, its options. */
export interface QuestionItem {
  text: string
  options: string[]
}

/** Strips leading numbering (`1. `, `2) `, even repeated: `1. 1. `). null if there is none. */
function stripNumbering(s: string): string | null {
  const m = s.match(/^(?:\d+[.)]\s+)+/)
  return m ? s.slice(m[0].length) : null
}

function stripBullet(s: string): string | null {
  const m = s.match(/^[-*•]\s+/)
  return m ? s.slice(m[0].length) : null
}

const LETTERED = /^\(?[A-Za-z]\)\s/

/**
 * Groups the QUESTIONS lines into questions with their options. Twin of
 * `group_questions` in `src-tauri/src/protocol.rs`: same rules, same test cases. Here
 * it serves to rebuild the questions from saved atoms, including those written by older versions,
 * where options were separate items (`2. - (a) …`).
 */
export function groupQuestions(lines: string[]): QuestionItem[] {
  const clean = lines.map(l => l.trim()).filter(l => l && !/^-+$/.test(l))
  const numbered = clean.some(l => stripNumbering(l) !== null)
  const out: QuestionItem[] = []

  for (const line of clean) {
    const num = stripNumbering(line)
    const wasNumbered = num !== null
    const body = num ?? line
    const bullet = stripBullet(body)
    const isOption = numbered && (bullet !== null || (!wasNumbered && LETTERED.test(body)))

    if (isOption) {
      const text = bullet ?? body
      const last = out[out.length - 1]
      if (last) last.options.push(text)
      else out.push({ text, options: [] })
    } else if (wasNumbered || (!numbered && bullet !== null) || out.length === 0) {
      out.push({ text: bullet ?? body, options: [] })
    } else {
      out[out.length - 1].text += `\n${body}`
    }
  }
  return out
}

/** Text form of the questions, for the stream and for the DB: re-readable, and `groupQuestions`
 *  brings it back to the same structure. Continuation lines stay under the question. */
export function formatQuestions(items: QuestionItem[]): string {
  return items
    .map((q, i) => [
      `${i + 1}. ${q.text}`,
      ...q.options.map(o => `   - ${o}`),
    ].join('\n'))
    .join('\n')
}

/**
 * The `ANSWERS:` message for the model: one line per question. Answers used to be
 * joined with a space (`Q1=… Q2=…`), unreadable as soon as an answer contained one.
 * Empty or all-empty `perQuestion`: only `note` counts, as a single answer (the
 * earlier behaviour).
 */
export function buildAnswers(perQuestion: string[], note: string): Record<string, string> {
  const answers = perQuestion.map(a => a.trim())
  const extra = note.trim()
  if (!answers.some(Boolean)) return extra ? { Q1: extra } : {}
  const out: Record<string, string> = {}
  answers.forEach((a, i) => { out[`Q${i + 1}`] = a || '(no answer — decide yourself and say what you chose)' })
  if (extra) out.Note = extra
  return out
}

export function answersMessage(answers: Record<string, string>): string {
  return `ANSWERS:\n${Object.entries(answers).map(([k, v]) => `${k}: ${v}`).join('\n')}`
}
