import { describe, it, expect } from 'vitest'
import { optimize } from '../index'
import { localSearchStrategy } from '../strategies/local-search'
import { buildBookOptions } from '../shared'
import type { CartItem, Condition, Listing } from '../../types'

function makeItem(id: string): CartItem {
  return {
    id, cart_id: 'c', title: id, author: null, work_id: null,
    isbn_preferred: `isbn-${id}`, cover_url: null, format: 'any',
    conditions: ['new', 'fine', 'good', 'fair'] as Condition[],
    max_price: null, flexible: false, signed_only: null,
    first_edition_only: null, dust_jacket_only: null,
    quantity: 1, sort_order: 0, created_at: '', isbns_candidates: null,
  }
}

function makeListing(sellerId: string, isbn: string, price: number): Listing {
  return {
    listing_id: `${sellerId}-${isbn}`, seller_id: sellerId, seller_name: sellerId,
    price, shipping_base: 3.99, shipping_per_additional: 1.99,
    condition: 'Fine', condition_normalized: 'fine',
    signed: false, first_edition: false, dust_jacket: false,
    url: '', isbn,
  }
}

/**
 * A fixture large and ambiguous enough that randomized starts/perturbation
 * actually fire: 16 books, 8 sellers with overlapping catalogs and
 * near-equal prices (many near-tied local optima).
 */
function makeAmbiguousFixture() {
  const items = Array.from({ length: 16 }, (_, i) => makeItem(`i${i}`))
  const listingsByIsbn = new Map<string, Listing[]>(
    items.map((item, bi) => [
      item.isbn_preferred!,
      Array.from({ length: 8 }, (_, si) =>
        makeListing(`S${si}`, item.isbn_preferred!, 4 + ((bi * 3 + si * 7) % 11) * 0.5)),
    ])
  )
  return { items, listingsByIsbn }
}

describe('optimizer determinism', () => {
  it('localSearchStrategy returns the identical assignment for identical input', () => {
    const { items, listingsByIsbn } = makeAmbiguousFixture()
    const a = localSearchStrategy.solve(buildBookOptions(items, listingsByIsbn))
    const b = localSearchStrategy.solve(buildBookOptions(items, listingsByIsbn))
    expect(a.size).toBe(b.size)
    for (const [itemId, listing] of a) {
      expect(b.get(itemId)?.listing_id).toBe(listing.listing_id)
    }
  })

  it('optimize() returns byte-identical results for identical input', () => {
    const { items, listingsByIsbn } = makeAmbiguousFixture()
    const r1 = optimize(items, listingsByIsbn)
    const r2 = optimize(items, listingsByIsbn)
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2))
  })

  it('a changed input (one price) may change the seed without breaking determinism', () => {
    const { items, listingsByIsbn } = makeAmbiguousFixture()
    const perturbed = new Map(listingsByIsbn)
    const first = perturbed.get(items[0].isbn_preferred!)!
    perturbed.set(items[0].isbn_preferred!, [
      { ...first[0], price: first[0].price + 0.01 },
      ...first.slice(1),
    ])
    const r1 = optimize(items, perturbed)
    const r2 = optimize(items, perturbed)
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2))
  })
})
