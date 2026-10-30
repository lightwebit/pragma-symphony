import { describe, it, expect } from 'vitest'
import { createStateDiffer, stateKey, type LiveState } from './statePublisher'

const base: LiveState = {
  running: false, phase: 'awaiting_approval', turnEnd: null,
  autoConfirm: true, autoConfirmAt: null, lastError: null,
}
const keys = (entries: [string, Partial<LiveState>][]) =>
  new Map(entries.map(([id, over]) => [id, stateKey({ ...base, ...over })]))

describe('createStateDiffer', () => {
  it('the first time every session counts as changed: on the web it may be new', () => {
    const changed = createStateDiffer()
    expect(changed(keys([['a', {}], ['b', {}]]))).toEqual(['a', 'b'])
  })

  it('publishes only the sessions whose live state changed', () => {
    const changed = createStateDiffer()
    changed(keys([['a', {}], ['b', {}]]))
    expect(changed(keys([['a', { running: true, phase: null }], ['b', {}]]))).toEqual(['a'])
    expect(changed(keys([['a', { running: true, phase: null }], ['b', {}]]))).toEqual([])
  })

  it("the auto-confirm deadline is a change", () => {
    const changed = createStateDiffer()
    changed(keys([['a', { phase: 'awaiting_confirmation' }]]))
    expect(changed(keys([['a', { phase: 'awaiting_confirmation', autoConfirmAt: 5 }]]))).toEqual(['a'])
  })

  it('a session removed from the store produces nothing', () => {
    const changed = createStateDiffer()
    changed(keys([['a', {}], ['b', {}]]))
    expect(changed(keys([['a', {}]]))).toEqual([])
  })
})
