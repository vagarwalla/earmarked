import { describe, it, expect } from 'vitest'
import { computeListings, findSuggestion, findEditionOptions, findCheaperSuggestion, findShippingRelaxSuggestions } from '../relaxation'
import type { CartItem, Condition, Edition, Listing } from '../types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<CartItem> & { id: string }): CartItem {
  return {
    cart_id: 'cart-1',
    title: 'Test Book',
    author: 'Test Author',
    work_id: '/works/OL1W',
    isbn_preferred: `isbn-${overrides.id}`,
    cover_url: null,
    format: 'any',
    conditions: ['new', 'fine', 'good', 'fair'] as Condition[],
    max_price: null,
    flexible: false,
    signed_only: false,
    first_edition_only: false,
    dust_jacket_only: false,
    quantity: 1,
    sort_order: 0,
    created_at: '2024-01-01T00:00:00Z',
    isbns_candidates: null,
    ...overrides,
  }
}

function makeListing(
  overrides: Partial<Listing> & { listing_id: string; isbn: string; price: number }
): Listing {
  return {
    seller_id: 'seller-1',
    seller_name: 'Test Seller',
    shipping_base: 3.99,
    shipping_per_additional: 1.99,
    condition: 'Fine',
    condition_normalized: 'fine',
    signed: false,
    first_edition: false,
    dust_jacket: false,
    url: `https://www.abebooks.com/products/isbn/${overrides.isbn}`,
    ...overrides,
  }
}

function makeByIsbn(entries: Array<[string, Listing[]]>): Record<string, Listing[]> {
  return Object.fromEntries(entries)
}

function makeEdition(overrides: Partial<Edition> & { isbn: string }): Edition {
  return {
    title: 'Test Book',
    publisher: 'Test Press',
    publish_year: 1999,
    format: 'any',
    cover_url: `https://covers.example/${overrides.isbn}.jpg`,
    cover_id: null,
    edition_name: null,
    pages: null,
    popularity_score: 10,
    ocaid: null,
    ...overrides,
  }
}

// ── computeListings ───────────────────────────────────────────────────────────

