import { describe, it, expect } from 'vitest'
import { optimize } from '../index'
import { greedyStrategy } from '../strategies/greedy'
import { buildBookOptions, computeTotalCost } from '../shared'
import { mulberry32 } from '../rng'
import type { CartItem, Condition, Listing } from '../../types'

// Run with: npm run bench:optimizer
// Reports per-scenario latency and cost gap vs the greedy baseline. Use when
// tuning optimizer constants (node budget, ILS iterations, candidate slots).

function makeInstance(seed: number, nBooks: number, nSellers: number, coverage: number) {
  const rand = mulberry32(seed)
  const items: CartItem[] = []
  const listingsByIsbn = new Map<string, Listing[]>()
  for (let b = 0; b < nBooks; b++) {
    items.push({
      id: `i${b}`, cart_id: 'c', title: `Book ${b}`, author: null, work_id: null,
      isbn_preferred: `isbn-${b}`, cover_url: null, format: 'any',
      conditions: ['new', 'fine', 'good', 'fair'] as Condition[],
      max_price: null, flexible: false, signed_only: null,
      first_edition_only: null, dust_jacket_only: null,
      quantity: 1, sort_order: b, created_at: '', isbns_candidates: null,
    })
    const ls: Listing[] = []
    for (let s = 0; s < nSellers; s++) {
      if (rand() >= coverage) continue
      const retailer = s === 0
      ls.push({
        listing_id: `S${s}-isbn-${b}`,
        seller_id: retailer ? 'thriftbooks' : `abe-${s}`,
        seller_name: `S${s}`,
        price: 1 + Math.round(rand() * 2000) / 100,
        // Per-listing bases, as AbeBooks actually quotes them
        shipping_base: retailer ? 3.99 : [0, 0, 3.99, 5.99, 9.99][Math.floor(rand() * 5)],
        shipping_per_additional: retailer ? 0 : 1.99,
        condition: 'Fine', condition_normalized: 'fine',
        signed: false, first_edition: false, dust_jacket: false,
        url: '', isbn: `isbn-${b}`,
      })
    }
    listingsByIsbn.set(`isbn-${b}`, ls)
  }
  return { items, listingsByIsbn }
}

const SCENARIOS = [
  { name: ' 5 books, 10 sellers, dense ', nBooks: 5, nSellers: 10, coverage: 0.8 },
  { name: '15 books, 15 sellers, dense ', nBooks: 15, nSellers: 15, coverage: 0.8 },
  { name: '15 books, 40 sellers, sparse', nBooks: 15, nSellers: 40, coverage: 0.2 },
  { name: '30 books, 30 sellers, mixed ', nBooks: 30, nSellers: 30, coverage: 0.4 },
  { name: '60 books, 60 sellers, sparse', nBooks: 60, nSellers: 60, coverage: 0.15 },
]
const RUNS_PER_SCENARIO = 5

describe.runIf(process.env.BENCH === '1')('optimizer benchmark', () => {
  it('reports latency and cost gap vs greedy', () => {
    const rows: string[] = []
    for (const sc of SCENARIOS) {
      let worstMs = 0, totalMs = 0, gapSum = 0
      for (let run = 0; run < RUNS_PER_SCENARIO; run++) {
        const { items, listingsByIsbn } = makeInstance(42 + run, sc.nBooks, sc.nSellers, sc.coverage)
        const t0 = performance.now()
        const result = optimize(items, listingsByIsbn)
        const ms = performance.now() - t0
        totalMs += ms
        worstMs = Math.max(worstMs, ms)

        const bookOptions = buildBookOptions(items, listingsByIsbn)
        const greedyCost = computeTotalCost(bookOptions, greedyStrategy.solve(bookOptions))
        gapSum += greedyCost > 0 ? (greedyCost - result.grand_total) / greedyCost : 0
        expect(result.grand_total).toBeLessThanOrEqual(greedyCost + 1e-6)
      }
      rows.push(
        `${sc.name}  avg ${(totalMs / RUNS_PER_SCENARIO).toFixed(1).padStart(7)}ms` +
        `  worst ${worstMs.toFixed(1).padStart(7)}ms` +
        `  avg saving vs greedy ${(100 * gapSum / RUNS_PER_SCENARIO).toFixed(2).padStart(6)}%`
      )
    }
    console.log('\n── optimizer benchmark ──\n' + rows.join('\n') + '\n')
  }, 120_000)
})
