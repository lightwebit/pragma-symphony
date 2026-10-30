// The PIN for commands from the web. It is the minimum that ties commands to whoever owns the PC instead of
// whoever has the link (Anthropic's terms: the account must not be made available to others).
// On the PC only `salt:sha256(salt+PIN)` is saved; the phone asks for it once and keeps it in memory;
// the bridge verifies it on every command.

// 4 digits are enough: the bridge locks commands after 5 wrong PINs (5 in 10,000), and to
// get as far as trying one you need the link anyway, which is a 256-bit secret.
export const PIN_MIN_DIGITS = 4
export const PIN_MAX_DIGITS = 12

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN_DIGITS},${PIN_MAX_DIGITS}}$`).test(pin)
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

/** `salt:hash` to save in settings. */
export async function hashPin(pin: string, salt?: string): Promise<string> {
  const s = salt ?? hex(crypto.getRandomValues(new Uint8Array(16)))
  return `${s}:${await sha256Hex(s + pin)}`
}

/** Constant-time comparison on the hash: nothing to learn from the response time. */
export async function verifyPin(pin: unknown, stored: string): Promise<boolean> {
  if (typeof pin !== 'string' || !isValidPin(pin)) return false
  const [salt, expected] = stored.split(':')
  if (!salt || !expected) return false
  const got = (await hashPin(pin, salt)).split(':')[1]
  if (got.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}