describe('computeListings', () => {
  it('returns listings matching the given conditions', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const byIsbn = makeByIsbn([
      ['isbn-1', [
        makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 5, condition_normalized: 'fine' }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-1', price: 4, condition_normalized: 'good' }),
      ]],
    ])
    const result = computeListings(item, byIsbn, ['fine'], null)
    expect(result).toHaveLength(1)
    expect(result[0].listing_id).toBe('l1')
  })

  it('returns empty array when no listings match the conditions', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const byIsbn = makeByIsbn([
      ['isbn-1', [makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 5, condition_normalized: 'fair' })]],
    ])
    const result = computeListings(item, byIsbn, ['new'], null)
    expect(result).toHaveLength(0)
  })

  it('filters out listings above maxPrice', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const byIsbn = makeByIsbn([
      ['isbn-1', [
        makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 25, condition_normalized: 'fine' }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-1', price: 10, condition_normalized: 'fine' }),
      ]],
    ])
    const result = computeListings(item, byIsbn, ['fine'], 15)
    expect(result).toHaveLength(1)
    expect(result[0].listing_id).toBe('l2')
  })

  it('includes listing exactly at maxPrice', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const byIsbn = makeByIsbn([
      ['isbn-1', [makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 10, condition_normalized: 'fine' })]],
    ])
    const result = computeListings(item, byIsbn, ['fine'], 10)
    expect(result).toHaveLength(1)
  })

  it('filters out non-signed listings when signed_only is true', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', signed_only: true })
    const byIsbn = makeByIsbn([
      ['isbn-1', [
        makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 5, condition_normalized: 'fine', signed: false }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-1', price: 8, condition_normalized: 'fine', signed: true }),
      ]],
    ])
    const result = computeListings(item, byIsbn, ['fine'], null)
    expect(result).toHaveLength(1)
    expect(result[0].listing_id).toBe('l2')
  })

  it('excludes signed listings when signed_only is false (types.ts tri-state: false = exclude)', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', signed_only: false })
    const byIsbn = makeByIsbn([
      ['isbn-1', [
        makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 5, condition_normalized: 'fine', signed: false }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-1', price: 8, condition_normalized: 'fine', signed: true }),
      ]],
    ])
    const result = computeListings(item, byIsbn, ['fine'], null)
    expect(result).toHaveLength(1)
    expect(result[0].listing_id).toBe('l1')
  })

  it('keeps all listings when signed_only is null (any)', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', signed_only: null })
    const byIsbn = makeByIsbn([
      ['isbn-1', [
        makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 5, condition_normalized: 'fine', signed: false }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-1', price: 8, condition_normalized: 'fine', signed: true }),
      ]],
    ])
    const result = computeListings(item, byIsbn, ['fine'], null)
    expect(result).toHaveLength(2)
  })

  it('matches optimizer semantics: relaxation and buildBookOptions qualify the same listings', () => {
    // Regression for the divergence where relaxation treated false as "any"
    // while the optimizer treated false as "exclude".
    const item = makeItem({
      id: 'i1', isbn_preferred: 'isbn-1',
      signed_only: false, first_edition_only: false, dust_jacket_only: false,
    })
    const signedListing = makeListing({ listing_id: 'l-signed', isbn: 'isbn-1', price: 3, condition_normalized: 'fine', signed: true })
    const plainListing = makeListing({ listing_id: 'l-plain', isbn: 'isbn-1', price: 5, condition_normalized: 'fine' })
    const byIsbn = makeByIsbn([['isbn-1', [signedListing, plainListing]]])
    const relaxed = computeListings(item, byIsbn, item.conditions, item.max_price)
    expect(relaxed.map((l) => l.listing_id)).toEqual(['l-plain'])
  })

  it('filters out non-first-edition listings when first_edition_only is true', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', first_edition_only: true })
    const byIsbn = makeByIsbn([
      ['isbn-1', [
        makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 5, condition_normalized: 'fine', first_edition: false }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-1', price: 8, condition_normalized: 'fine', first_edition: true }),
      ]],
    ])
    const result = computeListings(item, byIsbn, ['fine'], null)
    expect(result).toHaveLength(1)
    expect(result[0].listing_id).toBe('l2')
  })

  it('filters out listings without dust jacket when dust_jacket_only is true', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', dust_jacket_only: true })
    const byIsbn = makeByIsbn([
      ['isbn-1', [
        makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 5, condition_normalized: 'fine', dust_jacket: false }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-1', price: 8, condition_normalized: 'fine', dust_jacket: true }),
      ]],
    ])
    const result = computeListings(item, byIsbn, ['fine'], null)
    expect(result).toHaveLength(1)
    expect(result[0].listing_id).toBe('l2')
  })

  it('deduplicates listings with the same listing_id across ISBNs', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', isbns_candidates: ['isbn-2'] })
    const sharedListing = makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 5, condition_normalized: 'fine' })
    const byIsbn = makeByIsbn([
      ['isbn-1', [sharedListing]],
      ['isbn-2', [sharedListing]], // same listing_id
    ])
    const result = computeListings(item, byIsbn, ['fine'], null)
    expect(result).toHaveLength(1)
  })

  it('collects listings from both isbn_preferred and isbns_candidates', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', isbns_candidates: ['isbn-2'] })
    const byIsbn = makeByIsbn([
      ['isbn-1', [makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 5, condition_normalized: 'fine' })]],
      ['isbn-2', [makeListing({ listing_id: 'l2', isbn: 'isbn-2', price: 7, condition_normalized: 'fine' })]],
    ])
    const result = computeListings(item, byIsbn, ['fine'], null)
    expect(result).toHaveLength(2)
  })

  it('returns empty array when byIsbn is empty', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const result = computeListings(item, {}, ['fine', 'good'], null)
    expect(result).toHaveLength(0)
  })

  it('handles null isbn_preferred gracefully (uses only candidates)', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: null as unknown as string, isbns_candidates: ['isbn-2'] })
    const byIsbn = makeByIsbn([
      ['isbn-2', [makeListing({ listing_id: 'l1', isbn: 'isbn-2', price: 5, condition_normalized: 'fine' })]],
    ])
    const result = computeListings(item, byIsbn, ['fine'], null)
    expect(result).toHaveLength(1)
  })
})

