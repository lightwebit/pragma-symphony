import { describe, it, expect } from 'vitest'
import { groupQuestions, formatQuestions, buildAnswers, answersMessage } from './questions'

// The same cases as `protocol.rs`: the two implementations must stay twins.
describe('groupQuestions', () => {
  it('numbered questions with their options', () => {
    expect(groupQuestions([
      '1. **How do you want to handle step A?** Three options:',
      '   - **(a)** Run A first',
      '   - **(b)** Run A and B back to back',
      '2. Hai allegato il documento dalla cartella radice?',
    ])).toEqual([
      { text: '**How do you want to handle step A?** Three options:', options: ['**(a)** Run A first', '**(b)** Run A and B back to back'] },
      { text: 'Hai allegato il documento dalla cartella radice?', options: [] },
    ])
  })

  it('options with a letter and without a dash', () => {
    expect(groupQuestions(['1. Quale provider?', '(a) Ollama locale', 'b) Claude']))
      .toEqual([{ text: 'Quale provider?', options: ['(a) Ollama locale', 'b) Claude'] }])
  })

  it('repeated numbering disappears', () => {
    expect(groupQuestions(['1. 1. Confermi?'])).toEqual([{ text: 'Confermi?', options: [] }])
  })

  it('without numbers every item is a question (earlier protocol format)', () => {
    expect(groupQuestions(['- Primo dubbio?', '- Secondo dubbio?']))
      .toEqual([{ text: 'Primo dubbio?', options: [] }, { text: 'Secondo dubbio?', options: [] }])
  })

  it('a block of prose stays a single question', () => {
    expect(groupQuestions(['**D-28 — Chi legge la casella**', 'Coerente con D-24.', '*Caselle*: tre account IMAP.']))
      .toEqual([{ text: '**D-28 — Chi legge la casella**\nCoerente con D-24.\n*Caselle*: tre account IMAP.', options: [] }])
  })

  it('re-reads atoms saved by older versions, where options were separate items', () => {
    // As it was in the DB: the frontend numbered every line, options included.
    expect(groupQuestions([
      '1. 1. **LLM provider — which path?**',
      '2. - (a) Local Ollama',
      '3. - (b) Claude/hosted',
      '4. 2. **Do you want to:**',
      '5. - (i) configure the key first',
    ])).toEqual([
      { text: '**LLM provider — which path?**', options: ['(a) Local Ollama', '(b) Claude/hosted'] },
      { text: '**Do you want to:**', options: ['(i) configure the key first'] },
    ])
  })
})

describe('formatQuestions', () => {
  it('is re-readable and groupQuestions brings it back to the same structure', () => {
    const items = [
      { text: 'Formato?', options: ['CSV', 'JSON'] },
      { text: 'Serve la CLI?', options: [] },
    ]
    const text = formatQuestions(items)
    expect(text).toBe('1. Formato?\n   - CSV\n   - JSON\n2. Serve la CLI?')
    expect(groupQuestions(text.split('\n'))).toEqual(items)
  })
})

describe('answers', () => {
  it('one line per question, even with spaces inside the answers', () => {
    const r = buildAnswers(['CSV con intestazione', 'sì, con i tre comandi'], '')
    expect(answersMessage(r)).toBe('ANSWERS:\nQ1: CSV con intestazione\nQ2: sì, con i tre comandi')
  })

  it('a question left empty says so, and the note goes last', () => {
    expect(buildAnswers(['CSV', ''], 'fai pure i test'))
      .toEqual({ Q1: 'CSV', Q2: '(no answer — decide yourself and say what you chose)', Note: 'fai pure i test' })
  })

  it('without per-question answers the main field counts, as in earlier versions', () => {
    expect(buildAnswers([], 'Decidi tu')).toEqual({ Q1: 'Decidi tu' })
    expect(buildAnswers(['', ''], 'Decidi tu')).toEqual({ Q1: 'Decidi tu' })
  })

  it('nothing written, nothing to send', () => {
    expect(buildAnswers(['', ' '], '  ')).toEqual({})
  })
})
