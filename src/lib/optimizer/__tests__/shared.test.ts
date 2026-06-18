import { describe, it, expect } from 'vitest'
import { buildBookOptions, buildSellerCoverage, buildCandidatesByBook } from '../shared'
import type { CartItem, Condition, Listing } from '../../types'

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

// ── buildSellerCoverage ───────────────────────────────────────────────────────

describe('buildSellerCoverage', () => {
  it('counts how many distinct books each seller can supply', () => {
    const items = [makeItem({ id: 'i1' }), makeItem({ id: 'i2' }), makeItem({ id: 'i3' })]
    const listings = new Map([
      ['isbn-i1', [
        makeListing({ listing_id: 'l1', isbn: 'isbn-i1', price: 5, seller_id: 'H' }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-i1', price: 4, seller_id: 'A' }),
      ]],
      ['isbn-i2', [makeListing({ listing_id: 'l3', isbn: 'isbn-i2', price: 5, seller_id: 'H' })]],
      ['isbn-i3', [makeListing({ listing_id: 'l4', isbn: 'isbn-i3', price: 5, seller_id: 'H' })]],
    ])
    const coverage = buildSellerCoverage(buildBookOptions(items, listings))
    expect(coverage.get('H')).toBe(3)
    expect(coverage.get('A')).toBe(1)
  })

  it('does not double-count a seller listing the same book twice', () => {
    const items = [makeItem({ id: 'i1' })]
    const listings = new Map([
      ['isbn-i1', [
        makeListing({ listing_id: 'l1', isbn: 'isbn-i1', price: 5, seller_id: 'H' }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-i1', price: 8, seller_id: 'H' }),
      ]],
    ])
    const coverage = buildSellerCoverage(buildBookOptions(items, listings))
    expect(coverage.get('H')).toBe(1)
  })
})

// ── buildCandidatesByBook ─────────────────────────────────────────────────────

describe('buildCandidatesByBook', () => {
  it('includes a multi-book hub seller even when it is outside the per-book top-K', () => {
    const items = [makeItem({ id: 'i1' }), makeItem({ id: 'i2' })]
    // Each book has 3 cheap unique sellers ($1) plus hub H ($9) carrying both.
    const listings = new Map([
      ['isbn-i1', [
        makeListing({ listing_id: 'a', isbn: 'isbn-i1', price: 1, seller_id: 'u1a' }),
        makeListing({ listing_id: 'b', isbn: 'isbn-i1', price: 1, seller_id: 'u1b' }),
        makeListing({ listing_id: 'c', isbn: 'isbn-i1', price: 1, seller_id: 'u1c' }),
        makeListing({ listing_id: 'h1', isbn: 'isbn-i1', price: 9, seller_id: 'H' }),
      ]],
      ['isbn-i2', [
        makeListing({ listing_id: 'd', isbn: 'isbn-i2', price: 1, seller_id: 'u2a' }),
        makeListing({ listing_id: 'e', isbn: 'isbn-i2', price: 1, seller_id: 'u2b' }),
        makeListing({ listing_id: 'f', isbn: 'isbn-i2', price: 1, seller_id: 'u2c' }),
        makeListing({ listing_id: 'h2', isbn: 'isbn-i2', price: 9, seller_id: 'H' }),
      ]],
    ])
    const bookOptions = buildBookOptions(items, listings)
    // topK = 2 would normally drop H (it is the 4th-cheapest for each book).
    const candidates = buildCandidatesByBook(bookOptions, { topKPerBook: 2 })
    expect(candidates[0].has('H')).toBe(true)
    expect(candidates[1].has('H')).toBe(true)
  })

  it('keeps the cheapest listing for a seller carrying a book at multiple prices', () => {
    const items = [makeItem({ id: 'i1' })]
    const listings = new Map([
      ['isbn-i1', [
        makeListing({ listing_id: 'cheap', isbn: 'isbn-i1', price: 3, seller_id: 'A' }),
        makeListing({ listing_id: 'pricey', isbn: 'isbn-i1', price: 8, seller_id: 'A' }),
      ]],
    ])
    const candidates = buildCandidatesByBook(buildBookOptions(items, listings))
    expect(candidates[0].get('A')?.price).toBe(3)
  })
})

// ── buildBookOptions – condition filter ───────────────────────────────────────

describe('buildBookOptions — condition filter', () => {
  it('includes listings whose condition_normalized is in the conditions array', () => {
    const item = makeItem({ id: 'i1', conditions: ['new', 'fine'] })
    const listings = new Map([
      [`isbn-i1`, [
        makeListing({ listing_id: 'l1', isbn: 'isbn-i1', price: 5, condition_normalized: 'fine' }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-i1', price: 6, condition_normalized: 'new' }),
      ]],
    ])
    const [opt] = buildBookOptions([item], listings)
    expect(opt.listings).toHaveLength(2)
  })

  it('excludes listings whose condition_normalized is NOT in the conditions array', () => {
    const item = makeItem({ id: 'i1', conditions: ['new'] })
    const listings = new Map([
      [`isbn-i1`, [
        makeListing({ listing_id: 'l1', isbn: 'isbn-i1', price: 5, condition_normalized: 'good' }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-i1', price: 6, condition_normalized: 'new' }),
      ]],
    ])
    const [opt] = buildBookOptions([item], listings)
    expect(opt.listings).toHaveLength(1)
    expect(opt.listings[0].condition_normalized).toBe('new')
  })

  it('returns no listings when conditions array is empty', () => {
    const item = makeItem({ id: 'i1', conditions: [] })
    const listings = new Map([
      [`isbn-i1`, [makeListing({ listing_id: 'l1', isbn: 'isbn-i1', price: 5, condition_normalized: 'fine' })]],
    ])
    const [opt] = buildBookOptions([item], listings)
    expect(opt.listings).toHaveLength(0)
  })
})

// ── buildBookOptions – max_price filter ───────────────────────────────────────

describe('buildBookOptions — max_price filter', () => {
  it('excludes listings above max_price', () => {
    const item = makeItem({ id: 'i1', max_price: 10 })
    const listings = new Map([
      [`isbn-i1`, [
        makeListing({ listing_id: 'l1', isbn: 'isbn-i1', price: 15, condition_normalized: 'fine' }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-i1', price: 8, condition_normalized: 'fine' }),
      ]],
    ])
    const [opt] = buildBookOptions([item], listings)
    expect(opt.listings).toHaveLength(1)
    expect(opt.listings[0].listing_id).toBe('l2')
  })

  it('includes listing exactly at max_price', () => {
    const item = makeItem({ id: 'i1', max_price: 10 })
    const listings = new Map([
      [`isbn-i1`, [makeListing({ listing_id: 'l1', isbn: 'isbn-i1', price: 10, condition_normalized: 'fine' })]],
    ])
    const [opt] = buildBookOptions([item], listings)
    expect(opt.listings).toHaveLength(1)
  })

  it('includes all listings when max_price is null', () => {
    const item = makeItem({ id: 'i1', max_price: null })
    const listings = new Map([
      [`isbn-i1`, [
        makeListing({ listing_id: 'l1', isbn: 'isbn-i1', price: 100, condition_normalized: 'fine' }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-i1', price: 500, condition_normalized: 'fine' }),
      ]],
    ])
    const [opt] = buildBookOptions([item], listings)
    expect(opt.listings).toHaveLength(2)
  })
})

// ── buildBookOptions – signed_only filter ────────────────────────────────────

describe('buildBookOptions — signed_only filter', () => {
  it('filters to only signed listings when signed_only is true', () => {
    const item = makeItem({ id: 'i1', signed_only: true })
    const listings = new Map([
      [`isbn-i1`, [
        makeListing({ listing_id: 'l1', isbn: 'isbn-i1', price: 5, condition_normalized: 'fine', signed: false }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-i1', price: 8, condition_normalized: 'fine', signed: true }),
      ]],
    ])
    const [opt] = buildBookOptions([item], listings)
    expect(opt.listings).toHaveLength(1)
    expect(opt.listings[0].signed).toBe(true)
  })

  it('keeps non-signed listings when signed_only is false', () => {
    const item = makeItem({ id: 'i1', signed_only: false })
    const listings = new Map([
      [`isbn-i1`, [
        makeListing({ listing_id: 'l1', isbn: 'isbn-i1', price: 5, condition_normalized: 'fine', signed: false }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-i1', price: 8, condition_normalized: 'fine', signed: true }),
      ]],
    ])
    const [opt] = buildBookOptions([item], listings)
    // signed_only = false means "exclude signed" per the filter logic:
    // (item.signed_only ? l.signed : !l.signed) when signed_only is false → !l.signed
    expect(opt.listings).toHaveLength(1)
    expect(opt.listings[0].signed).toBe(false)
  })

  it('passes through all listings when signed_only is null', () => {
    const item = makeItem({ id: 'i1', signed_only: null })
    const listings = new Map([
      [`isbn-i1`, [
        makeListing({ listing_id: 'l1', isbn: 'isbn-i1', price: 5, condition_normalized: 'fine', signed: false }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-i1', price: 8, condition_normalized: 'fine', signed: true }),
      ]],
    ])
    const [opt] = buildBookOptions([item], listings)
    expect(opt.listings).toHaveLength(2)
  })
})

// ── buildBookOptions – first_edition_only filter ─────────────────────────────

describe('buildBookOptions — first_edition_only filter', () => {
  it('filters to only first-edition listings when first_edition_only is true', () => {
    const item = makeItem({ id: 'i1', first_edition_only: true })
    const listings = new Map([
      [`isbn-i1`, [
        makeListing({ listing_id: 'l1', isbn: 'isbn-i1', price: 5, condition_normalized: 'fine', first_edition: false }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-i1', price: 8, condition_normalized: 'fine', first_edition: true }),
      ]],
    ])
    const [opt] = buildBookOptions([item], listings)
    expect(opt.listings).toHaveLength(1)
    expect(opt.listings[0].first_edition).toBe(true)
  })

  it('passes through all listings when first_edition_only is null', () => {
    const item = makeItem({ id: 'i1', first_edition_only: null })
    const listings = new Map([
      [`isbn-i1`, [
        makeListing({ listing_id: 'l1', isbn: 'isbn-i1', price: 5, condition_normalized: 'fine', first_edition: false }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-i1', price: 8, condition_normalized: 'fine', first_edition: true }),
      ]],
    ])
    const [opt] = buildBookOptions([item], listings)
    expect(opt.listings).toHaveLength(2)
  })
})

// ── buildBookOptions – dust_jacket_only filter ───────────────────────────────

describe('buildBookOptions — dust_jacket_only filter', () => {
  it('filters to only dust-jacket listings when dust_jacket_only is true', () => {
    const item = makeItem({ id: 'i1', dust_jacket_only: true })
    const listings = new Map([
      [`isbn-i1`, [
        makeListing({ listing_id: 'l1', isbn: 'isbn-i1', price: 5, condition_normalized: 'fine', dust_jacket: false }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-i1', price: 8, condition_normalized: 'fine', dust_jacket: true }),
      ]],
    ])
    const [opt] = buildBookOptions([item], listings)
    expect(opt.listings).toHaveLength(1)
    expect(opt.listings[0].dust_jacket).toBe(true)
  })

  it('passes through all listings when dust_jacket_only is null', () => {
    const item = makeItem({ id: 'i1', dust_jacket_only: null })
    const listings = new Map([
      [`isbn-i1`, [
        makeListing({ listing_id: 'l1', isbn: 'isbn-i1', price: 5, condition_normalized: 'fine', dust_jacket: false }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-i1', price: 8, condition_normalized: 'fine', dust_jacket: true }),
      ]],
    ])
    const [opt] = buildBookOptions([item], listings)
    expect(opt.listings).toHaveLength(2)
  })
})

// ── buildBookOptions – combined filters ──────────────────────────────────────

describe('buildBookOptions — combined filters', () => {
  it('applies condition + max_price together', () => {
    const item = makeItem({ id: 'i1', conditions: ['fine'], max_price: 10 })
    const listings = new Map([
      [`isbn-i1`, [
        makeListing({ listing_id: 'l1', isbn: 'isbn-i1', price: 5, condition_normalized: 'fine' }),   // passes both
        makeListing({ listing_id: 'l2', isbn: 'isbn-i1', price: 15, condition_normalized: 'fine' }),  // fails price
        makeListing({ listing_id: 'l3', isbn: 'isbn-i1', price: 5, condition_normalized: 'good' }),   // fails condition
      ]],
    ])
    const [opt] = buildBookOptions([item], listings)
    expect(opt.listings).toHaveLength(1)
    expect(opt.listings[0].listing_id).toBe('l1')
  })

  it('applies signed_only + condition together', () => {
    const item = makeItem({ id: 'i1', conditions: ['new'], signed_only: true })
    const listings = new Map([
      [`isbn-i1`, [
        makeListing({ listing_id: 'l1', isbn: 'isbn-i1', price: 5, condition_normalized: 'new', signed: true }),
        makeListing({ listing_id: 'l2', isbn: 'isbn-i1', price: 5, condition_normalized: 'fine', signed: true }), // wrong condition
        makeListing({ listing_id: 'l3', isbn: 'isbn-i1', price: 5, condition_normalized: 'new', signed: false }), // not signed
      ]],
    ])
    const [opt] = buildBookOptions([item], listings)
    expect(opt.listings).toHaveLength(1)
    expect(opt.listings[0].listing_id).toBe('l1')
  })

  it('applies all three special filters together (signed + first_edition + dust_jacket)', () => {
    const item = makeItem({ id: 'i1', signed_only: true, first_edition_only: true, dust_jacket_only: true })
    const listings = new Map([
      [`isbn-i1`, [
        // passes all
        makeListing({ listing_id: 'l1', isbn: 'isbn-i1', price: 50, condition_normalized: 'fine', signed: true, first_edition: true, dust_jacket: true }),
        // missing dust_jacket
        makeListing({ listing_id: 'l2', isbn: 'isbn-i1', price: 30, condition_normalized: 'fine', signed: true, first_edition: true, dust_jacket: false }),
        // missing first_edition
        makeListing({ listing_id: 'l3', isbn: 'isbn-i1', price: 20, condition_normalized: 'fine', signed: true, first_edition: false, dust_jacket: true }),
      ]],
    ])
    const [opt] = buildBookOptions([item], listings)
    expect(opt.listings).toHaveLength(1)
    expect(opt.listings[0].listing_id).toBe('l1')
  })

  it('sorts output listings by price + shipping_base ascending', () => {
    const item = makeItem({ id: 'i1' })
    const listings = new Map([
      [`isbn-i1`, [
        makeListing({ listing_id: 'l1', isbn: 'isbn-i1', price: 10, condition_normalized: 'fine', shipping_base: 5 }),  // total 15
        makeListing({ listing_id: 'l2', isbn: 'isbn-i1', price: 8, condition_normalized: 'fine', shipping_base: 3.99 }), // total 11.99
        makeListing({ listing_id: 'l3', isbn: 'isbn-i1', price: 15, condition_normalized: 'fine', shipping_base: 0 }),   // total 15
      ]],
    ])
    const [opt] = buildBookOptions([item], listings)
    expect(opt.listings[0].listing_id).toBe('l2') // cheapest total first
  })
})

// ── buildBookOptions – ISBN handling ─────────────────────────────────────────

describe('buildBookOptions — ISBN handling', () => {
  it('includes listings from isbns_candidates when isbn_preferred has none', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-primary', isbns_candidates: ['isbn-alt'] })
    const listings = new Map([
      ['isbn-alt', [makeListing({ listing_id: 'l1', isbn: 'isbn-alt', price: 5, condition_normalized: 'fine' })]],
    ])
    const [opt] = buildBookOptions([item], listings)
    expect(opt.listings).toHaveLength(1)
  })

  it('returns no listings when neither isbn_preferred nor candidates have entries', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', isbns_candidates: null })
    const [opt] = buildBookOptions([item], new Map())
    expect(opt.listings).toHaveLength(0)
  })
})