// ── findSuggestion ────────────────────────────────────────────────────────────

describe('findSuggestion', () => {
  it('returns null when there are no raw listings at all', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const result = findSuggestion(item, {}, ['new'], null)
    expect(result).toBeNull()
  })

  it('returns a condition suggestion when relaxing conditions yields listings', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const byIsbn = makeByIsbn([
      ['isbn-1', [makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 5, condition_normalized: 'good' })]],
    ])
    // Item currently requires 'new' only, but listings are 'good'
    const result = findSuggestion(item, byIsbn, ['new'], null)
    expect(result).not.toBeNull()
    expect(result?.type).toBe('condition')
    if (result?.type === 'condition') {
      expect(result.newConditions).toContain('good')
      expect(result.addedLabels).toContain('Good')
      expect(result.count).toBeGreaterThan(0)
    }
  })

  it('expands conditions minimally — adds only as many as needed', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    // Only 'fine' listings exist — should add 'fine' only, not 'good' or 'fair'
    const byIsbn = makeByIsbn([
      ['isbn-1', [makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 5, condition_normalized: 'fine' })]],
    ])
    const result = findSuggestion(item, byIsbn, ['new'], null)
    expect(result?.type).toBe('condition')
    if (result?.type === 'condition') {
      expect(result.newConditions).toContain('fine')
      expect(result.addedLabels).toEqual(['Fine'])
    }
  })

  it('returns a max_price suggestion when only price cap prevents listings', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const byIsbn = makeByIsbn([
      ['isbn-1', [
        makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 50, condition_normalized: 'new' }),
      ]],
    ])
    // Conditions match ('new') but price cap blocks
    const result = findSuggestion(item, byIsbn, ['new'], 20)
    expect(result).not.toBeNull()
    expect(result?.type).toBe('max_price')
    if (result?.type === 'max_price') {
      expect(result.count).toBeGreaterThan(0)
    }
  })

  it('returns null when listing exists but signed_only blocks everything and no raw listing matches', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', signed_only: true })
    // All raw listings are non-signed — even CONDITION_ORDER + null price won't yield results
    const byIsbn = makeByIsbn([
      ['isbn-1', [makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 5, condition_normalized: 'new', signed: false })]],
    ])
    // anyRaw check uses CONDITION_ORDER + null price but still filters by signed_only
    const result = findSuggestion(item, byIsbn, ['new'], null)
    // No signed listings exist at all, so anyRaw is empty → null
    expect(result).toBeNull()
  })

  it('returns null when conditions already cover everything and max_price is null', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    // No listings exist at all
    const byIsbn = makeByIsbn([['isbn-1', []]])
    const result = findSuggestion(item, byIsbn, ['new', 'fine', 'good', 'fair'], null)
    expect(result).toBeNull()
  })

  it('returns condition suggestion before max_price suggestion when both would help', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const byIsbn = makeByIsbn([
      ['isbn-1', [
        // Under price cap but wrong condition
        makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 5, condition_normalized: 'good' }),
        // Over price cap with matching condition
        makeListing({ listing_id: 'l2', isbn: 'isbn-1', price: 50, condition_normalized: 'new' }),
      ]],
    ])
    const result = findSuggestion(item, byIsbn, ['new'], 20)
    // Condition expansion is tried first
    expect(result?.type).toBe('condition')
  })
})

// ── findEditionOptions ────────────────────────────────────────────────────────

