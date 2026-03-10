import { describe, it, expect } from 'vitest'
import { optimize } from '../optimizer'
import {
  greedyStrategy,
  localSearchStrategy,
  exactStrategy,
} from '../optimizer/index'
import { computeTotalCost, buildBookOptions } from '../optimizer/shared'
import type { CartItem, Condition, Listing } from '../types'

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
    // Accept all four condition levels by default so most tests are unaffected
    conditions: ['new', 'like_new', 'very_good', 'good'] as Condition[],
    max_price: null,
    flexible: false,
    quantity: 1,
    sort_order: 0,
    created_at: '2024-01-01T00:00:00Z',
    isbns_candidates: null,
    ...overrides,
  }
}

function makeListing(
  overrides: Partial<Listing> & { seller_id: string; isbn: string; price: number }
): Listing {
  return {
    listing_id: `${overrides.seller_id}-${overrides.isbn}`,
    seller_name: `Seller ${overrides.seller_id}`,
    shipping_base: 3.99,
    shipping_per_additional: 1.99,
    condition: 'Like New',
    condition_normalized: 'like_new',
    url: `https://www.abebooks.com/products/isbn/${overrides.isbn}`,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('optimize', () => {
  it('returns empty result for an empty cart', () => {
    const result = optimize([], new Map())
    expect(result.groups).toHaveLength(0)
    expect(result.grand_total).toBe(0)
    expect(result.naive_total).toBe(0)
    expect(result.savings).toBe(0)
  })

  it('handles a single book with a single listing', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const listing = makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 5.00 })

    const result = optimize([item], new Map([['isbn-1', [listing]]]))

    expect(result.groups).toHaveLength(1)
    const group = result.groups[0]
    expect(group.seller_id).toBe('A')
    expect(group.books_subtotal).toBe(5.00)
    expect(group.shipping).toBeCloseTo(3.99)
    expect(group.group_total).toBeCloseTo(8.99)
    expect(result.grand_total).toBeCloseTo(8.99)
  })

  it('groups two books from the same seller into one group', () => {
    const item1 = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', title: 'Book A' })
    const item2 = makeItem({ id: 'i2', isbn_preferred: 'isbn-2', title: 'Book B' })

    const listings = new Map([
      ['isbn-1', [makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 5.00 })]],
      ['isbn-2', [makeListing({ seller_id: 'A', isbn: 'isbn-2', price: 6.00 })]],
    ])

    const result = optimize([item1, item2], listings)

    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].seller_id).toBe('A')
    expect(result.groups[0].assignments).toHaveLength(2)
    // shipping: 3.99 + 1.99 = 5.98
    expect(result.groups[0].shipping).toBeCloseTo(5.98)
  })

  it('splits books across two sellers when no overlap exists', () => {
    const item1 = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const item2 = makeItem({ id: 'i2', isbn_preferred: 'isbn-2' })

    const listings = new Map([
      ['isbn-1', [makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 5.00 })]],
      ['isbn-2', [makeListing({ seller_id: 'B', isbn: 'isbn-2', price: 6.00 })]],
    ])

    const result = optimize([item1, item2], listings)

    expect(result.groups).toHaveLength(2)
    // Both groups get full $3.99 shipping
    expect(result.grand_total).toBeCloseTo(5.00 + 3.99 + 6.00 + 3.99)
  })

  it('finds the minimum cost when one seller has all books and another is cheaper for one', () => {
    const items = [
      makeItem({ id: 'i1', isbn_preferred: 'isbn-1' }),
      makeItem({ id: 'i2', isbn_preferred: 'isbn-2' }),
      makeItem({ id: 'i3', isbn_preferred: 'isbn-3' }),
    ]

    // Seller A has all 3 books; Seller B only has isbn-1 at a lower price.
    // Both assignments are equally optimal ($25.97):
    //   A(all 3): (5+6+7) + shipping(3)          = 18 + 7.97 = $25.97
    //   B(isbn-1) + A(isbn-2,isbn-3): 6.99 + 18.98 = $25.97
    const listings = new Map([
      ['isbn-1', [
        makeListing({ seller_id: 'B', isbn: 'isbn-1', price: 3.00 }),
        makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 5.00 }),
      ]],
      ['isbn-2', [makeListing({ seller_id: 'A', isbn: 'isbn-2', price: 6.00 })]],
      ['isbn-3', [makeListing({ seller_id: 'A', isbn: 'isbn-3', price: 7.00 })]],
    ])

    const result = optimize(items, listings)
    expect(result.grand_total).toBeCloseTo(25.97, 1)
  })

  it('excludes listings that do not match the required conditions', () => {
    // Item only accepts very_good condition
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['very_good'] })

    const listings = new Map([
      ['isbn-1', [
        // Too low
        makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 3.00, condition: 'Good', condition_normalized: 'good' }),
        // Meets condition
        makeListing({ seller_id: 'B', isbn: 'isbn-1', price: 7.00, condition: 'Very Good', condition_normalized: 'very_good' }),
      ]],
    ])

    const result = optimize([item], listings)

    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].seller_id).toBe('B')
    expect(result.groups[0].books_subtotal).toBe(7.00)
  })

  it('accepts any of several conditions when multiple are specified', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['like_new', 'very_good'] })

    const listings = new Map([
      ['isbn-1', [
        makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 3.00, condition_normalized: 'good' }),      // rejected
        makeListing({ seller_id: 'B', isbn: 'isbn-1', price: 5.00, condition_normalized: 'very_good' }), // accepted
        makeListing({ seller_id: 'C', isbn: 'isbn-1', price: 7.00, condition_normalized: 'like_new' }),  // accepted
      ]],
    ])

    const result = optimize([item], listings)

    // Should pick the cheaper of the two acceptable listings
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].seller_id).toBe('B')
  })

  it('excludes all listings when conditions array is empty', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: [] })
    const listings = new Map([
      ['isbn-1', [makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 5.00 })]],
    ])
    const result = optimize([item], listings)
    expect(result.groups).toHaveLength(0)
  })

  it('excludes listings above max_price', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', max_price: 6.00 })

    const listings = new Map([
      ['isbn-1', [
        makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 9.99 }), // too expensive
        makeListing({ seller_id: 'B', isbn: 'isbn-1', price: 5.00 }), // within budget
      ]],
    ])

    const result = optimize([item], listings)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].seller_id).toBe('B')
  })

  it('includes listing exactly at max_price', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', max_price: 5.00 })
    const listing = makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 5.00 })
    const result = optimize([item], new Map([['isbn-1', [listing]]]))
    expect(result.groups).toHaveLength(1)
  })

  it('uses isbns_candidates to find listings when isbn_preferred has none', () => {
    const item = makeItem({
      id: 'i1',
      isbn_preferred: 'isbn-primary',
      isbns_candidates: ['isbn-alt1', 'isbn-alt2'],
    })

    // Only the candidate ISBNs have listings
    const listings = new Map([
      ['isbn-alt1', [makeListing({ seller_id: 'A', isbn: 'isbn-alt1', price: 8.00 })]],
      ['isbn-alt2', [makeListing({ seller_id: 'B', isbn: 'isbn-alt2', price: 6.00 })]],
    ])

    const result = optimize([item], listings)
    expect(result.groups).toHaveLength(1)
    // Should pick the cheapest (B at $6)
    expect(result.groups[0].seller_id).toBe('B')
  })

  it('respects quantity > 1 in subtotal and shipping', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', quantity: 3 })
    const listing = makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 5.00 })

    const result = optimize([item], new Map([['isbn-1', [listing]]]))

    expect(result.groups[0].books_subtotal).toBe(15.00) // 5 × 3
    // shipping: 3.99 + 2 × 1.99 = 7.97
    expect(result.groups[0].shipping).toBeCloseTo(7.97)
  })

  it('produces no group for a book with no isbn', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: null as unknown as string, isbns_candidates: null })
    const result = optimize([item], new Map())
    expect(result.groups).toHaveLength(0)
  })

  it('produces no group for a book with an empty listings array', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const result = optimize([item], new Map([['isbn-1', []]]))
    expect(result.groups).toHaveLength(0)
  })

  it('produces no group for a book where all listings fail the condition filter', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['new'] })
    const listings = new Map([
      ['isbn-1', [makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 5.00, condition_normalized: 'good' })]],
    ])
    const result = optimize([item], listings)
    expect(result.groups).toHaveLength(0)
  })

  it('produces no group for a book where all listings exceed max_price', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', max_price: 3.00 })
    const listings = new Map([
      ['isbn-1', [makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 5.00 })]],
    ])
    const result = optimize([item], listings)
    expect(result.groups).toHaveLength(0)
  })

  it('calculates savings correctly versus naive per-book ordering', () => {
    const item1 = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const item2 = makeItem({ id: 'i2', isbn_preferred: 'isbn-2' })

    const listings = new Map([
      ['isbn-1', [makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 5.00 })]],
      ['isbn-2', [makeListing({ seller_id: 'A', isbn: 'isbn-2', price: 6.00 })]],
    ])

    const result = optimize([item1, item2], listings)

    // Naive: (5 + 3.99) + (6 + 3.99) = 18.98
    expect(result.naive_total).toBeCloseTo(18.98)
    // Optimised: 5 + 6 + 3.99 + 1.99 = 16.98
    expect(result.grand_total).toBeCloseTo(16.98)
    expect(result.savings).toBeCloseTo(2.00)
  })

  it('savings is never negative', () => {
    // Single book — naive and optimised are the same
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const listing = makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 5.00 })
    const result = optimize([item], new Map([['isbn-1', [listing]]]))
    expect(result.savings).toBeGreaterThanOrEqual(0)
  })

  // ── Condition-filtering regression tests ─────────────────────────────────────
  // These cover the bug where lower-condition listings were shown even when the
  // user's condition settings required "new" or "like new" only.

  it('does not assign a very_good listing when conditions = [new, like_new]', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['new', 'like_new'] })
    const listings = new Map([
      ['isbn-1', [
        makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 3.00, condition: 'Very Good', condition_normalized: 'very_good' }),
        makeListing({ seller_id: 'B', isbn: 'isbn-1', price: 5.00, condition: 'Like New',  condition_normalized: 'like_new' }),
      ]],
    ])
    const result = optimize([item], listings)
    expect(result.groups).toHaveLength(1)
    // Must pick the like_new listing, not the cheaper very_good one
    expect(result.groups[0].seller_id).toBe('B')
    expect(result.groups[0].assignments[0].listing.condition_normalized).toBe('like_new')
  })

  it('does not assign a good listing when conditions = [new, like_new]', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['new', 'like_new'] })
    const listings = new Map([
      ['isbn-1', [
        makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 2.00, condition: 'Good',     condition_normalized: 'good' }),
        makeListing({ seller_id: 'B', isbn: 'isbn-1', price: 9.00, condition: 'New',      condition_normalized: 'new' }),
      ]],
    ])
    const result = optimize([item], listings)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].assignments[0].listing.condition_normalized).toBe('new')
  })

  it('does not assign a good or very_good listing when conditions = [new]', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['new'] })
    const listings = new Map([
      ['isbn-1', [
        makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 1.00, condition_normalized: 'good' }),
        makeListing({ seller_id: 'B', isbn: 'isbn-1', price: 2.00, condition_normalized: 'very_good' }),
        makeListing({ seller_id: 'C', isbn: 'isbn-1', price: 3.00, condition_normalized: 'like_new' }),
        makeListing({ seller_id: 'D', isbn: 'isbn-1', price: 4.00, condition_normalized: 'new' }),
      ]],
    ])
    const result = optimize([item], listings)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].assignments[0].listing.condition_normalized).toBe('new')
  })

  it('does not assign a good listing when conditions = [like_new]', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['like_new'] })
    const listings = new Map([
      ['isbn-1', [
        makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 1.00, condition_normalized: 'good' }),
        makeListing({ seller_id: 'B', isbn: 'isbn-1', price: 2.00, condition_normalized: 'very_good' }),
        makeListing({ seller_id: 'C', isbn: 'isbn-1', price: 9.00, condition_normalized: 'like_new' }),
      ]],
    ])
    const result = optimize([item], listings)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].assignments[0].listing.condition_normalized).toBe('like_new')
  })

  it('does not assign a good listing when conditions = [very_good]', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['very_good'] })
    const listings = new Map([
      ['isbn-1', [
        makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 1.00, condition_normalized: 'good' }),
        makeListing({ seller_id: 'B', isbn: 'isbn-1', price: 8.00, condition_normalized: 'very_good' }),
      ]],
    ])
    const result = optimize([item], listings)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].assignments[0].listing.condition_normalized).toBe('very_good')
  })

  it('every assigned listing has a condition_normalized that is in the item conditions array', () => {
    // Multi-item cart — ensures no condition leak across any assignment
    const items = [
      makeItem({ id: 'i1', isbn_preferred: 'isbn-1', conditions: ['new', 'like_new'] }),
      makeItem({ id: 'i2', isbn_preferred: 'isbn-2', conditions: ['very_good'] }),
      makeItem({ id: 'i3', isbn_preferred: 'isbn-3', conditions: ['good'] }),
    ]
    const listings = new Map([
      ['isbn-1', [
        makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 3.00, condition_normalized: 'good' }),
        makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 5.00, condition_normalized: 'like_new' }),
      ]],
      ['isbn-2', [
        makeListing({ seller_id: 'A', isbn: 'isbn-2', price: 4.00, condition_normalized: 'good' }),
        makeListing({ seller_id: 'B', isbn: 'isbn-2', price: 6.00, condition_normalized: 'very_good' }),
      ]],
      ['isbn-3', [
        makeListing({ seller_id: 'A', isbn: 'isbn-3', price: 2.00, condition_normalized: 'good' }),
        makeListing({ seller_id: 'B', isbn: 'isbn-3', price: 7.00, condition_normalized: 'very_good' }),
      ]],
    ])
    const result = optimize(items, listings)
    for (const group of result.groups) {
      for (const { item, listing } of group.assignments) {
        expect(item.conditions).toContain(listing.condition_normalized)
      }
    }
  })

  it('groups are sorted by number of assignments descending', () => {
    const items = [
      makeItem({ id: 'i1', isbn_preferred: 'isbn-1' }),
      makeItem({ id: 'i2', isbn_preferred: 'isbn-2' }),
      makeItem({ id: 'i3', isbn_preferred: 'isbn-3' }),
    ]

    const listings = new Map([
      ['isbn-1', [makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 5.00 })]],
      ['isbn-2', [makeListing({ seller_id: 'A', isbn: 'isbn-2', price: 5.00 })]],
      ['isbn-3', [makeListing({ seller_id: 'B', isbn: 'isbn-3', price: 5.00 })]],
    ])

    const result = optimize(items, listings)

    expect(result.groups[0].seller_id).toBe('A')
    expect(result.groups[0].assignments.length).toBeGreaterThanOrEqual(
      result.groups[result.groups.length - 1].assignments.length
    )
  })

  it('handles a large cart (10 books) without errors', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeItem({ id: `i${i}`, isbn_preferred: `isbn-${i}` })
    )
    const listings = new Map(
      items.map((item) => [
        item.isbn_preferred!,
        [makeListing({ seller_id: 'A', isbn: item.isbn_preferred!, price: 5.00 })],
      ])
    )

    const result = optimize(items, listings)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].assignments).toHaveLength(10)
    // shipping: 3.99 + 9 × 1.99 = 21.90
    expect(result.groups[0].shipping).toBeCloseTo(21.9)
  })
})

