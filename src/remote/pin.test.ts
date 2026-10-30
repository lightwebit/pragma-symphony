import { describe, it, expect } from 'vitest'
import { hashPin, verifyPin, isValidPin } from './pin'

describe('command PIN', () => {
  it('4 to 12 digits, digits only', () => {
    expect(isValidPin('1234')).toBe(true)
    expect(isValidPin('123456789012')).toBe(true)
    expect(isValidPin('123')).toBe(false)
    expect(isValidPin('1234567890123')).toBe(false)
    expect(isValidPin('12a4')).toBe(false)
    expect(isValidPin(' 1234')).toBe(false)
  })

  it('is saved as salt:hash, never in plain text, with a new salt every time', async () => {
    const a = await hashPin('4321')
    const b = await hashPin('4321')
    expect(a).not.toContain('4321')
    expect(a).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })

  it('verifies the right PIN and refuses the rest', async () => {
    const stored = await hashPin('4321')
    expect(await verifyPin('4321', stored)).toBe(true)
    expect(await verifyPin('4322', stored)).toBe(false)
    expect(await verifyPin(4321, stored)).toBe(false)
    expect(await verifyPin(undefined, stored)).toBe(false)
    expect(await verifyPin('4321', '')).toBe(false)
  })
})