describe('findEditionOptions', () => {
  it('finds an alternate cover that has listings under the current conditions', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['new', 'fine'] })
    const editions = [makeEdition({ isbn: 'isbn-alt' })]
    const byIsbn = makeByIsbn([
      ['isbn-1', []],
      ['isbn-alt', [
        makeListing({ listing_id: 'l1', isbn: 'isbn-alt', price: 9, condition_normalized: 'fine' }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-alt', price: 6, condition_normalized: 'new' }),
      ]],
    ])
    const options = findEditionOptions(item, editions, byIsbn, ['new', 'fine'], null)
    expect(options).toHaveLength(1)
    expect(options[0].isbn).toBe('isbn-alt')
    expect(options[0].count).toBe(2)
    expect(options[0].cheapest).toBe(6)
    expect(options[0].cheapestCondition).toBe('new')
    expect(options[0].addedLabels).toEqual([])       // no condition relaxation needed
    expect(options[0].newConditions).toEqual(['new', 'fine'])
  })

  it('relaxes conditions per edition when the cover only has worse copies', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['new'] })
    const editions = [makeEdition({ isbn: 'isbn-alt' })]
    const byIsbn = makeByIsbn([
      ['isbn-alt', [makeListing({ listing_id: 'l1', isbn: 'isbn-alt', price: 4, condition_normalized: 'good' })]],
    ])
    const options = findEditionOptions(item, editions, byIsbn, ['new'], null)
    expect(options).toHaveLength(1)
    expect(options[0].addedLabels).toEqual(['Fine', 'Good'])
    expect(options[0].newConditions).toEqual(['new', 'fine', 'good'])
  })

  it('prefers a cover needing no condition relaxation over a cheaper relaxed one', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['new', 'fine'] })
    const editions = [
      makeEdition({ isbn: 'isbn-cheap-relaxed' }),
      makeEdition({ isbn: 'isbn-strict' }),
    ]
    const byIsbn = makeByIsbn([
      ['isbn-cheap-relaxed', [makeListing({ listing_id: 'l1', isbn: 'isbn-cheap-relaxed', price: 2, condition_normalized: 'fair' })]],
      ['isbn-strict', [makeListing({ listing_id: 'l2', isbn: 'isbn-strict', price: 12, condition_normalized: 'fine' })]],
    ])
    const options = findEditionOptions(item, editions, byIsbn, ['new', 'fine'], null)
    expect(options.map((o) => o.isbn)).toEqual(['isbn-strict', 'isbn-cheap-relaxed'])
  })

  it('sorts equally-strict covers cheapest first', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['fine'] })
    const editions = [
      makeEdition({ isbn: 'isbn-pricey' }),
      makeEdition({ isbn: 'isbn-cheap' }),
    ]
    const byIsbn = makeByIsbn([
      ['isbn-pricey', [makeListing({ listing_id: 'l1', isbn: 'isbn-pricey', price: 15, condition_normalized: 'fine' })]],
      ['isbn-cheap', [makeListing({ listing_id: 'l2', isbn: 'isbn-cheap', price: 5, condition_normalized: 'fine' })]],
    ])
    const options = findEditionOptions(item, editions, byIsbn, ['fine'], null)
    expect(options.map((o) => o.isbn)).toEqual(['isbn-cheap', 'isbn-pricey'])
  })

  it('collapses editions that share a cover image, keeping the best one', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['fine'] })
    const sharedCover = 'https://covers.example/shared.jpg'
    const editions = [
      makeEdition({ isbn: 'isbn-a', cover_url: sharedCover }),
      makeEdition({ isbn: 'isbn-b', cover_url: sharedCover }),
      makeEdition({ isbn: 'isbn-c', cover_url: 'https://covers.example/other.jpg' }),
    ]
    const byIsbn = makeByIsbn([
      ['isbn-a', [makeListing({ listing_id: 'l1', isbn: 'isbn-a', price: 11, condition_normalized: 'fine' })]],
      ['isbn-b', [makeListing({ listing_id: 'l2', isbn: 'isbn-b', price: 7, condition_normalized: 'fine' })]],
      ['isbn-c', [makeListing({ listing_id: 'l3', isbn: 'isbn-c', price: 9, condition_normalized: 'fine' })]],
    ])
    const options = findEditionOptions(item, editions, byIsbn, ['fine'], null)
    expect(options.map((o) => o.isbn)).toEqual(['isbn-b', 'isbn-c'])
  })

  it('keeps coverless editions distinct instead of collapsing them together', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['fine'] })
    const editions = [
      makeEdition({ isbn: 'isbn-a', cover_url: null }),
      makeEdition({ isbn: 'isbn-b', cover_url: null }),
    ]
    const byIsbn = makeByIsbn([
      ['isbn-a', [makeListing({ listing_id: 'l1', isbn: 'isbn-a', price: 8, condition_normalized: 'fine' })]],
      ['isbn-b', [makeListing({ listing_id: 'l2', isbn: 'isbn-b', price: 9, condition_normalized: 'fine' })]],
    ])
    const options = findEditionOptions(item, editions, byIsbn, ['fine'], null)
    expect(options.map((o) => o.isbn)).toEqual(['isbn-a', 'isbn-b'])
  })

  it('respects the price cap and the item\'s other filters', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['fine'], signed_only: true })
    const editions = [
      makeEdition({ isbn: 'isbn-over-cap' }),
      makeEdition({ isbn: 'isbn-unsigned' }),
      makeEdition({ isbn: 'isbn-ok' }),
    ]
    const byIsbn = makeByIsbn([
      ['isbn-over-cap', [makeListing({ listing_id: 'l1', isbn: 'isbn-over-cap', price: 30, condition_normalized: 'fine', signed: true })]],
      ['isbn-unsigned', [makeListing({ listing_id: 'l2', isbn: 'isbn-unsigned', price: 5, condition_normalized: 'fine', signed: false })]],
      ['isbn-ok', [makeListing({ listing_id: 'l3', isbn: 'isbn-ok', price: 12, condition_normalized: 'fine', signed: true })]],
    ])
    const options = findEditionOptions(item, editions, byIsbn, ['fine'], 20)
    expect(options.map((o) => o.isbn)).toEqual(['isbn-ok'])
  })

  it('ignores the item\'s own listings — each edition is probed on its own', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['fine'] })
    const editions = [makeEdition({ isbn: 'isbn-empty' })]
    const byIsbn = makeByIsbn([
      ['isbn-1', [makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 5, condition_normalized: 'fine' })]],
      ['isbn-empty', []],
    ])
    expect(findEditionOptions(item, editions, byIsbn, ['fine'], null)).toEqual([])
  })

  it('caps the number of covers returned', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['fine'] })
    const editions = Array.from({ length: 5 }, (_, i) => makeEdition({ isbn: `isbn-${i}` }))
    const byIsbn = makeByIsbn(editions.map((e, i) => [
      e.isbn,
      [makeListing({ listing_id: `l${i}`, isbn: e.isbn, price: 5 + i, condition_normalized: 'fine' })],
    ]))
    expect(findEditionOptions(item, editions, byIsbn, ['fine'], null)).toHaveLength(3)
    expect(findEditionOptions(item, editions, byIsbn, ['fine'], null, 2)).toHaveLength(2)
  })

  it('returns nothing when there are no alternate editions to probe', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    expect(findEditionOptions(item, [], {}, ['fine'], null)).toEqual([])
  })
})

