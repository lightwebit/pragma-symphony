import { describe, it, expect } from 'vitest'
import { buildResumePrompt } from './resumeSummary'
import { createSessionState, type Atom } from './stores/session'

function atom(atomType: Atom['atomType'], content: string, filePath: string | null = null): Atom {
  return {
    id: crypto.randomUUID(), atomType, filePath, fileType: null, action: null, content,
    collapsed: false, source: 'Stdout', receivedAt: '', sessionId: 's1',
  }
}

describe('buildResumePrompt', () => {
  const s = createSessionState({
    id: 's1-abcdef', title: 'Conti',
    atoms: [
      atom('UserReply', 'Esegui il lavoro descritto in SCHEDA.md.'),
      atom('FileTouch', '', 'lib/saldi.js'),
      atom('UserReply', '✓ Plan approved'),
      atom('UserReply', '\x00separator'),
      atom('UserReply', 'Aggiungi il comando rimborsi.'),
      atom('FileTouch', '', 'lib/saldi.js'),
      atom('FileTouch', '', 'lib/rimborsi.js'),
      atom('UserReply', '→ Continue'),
    ],
    completedSteps: [{ step: 1, result: 'Creato lib/rimborsi.js' }],
  })
  s.pragma.analysis = { text: 'A new module is needed.' }
  s.pragma.plan = { steps: ['Creare lib/rimborsi.js', 'Aggiungere i test'] }
  s.pragma.phase = 'awaiting_confirmation'

  const out = buildResumePrompt(s)

  it('starts from the original request and the last user message', () => {
    expect(out).toContain('"Conti"')
    expect(out).toContain('## Original request\nEsegui il lavoro descritto in SCHEDA.md.')
    expect(out).toContain('## Latest message from the user\nAggiungi il comando rimborsi.')
  })

  it('does not mistake the controls and the separator for user messages', () => {
    expect(out).not.toContain('Plan approved')
    expect(out).not.toContain('→ Continue')
    expect(out).not.toContain('\x00')
  })

  it('carries the analysis, the numbered plan and the completed steps', () => {
    expect(out).toContain('## Analysis\nA new module is needed.')
    expect(out).toContain('## Plan\n1. Creare lib/rimborsi.js\n2. Aggiungere i test')
    expect(out).toContain('- Step 1: Creato lib/rimborsi.js')
  })

  it('lists the touched files only once', () => {
    expect(out).toContain('## Files touched\n- lib/saldi.js\n- lib/rimborsi.js')
  })

  it('says where it stopped', () => {
    expect(out).toContain('Step 1 was done; the next step was waiting for confirmation.')
  })

  it('with pending questions, it reports them', () => {
    const q = createSessionState({ id: 's2', atoms: [atom('UserReply', 'Fai X.')] })
    q.pragma.questions = { items: [{ text: 'Quale formato?', options: ['CSV', 'JSON'] }, { text: 'Serve la CLI?', options: [] }] }
    q.pragma.phase = 'awaiting_answers'
    const text = buildResumePrompt(q)
    expect(text).toContain('never answered.\n1. Quale formato?\n   - CSV\n   - JSON\n2. Serve la CLI?')
    expect(text).not.toContain('## Latest message')
  })

  it('cuts blocks that are too long', () => {
    const long = createSessionState({ id: 's3', atoms: [atom('UserReply', 'x'.repeat(10_000))] })
    const text = buildResumePrompt(long)
    expect(text).toContain('[…truncated]')
    expect(text.length).toBeLessThan(4_000)
  })
})
