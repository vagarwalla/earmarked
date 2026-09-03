import { describe, it, expect, vi, afterEach } from 'vitest'
import { keysMatch, ownerKey } from '../auth'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('ownerKey', () => {
  it('is null when the door was never opened', () => {
    // Unset means the door does not exist, not that it is unlocked. The route
    // 404s on a null key, which is the same answer it gives a wrong one.
    vi.stubEnv('PRESS_OWNER_KEY', '')
    expect(ownerKey()).toBeNull()
  })

  it('refuses a key short enough to be a placeholder', () => {
    // "secret", "changeme", a half-pasted value. Treating one of those as a
    // credential would be worse than having none at all.
    vi.stubEnv('PRESS_OWNER_KEY', 'changeme')
    expect(ownerKey()).toBeNull()
  })

  it('accepts one that could plausibly have been generated', () => {
    const key = 'a'.repeat(48)
    vi.stubEnv('PRESS_OWNER_KEY', key)
    expect(ownerKey()).toBe(key)
  })
})

describe('keysMatch', () => {
  it('accepts the key itself and nothing near it', () => {
    const key = 'f'.repeat(48)
    expect(keysMatch(key, key)).toBe(true)
    expect(keysMatch(`${key}x`, key)).toBe(false)
    expect(keysMatch(key.slice(0, -1), key)).toBe(false)
    expect(keysMatch(`e${key.slice(1)}`, key)).toBe(false)
    expect(keysMatch('', key)).toBe(false)
  })

  it('compares every character of a same-length guess', () => {
    // The loop must not stop at the first difference, or how long a wrong
    // guess takes says how much of it was right. Asserting the shape rather
    // than timing it, which no test can do reliably: a mismatch in the last
    // position and one in the first are both simply false.
    const key = 'ab'.repeat(24)
    expect(keysMatch(`${key.slice(0, -1)}z`, key)).toBe(false)
    expect(keysMatch(`z${key.slice(1)}`, key)).toBe(false)
  })
})