// ── findCheaperSuggestion ─────────────────────────────────────────────────────

describe('findCheaperSuggestion', () => {
  it('returns null when currentListings is empty', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const result = findCheaperSuggestion(item, {}, [], ['new'], null)
    expect(result).toBeNull()
  })

  it('returns null when cheapest listing is $20 or below', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const listings = [makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 20, condition_normalized: 'new' })]
    const result = findCheaperSuggestion(item, {}, listings, ['new'], null)
    expect(result).toBeNull()
  })

  it('returns null when all conditions are already included', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const listings = [makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 30, condition_normalized: 'new' })]
    const result = findCheaperSuggestion(item, {}, listings, ['new', 'fine', 'good', 'fair'], null)
    expect(result).toBeNull()
  })

  it('returns null when expanded conditions do not yield a cheaper price (difference <= $1)', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const byIsbn = makeByIsbn([
      ['isbn-1', [
        makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 25, condition_normalized: 'new' }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-1', price: 24.5, condition_normalized: 'fine' }),
      ]],
    ])
    const currentListings = [makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 25, condition_normalized: 'new' })]
    const result = findCheaperSuggestion(item, byIsbn, currentListings, ['new'], null)
    // $24.5 is not more than $1 cheaper than $25 → null
    expect(result).toBeNull()
  })

  it('returns a suggestion when expanded conditions yield a meaningfully cheaper listing', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const byIsbn = makeByIsbn([
      ['isbn-1', [
        makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 30, condition_normalized: 'new' }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-1', price: 10, condition_normalized: 'fine' }),
      ]],
    ])
    const currentListings = [makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 30, condition_normalized: 'new' })]
    const result = findCheaperSuggestion(item, byIsbn, currentListings, ['new'], null)
    expect(result).not.toBeNull()
    expect(result?.cheaperPrice).toBe(10)
    expect(result?.addedLabels).toContain('Fine')
    expect(result?.newConditions).toContain('fine')
  })

  it('picks the minimal relaxation — adds only as many conditions as needed', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const byIsbn = makeByIsbn([
      ['isbn-1', [
        makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 30, condition_normalized: 'new' }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-1', price: 10, condition_normalized: 'fine' }),
        makeListing({ listing_id: 'l3', isbn: 'isbn-1', price: 5, condition_normalized: 'good' }),
      ]],
    ])
    const currentListings = [makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 30, condition_normalized: 'new' })]
    const result = findCheaperSuggestion(item, byIsbn, currentListings, ['new'], null)
    // Should suggest adding 'fine' only (first step) since it already saves >$1
    expect(result?.addedLabels).toEqual(['Fine'])
    expect(result?.newConditions).toContain('fine')
    expect(result?.newConditions).not.toContain('good')
  })

  it('returns null when cheapest listing is exactly $20 (boundary)', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const listings = [makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 20, condition_normalized: 'new' })]
    const result = findCheaperSuggestion(item, {}, listings, ['new'], null)
    expect(result).toBeNull()
  })

  it('activates when cheapest listing is $20.01', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const byIsbn = makeByIsbn([
      ['isbn-1', [
        makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 20.01, condition_normalized: 'new' }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-1', price: 5, condition_normalized: 'fine' }),
      ]],
    ])
    const currentListings = [makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 20.01, condition_normalized: 'new' })]
    const result = findCheaperSuggestion(item, byIsbn, currentListings, ['new'], null)
    expect(result).not.toBeNull()
  })
})