// ── Strategy tests ─────────────────────────────────────────────────────────────
//
// Scenario where greedy is suboptimal:
//
//   Book 1: Seller A=$5, Seller B=$3
//   Book 2: Seller A=$6 only
//   Book 3: Seller A=$7 only
//   Book 4: Seller B=$1 only
//
// Greedy sees A has 3 books (books 1,2,3) and assigns them to A, then B gets
// book 4 as fallback:
//   A: (5+6+7) + shipping(3) = 18 + 7.97 = $25.97
//   B: 1 + shipping(1)       = 1  + 3.99 = $4.99
//   Total: $30.96
//
// Optimal splits differently — B takes books 1 and 4 (cheapest for both),
// A takes books 2 and 3:
//   B: (3+1) + shipping(2)  = 4  + 5.98 = $9.98
//   A: (6+7) + shipping(2)  = 13 + 5.98 = $18.98
//   Total: $28.96  (saves $2 vs greedy)

function makeGreedySuboptimalFixture() {
  const items = [
    makeItem({ id: 'i1', isbn_preferred: 'isbn-1', title: 'Book 1' }),
    makeItem({ id: 'i2', isbn_preferred: 'isbn-2', title: 'Book 2' }),
    makeItem({ id: 'i3', isbn_preferred: 'isbn-3', title: 'Book 3' }),
    makeItem({ id: 'i4', isbn_preferred: 'isbn-4', title: 'Book 4' }),
  ]
  const listingsByIsbn = new Map([
    ['isbn-1', [
      makeListing({ seller_id: 'B', isbn: 'isbn-1', price: 3.00 }),
      makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 5.00 }),
    ]],
    ['isbn-2', [makeListing({ seller_id: 'A', isbn: 'isbn-2', price: 6.00 })]],
    ['isbn-3', [makeListing({ seller_id: 'A', isbn: 'isbn-3', price: 7.00 })]],
    ['isbn-4', [makeListing({ seller_id: 'B', isbn: 'isbn-4', price: 1.00 })]],
  ])
  return { items, listingsByIsbn }
}

