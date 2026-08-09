import { describe, it, expect } from 'vitest'
import { optimize } from '../index'
import { solveExact } from '../strategies/exact'
import { localSearchStrategy } from '../strategies/local-search'
import { buildBookOptions, computeTotalCost } from '../shared'
import type { Assignment, BookOption } from '../shared'
import { mulberry32 } from '../rng'
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

function makeListing(sellerId: string, isbn: string, price: number, perAdd = 1.99): Listing {
  return {
    listing_id: `${sellerId}-${isbn}`, seller_id: sellerId, seller_name: sellerId,
    price, shipping_base: 3.99, shipping_per_additional: perAdd,
    condition: 'Fine', condition_normalized: 'fine',
    signed: false, first_edition: false, dust_jacket: false,
    url: '', isbn,
  }
}

/** Exhaustive optimum over ALL seller offers (no candidate caps). */
function bruteForceOptimum(bookOptions: BookOption[]): number {
  const perBook = bookOptions.map((opt) => Array.from(opt.offers.values()))
  let best = Infinity
  const assignment: Assignment = new Map()
  function recurse(i: number): void {
    if (i === bookOptions.length) {
      best = Math.min(best, computeTotalCost(bookOptions, assignment))
      return
    }
    if (perBook[i].length === 0) { recurse(i + 1); return }
    for (const offer of perBook[i]) {
      assignment.set(bookOptions[i].item.id, offer)
      recurse(i + 1)
      assignment.delete(bookOptions[i].item.id)
    }
  }
  recurse(0)
  return best
}

// ── Regression: the consolidation-seller cart (rev-1 probe) ──────────────────
// 10 books, each with 6 distinct cheap single-book sellers plus seller "Z"
// carrying everything at 7th-cheapest price. Optimal is all-from-Z:
// 10 × $2 + (3.99 + 9 × 1.99) = $41.90. The pre-hardening exact strategy
// truncated Z out of every candidate list and returned $49.90.

function makeConsolidationFixture() {
  const items = Array.from({ length: 10 }, (_, i) => makeItem(`i${i}`))
  const listingsByIsbn = new Map<string, Listing[]>(
    items.map((item, bi) => [
      item.isbn_preferred!,
      [
        ...Array.from({ length: 6 }, (_, si) => makeListing(`solo-${bi}-${si}`, item.isbn_preferred!, 1 + 0.001 * si)),
        makeListing('Z', item.isbn_preferred!, 2),
      ],
    ])
  )
  return { items, listingsByIsbn }
}

describe('exact hardening — consolidation seller regression', () => {
  it('optimize() finds the all-from-Z optimum ($41.90)', () => {
    const { items, listingsByIsbn } = makeConsolidationFixture()
    const result = optimize(items, listingsByIsbn)
    expect(result.grand_total).toBeCloseTo(41.90, 2)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].seller_id).toBe('Z')
  })
})

// ── Regression: adversarial runtime (rev-1 probe) ────────────────────────────
// 12 books × 6 near-identical full-coverage sellers gave a weak lower bound
// and ~5s of unguarded branch-and-bound. The node cap + most-constrained-
// first ordering must keep this bounded.

describe('exact hardening — adversarial runtime', () => {
  it('12 books x 6 near-identical full-coverage sellers completes fast', () => {
    const items = Array.from({ length: 12 }, (_, i) => makeItem(`i${i}`))
    const listingsByIsbn = new Map<string, Listing[]>(
      items.map((item, bi) => [
        item.isbn_preferred!,
        Array.from({ length: 6 }, (_, si) =>
          makeListing(`S${si}`, item.isbn_preferred!, 5 + 0.01 * ((bi + si) % 6))),
      ])
    )
    const t0 = Date.now()
    const result = optimize(items, listingsByIsbn)
    const ms = Date.now() - t0
    expect(result.groups.length).toBeGreaterThan(0)
    expect(result.unassigned).toHaveLength(0)
    // Pre-hardening: ~5,000ms. Budgeted bound with CI headroom:
    expect(ms).toBeLessThan(1000)
  })
})

// ── Warm start guarantee ─────────────────────────────────────────────────────

describe('solveExact warm start', () => {
  it('returns the warm start unchanged when the node budget is exhausted immediately', () => {
    const { items, listingsByIsbn } = makeConsolidationFixture()
    const bookOptions = buildBookOptions(items, listingsByIsbn)
    const ls = localSearchStrategy.solve(bookOptions)
    const lsCost = computeTotalCost(bookOptions, ls)
    const capped = solveExact(bookOptions, { warmStart: ls, nodeBudget: 1 })
    expect(computeTotalCost(bookOptions, capped)).toBeLessThanOrEqual(lsCost + 1e-9)
  })

  it('never returns worse than the warm start at any budget', () => {
    const { items, listingsByIsbn } = makeConsolidationFixture()
    const bookOptions = buildBookOptions(items, listingsByIsbn)
    const ls = localSearchStrategy.solve(bookOptions)
    const lsCost = computeTotalCost(bookOptions, ls)
    for (const nodeBudget of [10, 100, 10_000, 500_000]) {
      const refined = solveExact(bookOptions, { warmStart: ls, nodeBudget })
      expect(computeTotalCost(bookOptions, refined)).toBeLessThanOrEqual(lsCost + 1e-9)
    }
  })
})

// ── Oracle: optimize() matches brute force on small random instances ─────────

describe('exact hardening — brute-force oracle', () => {
  it('optimize() equals the exhaustive optimum on 40 random small instances', () => {
    const rand = mulberry32(0xbeef)
    for (let trial = 0; trial < 40; trial++) {
      const nBooks = 2 + Math.floor(rand() * 5)      // 2..6
      const nSellers = 2 + Math.floor(rand() * 4)    // 2..5
      // Shipping model is a per-seller property (flat retailer vs incremental)
      const sellerPerAdd = Array.from({ length: nSellers }, () => (rand() < 0.3 ? 0 : 1.99))
      const items = Array.from({ length: nBooks }, (_, i) => makeItem(`t${trial}-i${i}`))
      const listingsByIsbn = new Map<string, Listing[]>()
      for (const item of items) {
        const ls: Listing[] = []
        for (let s = 0; s < nSellers; s++) {
          if (rand() < 0.75) { // not every seller carries every book
            ls.push(makeListing(`S${s}`, item.isbn_preferred!, 1 + Math.round(rand() * 1500) / 100, sellerPerAdd[s]))
          }
        }
        listingsByIsbn.set(item.isbn_preferred!, ls)
      }
      const bookOptions = buildBookOptions(items, listingsByIsbn)
      const expected = bruteForceOptimum(bookOptions)
      const result = optimize(items, listingsByIsbn)
      if (expected === Infinity) continue
      expect(result.grand_total).toBeCloseTo(expected, 6)
    }
  })
})