// ── findShippingRelaxSuggestions ──────────────────────────────────────────────

describe('findShippingRelaxSuggestions', () => {
  it('returns suggestions when cheaper listings exist with relaxed conditions', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['new'] })
    const currentListing = makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 20, condition_normalized: 'new' })
    const byIsbn = makeByIsbn([
      ['isbn-1', [
        currentListing,
        makeListing({ listing_id: 'l2', isbn: 'isbn-1', price: 8, condition_normalized: 'good' }),
      ]],
    ])
    const result = findShippingRelaxSuggestions(
      [{ item, listing: currentListing }],
      byIsbn, {}, {},
    )
    expect(result).toHaveLength(1)
    expect(result[0].savings).toBeCloseTo(12)
    expect(result[0].relaxedPrice).toBe(8)
    expect(result[0].addedLabels).toContain('Fine')
  })

  it('returns empty array when no cheaper listings exist', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['new', 'fine', 'good', 'fair'] })
    const currentListing = makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 5, condition_normalized: 'new' })
    const byIsbn = makeByIsbn([
      ['isbn-1', [
        currentListing,
        makeListing({ listing_id: 'l2', isbn: 'isbn-1', price: 10, condition_normalized: 'fair' }),
      ]],
    ])
    const result = findShippingRelaxSuggestions(
      [{ item, listing: currentListing }],
      byIsbn, {}, {},
    )
    expect(result).toHaveLength(0)
  })

  it('skips books where conditions already include all levels', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['new', 'fine', 'good', 'fair'] })
    const currentListing = makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 20, condition_normalized: 'new' })
    const byIsbn = makeByIsbn([
      ['isbn-1', [
        currentListing,
        makeListing({ listing_id: 'l2', isbn: 'isbn-1', price: 5, condition_normalized: 'fair' }),
      ]],
    ])
    const result = findShippingRelaxSuggestions(
      [{ item, listing: currentListing }],
      byIsbn, {}, {},
    )
    expect(result).toHaveLength(0)
  })

  it('uses conditionOverrides when provided', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['new'] })
    const currentListing = makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 20, condition_normalized: 'new' })
    const byIsbn = makeByIsbn([
      ['isbn-1', [
        currentListing,
        makeListing({ listing_id: 'l2', isbn: 'isbn-1', price: 5, condition_normalized: 'good' }),
      ]],
    ])
    // Override already includes good, so no further relaxation yields >$1 savings
    const result = findShippingRelaxSuggestions(
      [{ item, listing: currentListing }],
      byIsbn,
      { i1: ['new', 'fine', 'good', 'fair'] },
      {},
    )
    expect(result).toHaveLength(0)
  })

  it('requires >$1 savings to suggest', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['new'] })
    const currentListing = makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 10, condition_normalized: 'new' })
    const byIsbn = makeByIsbn([
      ['isbn-1', [
        currentListing,
        makeListing({ listing_id: 'l2', isbn: 'isbn-1', price: 9.5, condition_normalized: 'fine' }),
      ]],
    ])
    const result = findShippingRelaxSuggestions(
      [{ item, listing: currentListing }],
      byIsbn, {}, {},
    )
    expect(result).toHaveLength(0)
  })

  it('sorts suggestions by savings descending', () => {
    const item1 = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['new'] })
    const item2 = makeItem({ id: 'i2', isbn_preferred: 'isbn-2', conditions: ['new'], title: 'Book 2' })
    const l1 = makeListing({ listing_id: 'l1', isbn: 'isbn-1', price: 15, condition_normalized: 'new' })
    const l2 = makeListing({ listing_id: 'l2', isbn: 'isbn-2', price: 30, condition_normalized: 'new' })
    const byIsbn = makeByIsbn([
      ['isbn-1', [l1, makeListing({ listing_id: 'l3', isbn: 'isbn-1', price: 5, condition_normalized: 'good' })]],
      ['isbn-2', [l2, makeListing({ listing_id: 'l4', isbn: 'isbn-2', price: 8, condition_normalized: 'good' })]],
    ])
    const result = findShippingRelaxSuggestions(
      [{ item: item1, listing: l1 }, { item: item2, listing: l2 }],
      byIsbn, {}, {},
    )
    expect(result).toHaveLength(2)
    expect(result[0].itemId).toBe('i2') // $22 savings > $10 savings
    expect(result[1].itemId).toBe('i1')
  })
})

