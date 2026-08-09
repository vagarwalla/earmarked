import { describe, it, expect } from 'vitest'
import { optimize } from '../index'
import { greedyStrategy } from '../strategies/greedy'
import { buildBookOptions, computeTotalCost, listingQualifies } from '../shared'
import type { Assignment } from '../shared'
import { mulberry32 } from '../rng'
import type { CartItem, Condition, Listing } from '../../types'

// ── Seeded random instance generator ─────────────────────────────────────────

const ALL_CONDITIONS: Condition[] = ['new', 'fine', 'good', 'fair']

type Instance = { items: CartItem[]; listingsByIsbn: Map<string, Listing[]> }

function generateInstance(seed: number, maxBooks = 20): Instance {
  const rand = mulberry32(seed)
  const nBooks = 1 + Math.floor(rand() * maxBooks)
  const nSellers = 2 + Math.floor(rand() * 10)

  // Seller economics are per-seller: retailers are flat-rate with stock
  const sellers = Array.from({ length: nSellers }, (_, s) => {
    const retailer = s === 0 && rand() < 0.5
    return {
      id: retailer ? 'thriftbooks' : `abe-${s}`,
      perAdd: retailer ? 0 : 1.99,
      copies: retailer ? 1 : 1 + Math.floor(rand() * 3), // marketplace sellers list 1–3 copies
    }
  })

  const items: CartItem[] = []
  const listingsByIsbn = new Map<string, Listing[]>()
  for (let b = 0; b < nBooks; b++) {
    const conditions = ALL_CONDITIONS.filter(() => rand() < 0.8)
    const item: CartItem = {
      id: `i${b}`, cart_id: 'c', title: `Book ${b}`, author: null, work_id: null,
      isbn_preferred: `isbn-${b}`, cover_url: null, format: 'any',
      conditions: conditions.length > 0 ? conditions : ['good'],
      max_price: rand() < 0.2 ? 5 + rand() * 15 : null,
      flexible: false,
      signed_only: rand() < 0.1 ? rand() < 0.5 : null,
      first_edition_only: null, dust_jacket_only: null,
      quantity: rand() < 0.15 ? 2 : 1,
      sort_order: b, created_at: '', isbns_candidates: null,
    }
    items.push(item)

    const ls: Listing[] = []
    for (const seller of sellers) {
      if (rand() >= 0.6) continue // seller doesn't carry this book
      for (let c = 0; c < seller.copies; c++) {
        ls.push({
          listing_id: `${seller.id}-isbn-${b}-${c}`,
          seller_id: seller.id, seller_name: seller.id,
          price: 1 + Math.round(rand() * 2000) / 100,
          shipping_base: 3.99, shipping_per_additional: seller.perAdd,
          condition: 'x',
          condition_normalized: ALL_CONDITIONS[Math.floor(rand() * ALL_CONDITIONS.length)],
          signed: rand() < 0.15, first_edition: false, dust_jacket: false,
          url: '', isbn: `isbn-${b}`,
        })
      }
    }
    listingsByIsbn.set(`isbn-${b}`, ls)
  }
  return { items, listingsByIsbn }
}

const TRIALS = 60

describe('optimizer properties (seeded random instances)', () => {
  it('grand_total is never worse than the greedy baseline', () => {
    for (let t = 0; t < TRIALS; t++) {
      const { items, listingsByIsbn } = generateInstance(1000 + t)
      const result = optimize(items, listingsByIsbn)
      const bookOptions = buildBookOptions(items, listingsByIsbn)
      const greedyCost = computeTotalCost(bookOptions, greedyStrategy.solve(bookOptions))
      expect(result.grand_total).toBeLessThanOrEqual(greedyCost + 1e-6)
    }
  })

  it('every assigned unit listing passes the item filters', () => {
    for (let t = 0; t < TRIALS; t++) {
      const { items, listingsByIsbn } = generateInstance(2000 + t)
      const result = optimize(items, listingsByIsbn)
      for (const group of result.groups) {
        for (const a of group.assignments) {
          for (const l of a.listings) {
            expect(listingQualifies(a.item, l)).toBe(true)
          }
        }
      }
    }
  })

  it('group totals are internally consistent and sum to grand_total', () => {
    for (let t = 0; t < TRIALS; t++) {
      const { items, listingsByIsbn } = generateInstance(3000 + t)
      const result = optimize(items, listingsByIsbn)
      let total = 0
      for (const g of result.groups) {
        const subtotals = g.assignments.reduce((s, a) => s + a.subtotal, 0)
        expect(g.books_subtotal).toBeCloseTo(subtotals, 6)
        expect(g.group_total).toBeCloseTo(g.books_subtotal + g.shipping, 6)
        total += g.group_total
      }
      expect(result.grand_total).toBeCloseTo(total, 6)
    }
  })

  it('savings is non-negative and equals max(0, naive - grand)', () => {
    for (let t = 0; t < TRIALS; t++) {
      const { items, listingsByIsbn } = generateInstance(4000 + t)
      const r = optimize(items, listingsByIsbn)
      expect(r.savings).toBeGreaterThanOrEqual(0)
      expect(r.savings).toBeCloseTo(Math.max(0, r.naive_total - r.grand_total), 6)
    }
  })

  it('assigned and unassigned items partition the cart', () => {
    for (let t = 0; t < TRIALS; t++) {
      const { items, listingsByIsbn } = generateInstance(5000 + t)
      const r = optimize(items, listingsByIsbn)
      const assigned = new Set(r.groups.flatMap((g) => g.assignments.map((a) => a.item.id)))
      const unassigned = new Set(r.unassigned.map((i) => i.id))
      expect(assigned.size + unassigned.size).toBe(items.length)
      for (const id of unassigned) expect(assigned.has(id)).toBe(false)
    }
  })

  it('marketplace assignments use distinct physical copies', () => {
    for (let t = 0; t < TRIALS; t++) {
      const { items, listingsByIsbn } = generateInstance(6000 + t)
      const r = optimize(items, listingsByIsbn)
      for (const g of r.groups) {
        if (g.seller_id === 'thriftbooks' || g.seller_id === 'betterworldbooks') continue
        for (const a of g.assignments) {
          const ids = a.listings.map((l) => l.listing_id)
          expect(new Set(ids).size).toBe(ids.length)
          expect(ids.length).toBe(a.item.quantity)
        }
      }
    }
  })

  it('optimize is deterministic on random instances', () => {
    for (let t = 0; t < 10; t++) {
      const { items, listingsByIsbn } = generateInstance(7000 + t)
      const r1 = optimize(items, listingsByIsbn)
      const r2 = optimize(items, listingsByIsbn)
      expect(JSON.stringify(r1)).toBe(JSON.stringify(r2))
    }
  })

  it('matches the exhaustive optimum on small instances (including quantity > 1)', () => {
    for (let t = 0; t < 30; t++) {
      const { items, listingsByIsbn } = generateInstance(8000 + t, 5)
      const bookOptions = buildBookOptions(items, listingsByIsbn)
      // Skip instances whose brute-force space is too large to enumerate
      const space = bookOptions.reduce((p, b) => p * Math.max(1, b.offers.size), 1)
      if (space > 100_000) continue

      let best = Infinity
      const assignment: Assignment = new Map()
      const perBook = bookOptions.map((b) => Array.from(b.offers.values()))
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
      if (best === Infinity) continue

      const result = optimize(items, listingsByIsbn)
      expect(result.grand_total).toBeCloseTo(best, 6)
    }
  })
})
