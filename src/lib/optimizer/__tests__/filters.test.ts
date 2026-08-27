import { describe, it, expect, vi } from 'vitest'
import { listingQualifies } from '../shared'
import type { CartItem, Listing } from '@/lib/types'

// normalizeItem lives in the items route, which pulls in supabase at import time.
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
import { normalizeItem } from '@/app/api/cart/[slug]/items/route'

function listing(over: Partial<Listing> = {}): Listing {
  return {
    listing_id: 'l1',
    seller_id: 's1',
    seller_name: 'A Seller',
    price: 8.19,
    shipping_base: 3.99,
    shipping_per_additional: 0,
    condition: 'Good',
    condition_normalized: 'good',
    signed: false,
    first_edition: false,
    dust_jacket: false,
    url: 'https://example.com/l1',
    isbn: '9780062315007',
    ...over,
  }
}

function item(over: Partial<CartItem> = {}): CartItem {
  return normalizeItem({
    title: 'The Alchemist',
    conditions: ['new', 'fine', 'good'],
    ...over,
  }) as unknown as CartItem
}

describe('collectible filters — "Only" toggles are opt-in', () => {
  // The regression that made every stack come back empty: the UI's "Only"
  // toggles are two-state (on/off) and default to off, but the filter read an
  // off toggle as "exclude every copy that has this attribute".
  it('a default item accepts an ordinary listing', () => {
    expect(listingQualifies(item(), listing())).toBe(true)
  })

  it('a default item accepts signed, first-edition and dust-jacketed copies', () => {
    expect(listingQualifies(item(), listing({ signed: true }))).toBe(true)
    expect(listingQualifies(item(), listing({ first_edition: true }))).toBe(true)
    expect(listingQualifies(item(), listing({ dust_jacket: true }))).toBe(true)
    expect(
      listingQualifies(item(), listing({ signed: true, first_edition: true, dust_jacket: true })),
    ).toBe(true)
  })

  it('an explicit toggle still narrows to copies that have the attribute', () => {
    const signedOnly = item({ signed_only: true })
    expect(listingQualifies(signedOnly, listing({ signed: true }))).toBe(true)
    expect(listingQualifies(signedOnly, listing({ signed: false }))).toBe(false)

    const feOnly = item({ first_edition_only: true })
    expect(listingQualifies(feOnly, listing({ first_edition: true }))).toBe(true)
    expect(listingQualifies(feOnly, listing({ first_edition: false }))).toBe(false)

    const djOnly = item({ dust_jacket_only: true })
    expect(listingQualifies(djOnly, listing({ dust_jacket: true }))).toBe(true)
    expect(listingQualifies(djOnly, listing({ dust_jacket: false }))).toBe(false)
  })

  it('toggles are independent — requiring one does not constrain the others', () => {
    const signedOnly = item({ signed_only: true })
    expect(listingQualifies(signedOnly, listing({ signed: true, first_edition: true }))).toBe(true)
    expect(listingQualifies(signedOnly, listing({ signed: true, dust_jacket: true }))).toBe(true)
  })

  // Rows written before the fix carry false; rows written after may carry null.
  // Neither was ever a user asking to exclude anything, so both mean "any".
  it('treats a stored false and a stored null identically', () => {
    for (const off of [false, null] as const) {
      const it_ = {
        ...item(),
        signed_only: off,
        first_edition_only: off,
        dust_jacket_only: off,
      } as CartItem
      expect(listingQualifies(it_, listing({ signed: true, first_edition: true, dust_jacket: true }))).toBe(true)
    }
  })

  it('still applies condition and price filters', () => {
    expect(listingQualifies(item({ conditions: ['new'] }), listing({ condition_normalized: 'good' }))).toBe(false)
    expect(listingQualifies(item({ max_price: 5 }), listing({ price: 8.19 }))).toBe(false)
    expect(listingQualifies(item({ max_price: 10 }), listing({ price: 8.19 }))).toBe(true)
  })
})