describe('greedyStrategy', () => {
  it('produces a suboptimal result on the known difficult fixture', () => {
    const { items, listingsByIsbn } = makeGreedySuboptimalFixture()
    const bookOptions = buildBookOptions(items, listingsByIsbn)
    const assignment = greedyStrategy.solve(bookOptions)
    const cost = computeTotalCost(bookOptions, assignment)
    // Greedy gets $30.96; verify it does NOT find the $28.96 optimum
    expect(cost).toBeGreaterThan(29)
  })
})

describe('exactStrategy', () => {
  it('finds the true optimum on the greedy-suboptimal fixture', () => {
    const { items, listingsByIsbn } = makeGreedySuboptimalFixture()
    const bookOptions = buildBookOptions(items, listingsByIsbn)
    const assignment = exactStrategy.solve(bookOptions)
    const cost = computeTotalCost(bookOptions, assignment)
    // Optimal: B(book1+book4)=$9.98, A(book2+book3)=$18.98 → $28.96
    expect(cost).toBeCloseTo(28.96, 1)
  })

  it('assigns book 1 to B and book 4 to B in the optimal solution', () => {
    const { items, listingsByIsbn } = makeGreedySuboptimalFixture()
    const bookOptions = buildBookOptions(items, listingsByIsbn)
    const assignment = exactStrategy.solve(bookOptions)
    expect(assignment.get('i1')?.seller_id).toBe('B')
    expect(assignment.get('i4')?.seller_id).toBe('B')
  })

  it('returns empty assignment when no listings exist', () => {
    const items = [makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })]
    const bookOptions = buildBookOptions(items, new Map())
    const assignment = exactStrategy.solve(bookOptions)
    expect(assignment.size).toBe(0)
  })

  it('handles a cart of 10 books within reasonable time', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeItem({ id: `i${i}`, isbn_preferred: `isbn-${i}` })
    )
    const listingsByIsbn = new Map(
      items.map((item) => [
        item.isbn_preferred!,
        [makeListing({ seller_id: 'A', isbn: item.isbn_preferred!, price: 5.00 })],
      ])
    )
    const bookOptions = buildBookOptions(items, listingsByIsbn)
    const start = Date.now()
    const assignment = exactStrategy.solve(bookOptions)
    expect(Date.now() - start).toBeLessThan(500) // must finish in < 500ms
    expect(assignment.size).toBe(10)
  })
})

