import { describe, it, expect } from 'vitest'
import { tabAfterSessionChange, pragmaWantsAttention } from './mobileTabs'

describe('tabAfterSessionChange', () => {
  it('opening a session from the list shows its stream', () => {
    expect(tabAfterSessionChange('sessions', 'abc')).toBe('stream')
  })

  it('switching session keeps the tab the user was reading', () => {
    expect(tabAfterSessionChange('pragma', 'abc')).toBe('pragma')
    expect(tabAfterSessionChange('stream', 'abc')).toBe('stream')
  })

  it('no session in focus goes back to the list', () => {
    expect(tabAfterSessionChange('stream', null)).toBe('sessions')
    expect(tabAfterSessionChange('pragma', null)).toBe('sessions')
  })
})

describe('pragmaWantsAttention', () => {
  it('flags the phases that wait for the user', () => {
    expect(pragmaWantsAttention('awaiting_approval')).toBe(true)
    expect(pragmaWantsAttention('awaiting_answers')).toBe(true)
    expect(pragmaWantsAttention('awaiting_confirmation')).toBe(true)
  })

  it('a confirmation the PC will continue by itself waits for nobody', () => {
    expect(pragmaWantsAttention('awaiting_confirmation', 1_790_000_000_000)).toBe(false)
  })

  it('stays quiet otherwise', () => {
    expect(pragmaWantsAttention(null)).toBe(false)
    expect(pragmaWantsAttention(undefined)).toBe(false)
    expect(pragmaWantsAttention('executing')).toBe(false)
  })
})