// ── chooseAutoFix ─────────────────────────────────────────────────────────────

import { chooseAutoFix, describeAutoFix, type EditionOption } from '../relaxation'

function makeOption(overrides: Partial<EditionOption> & { isbn: string }): EditionOption {
  return {
    edition: makeEdition({ isbn: overrides.isbn, publisher: 'Penguin', publish_year: 2001 }),
    count: 1,
    cheapest: 5,
    cheapestCondition: 'good',
    newConditions: ['good'],
    addedLabels: [],
    sameCover: false,
    ...overrides,
  }
}

describe('chooseAutoFix', () => {
  const conditionFix = { type: 'condition' as const, newConditions: ['good', 'fair'] as Condition[], addedLabels: ['Fair'], count: 2 }

  it('takes a looser condition on the chosen cover before anything else', () => {
    const fix = chooseAutoFix({
      suggestion: conditionFix,
      nearMiss: null,
      coverOptions: [makeOption({ isbn: 'x', sameCover: true })],
      probeDone: false,
    })
    expect(fix).toMatchObject({ kind: 'condition', addedLabels: ['Fair'] })
  })

  it('takes the same cover under another ISBN as soon as it appears, at the reader\'s conditions', () => {
    const fix = chooseAutoFix({
      suggestion: null,
      nearMiss: null,
      coverOptions: [makeOption({ isbn: 'other', cheapest: 2 }), makeOption({ isbn: 'same', sameCover: true, cheapest: 9 })],
      probeDone: false,
    })
    expect(fix).toMatchObject({ kind: 'cover', option: { isbn: 'same' } })
  })

  it('waits for the sweep to finish before settling for a different cover', () => {
    const options = [makeOption({ isbn: 'other' })]
    expect(chooseAutoFix({ suggestion: null, nearMiss: null, coverOptions: options, probeDone: false })).toBeNull()
    expect(chooseAutoFix({ suggestion: null, nearMiss: null, coverOptions: options, probeDone: true }))
      .toMatchObject({ kind: 'cover', option: { isbn: 'other' } })
  })

  it('prefers a cover with no concession over one that needs a looser condition', () => {
    const fix = chooseAutoFix({
      suggestion: null,
      nearMiss: null,
      coverOptions: [makeOption({ isbn: 'loose', addedLabels: ['Fair'], cheapest: 1 }), makeOption({ isbn: 'clean', cheapest: 8 })],
      probeDone: true,
    })
    expect(fix).toMatchObject({ kind: 'cover', option: { isbn: 'clean' } })
  })

  it('lifts the price cap only when nothing else worked and the sweep is over', () => {
    const near = { cheapestBlocked: 12.5, delta: 1.5 }
    expect(chooseAutoFix({ suggestion: null, nearMiss: near, coverOptions: [], probeDone: false })).toBeNull()
    expect(chooseAutoFix({ suggestion: null, nearMiss: near, coverOptions: [], probeDone: true }))
      .toEqual({ kind: 'max_price', cheapest: 12.5 })
    expect(chooseAutoFix({ suggestion: { type: 'max_price', count: 3 }, nearMiss: null, coverOptions: [], probeDone: true }))
      .toEqual({ kind: 'max_price', cheapest: null })
  })

  it('gives up when there is nothing to apply', () => {
    expect(chooseAutoFix({ suggestion: null, nearMiss: null, coverOptions: [], probeDone: true })).toBeNull()
  })

  it('describes each fix in a sentence fragment', () => {
    expect(describeAutoFix({ kind: 'condition', newConditions: ['good', 'fair'], addedLabels: ['Fair'], count: 2 }))
      .toBe('accepted Fair condition')
    expect(describeAutoFix({ kind: 'cover', option: makeOption({ isbn: 's', sameCover: true }) }))
      .toBe('used the same cover under another ISBN (Penguin 2001)')
    expect(describeAutoFix({ kind: 'cover', option: makeOption({ isbn: 'd', addedLabels: ['Fair'] }) }))
      .toBe('used a different cover (Penguin 2001), accepting Fair')
    expect(describeAutoFix({ kind: 'max_price', cheapest: 12.5 })).toBe('lifted the price cap (cheapest copy $12.50)')
  })
})

describe('findEditionOptions — same-cover ranking', () => {
  it('puts editions sharing the chosen artwork first even when pricier', () => {
    const item = makeItem({ id: 'a', conditions: ['good'] })
    const editions = [
      makeEdition({ isbn: 'cheap', cover_url: 'https://c/1.jpg' }),
      makeEdition({ isbn: 'same', cover_url: 'https://c/2.jpg' }),
    ]
    const byIsbn = {
      cheap: [makeListing({ listing_id: 'l1', isbn: 'cheap', price: 3, condition: 'Good', condition_normalized: 'good' })],
      same: [makeListing({ listing_id: 'l2', isbn: 'same', price: 9, condition: 'Good', condition_normalized: 'good' })],
    }
    const options = findEditionOptions(item, editions, byIsbn, ['good'], null, 3, new Set(['same']))
    expect(options.map((o) => o.isbn)).toEqual(['same', 'cheap'])
    expect(options[0].sameCover).toBe(true)
  })
})