describe('localSearchStrategy', () => {
  it('finds the optimum (or better) on the greedy-suboptimal fixture', () => {
    const { items, listingsByIsbn } = makeGreedySuboptimalFixture()
    const bookOptions = buildBookOptions(items, listingsByIsbn)
    const greedyCost = computeTotalCost(bookOptions, greedyStrategy.solve(bookOptions))
    const lsCost = computeTotalCost(bookOptions, localSearchStrategy.solve(bookOptions))
    // Local search must beat greedy on this fixture
    expect(lsCost).toBeLessThan(greedyCost)
    // And should reach the optimum
    expect(lsCost).toBeCloseTo(28.96, 1)
  })

  it('never produces a worse result than greedy', () => {
    // Run both strategies on several random-ish fixtures and verify LS ≤ greedy
    const fixtures = [
      // Single seller — both strategies should tie
      {
        items: [makeItem({ id: 'i1', isbn_preferred: 'isbn-1' }), makeItem({ id: 'i2', isbn_preferred: 'isbn-2' })],
        listingsByIsbn: new Map([
          ['isbn-1', [makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 5 })]],
          ['isbn-2', [makeListing({ seller_id: 'A', isbn: 'isbn-2', price: 6 })]],
        ]),
      },
      // Two sellers with equal coverage — both should assign to cheaper
      {
        items: [makeItem({ id: 'i1', isbn_preferred: 'isbn-1' }), makeItem({ id: 'i2', isbn_preferred: 'isbn-2' })],
        listingsByIsbn: new Map([
          ['isbn-1', [makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 4 }), makeListing({ seller_id: 'B', isbn: 'isbn-1', price: 5 })]],
          ['isbn-2', [makeListing({ seller_id: 'A', isbn: 'isbn-2', price: 3 }), makeListing({ seller_id: 'B', isbn: 'isbn-2', price: 2 })]],
        ]),
      },
    ]

    for (const { items, listingsByIsbn } of fixtures) {
      const bookOptions = buildBookOptions(items, listingsByIsbn)
      const greedyCost = computeTotalCost(bookOptions, greedyStrategy.solve(bookOptions))
      const lsCost = computeTotalCost(bookOptions, localSearchStrategy.solve(bookOptions))
      expect(lsCost).toBeLessThanOrEqual(greedyCost + 0.001)
    }
  })
})

describe('optimize() with explicit strategy', () => {
  it('accepts a strategy override', () => {
    const item = makeItem({ id: 'i1', isbn_preferred: 'isbn-1' })
    const listing = makeListing({ seller_id: 'A', isbn: 'isbn-1', price: 5 })
    const result = optimize([item], new Map([['isbn-1', [listing]]]), greedyStrategy)
    expect(result.groups).toHaveLength(1)
    expect(result.grand_total).toBeCloseTo(8.99)
  })
})
