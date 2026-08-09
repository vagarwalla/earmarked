import type { BookOption } from './shared'

export type Rand = () => number

/** Small, fast, seedable PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): Rand {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a 32-bit string hash. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Stable seed derived from the optimizer input, so identical requests produce
 * identical results. Covers item identity/quantity and every candidate
 * listing's identity and economics.
 */
export function seedFromBookOptions(bookOptions: BookOption[]): number {
  const parts: string[] = []
  for (const { item, listings } of bookOptions) {
    parts.push(item.id, String(item.quantity))
    for (const l of listings) {
      parts.push(l.listing_id, String(l.price), String(l.shipping_base), String(l.shipping_per_additional))
    }
  }
  return hashString(parts.join('|'))
}
