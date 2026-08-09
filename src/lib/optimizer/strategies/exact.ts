import type { OptimizerStrategy, BookOption, Assignment, Listing } from '../shared'
import { shippingCost, computeTotalCost } from '../shared'

// Total sellers considered per book (limits branching factor). Do not raise
// casually: worst case is candidates^books before pruning.
const MAX_CANDIDATES_PER_BOOK = 6
// Of those: cheapest sellers for this book, then highest-cart-coverage
// sellers. Coverage slots exist because the optimal consolidation seller is
// often not among a book's very cheapest sellers.
const CHEAPEST_SLOTS = 4
// Hard bound on branch-and-bound work. Deterministic (counted nodes, not
// wall clock). At the cap the best incumbent found so far is returned —
// with a warm start that incumbent is never worse than the warm start.
const DEFAULT_NODE_BUDGET = 500_000

export type ExactOptions = {
  /** Initial incumbent; the result is never worse than this assignment. */
  warmStart?: Assignment
  nodeBudget?: number
}

/**
 * Branch-and-bound over seller assignments. Optimal within its candidate
 * sets when it completes under the node budget; otherwise returns the best
 * incumbent found. Books are branched most-constrained-first and the search
 * can be warm-started with a known-good assignment, which both tightens
 * pruning from the first node and guarantees the output quality.
 */
export function solveExact(bookOptions: BookOption[], opts: ExactOptions = {}): Assignment {
  const n = bookOptions.length
  if (n === 0) return new Map()

  const nodeBudget = opts.nodeBudget ?? DEFAULT_NODE_BUDGET

  // Cheapest listing per seller for each book (listings are sorted by
  // price + shipping_base, so insertion order is cheapest-first)
  const sellerMaps: Array<Map<string, Listing>> = bookOptions.map((opt) => {
    const bySellerCheapest = new Map<string, Listing>()
    for (const l of opt.listings) {
      if (!bySellerCheapest.has(l.seller_id)) bySellerCheapest.set(l.seller_id, l)
    }
    return bySellerCheapest
  })

  // Cart-wide coverage: how many books each seller can supply
  const coverage = new Map<string, number>()
  for (const m of sellerMaps) {
    for (const sellerId of m.keys()) coverage.set(sellerId, (coverage.get(sellerId) ?? 0) + 1)
  }

  // Candidate selection per book: CHEAPEST_SLOTS cheapest sellers, then fill
  // remaining slots with the highest-coverage sellers not already included.
  const candidatesByBook: Array<Array<{ sellerId: string; listing: Listing }>> = sellerMaps.map((m) => {
    const entries = Array.from(m.entries()) // cheapest-first
    const chosen = entries.slice(0, CHEAPEST_SLOTS)
    if (entries.length > CHEAPEST_SLOTS) {
      const rest = entries.slice(CHEAPEST_SLOTS)
        .map(([sellerId, listing], idx) => ({ sellerId, listing, idx, cov: coverage.get(sellerId) ?? 0 }))
        .sort((a, b) => b.cov - a.cov || a.idx - b.idx) // deterministic tie-break: cheaper first
      for (const r of rest.slice(0, MAX_CANDIDATES_PER_BOOK - CHEAPEST_SLOTS)) {
        chosen.push([r.sellerId, r.listing])
      }
    }
    return chosen
      .map(([sellerId, listing]) => ({ sellerId, listing }))
      .sort((a, b) =>
        (a.listing.price + a.listing.shipping_base) - (b.listing.price + b.listing.shipping_base))
  })

  // Branch most-constrained-first: fewest candidates, then largest cost
  // spread (a wide spread means picking wrong is expensive — decide early).
  const order = bookOptions.map((_, i) => i).sort((a, b) => {
    const ca = candidatesByBook[a], cb = candidatesByBook[b]
    if (ca.length !== cb.length) return ca.length - cb.length
    const spread = (c: typeof ca) => c.length === 0 ? 0 :
      (c[c.length - 1].listing.price + c[c.length - 1].listing.shipping_base) -
      (c[0].listing.price + c[0].listing.shipping_base)
    return spread(cb) - spread(ca) || a - b
  })
  const orderedBooks = order.map((i) => bookOptions[i])
  const orderedCandidates = order.map((i) => candidatesByBook[i])

  // Suffix sums of cheapest prices for the lower bound ($0 marginal shipping
  // for unassigned books is always a valid lower bound)
  const suffixMinPrice = new Array(n + 1).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    const qty = orderedBooks[i].item.quantity
    const cheapest = orderedCandidates[i].length > 0 ? orderedCandidates[i][0].listing.price * qty : 0
    suffixMinPrice[i] = suffixMinPrice[i + 1] + cheapest
  }

  // Incumbent: warm start if provided, else empty (Infinity cost)
  let bestAssignment: Assignment = opts.warmStart ? new Map(opts.warmStart) : new Map()
  let bestCost = opts.warmStart ? computeTotalCost(bookOptions, opts.warmStart) : Infinity

  const chosen: Array<{ sellerId: string; listing: Listing } | null> = new Array(n).fill(null)
  let nodesVisited = 0
  let aborted = false

  // Incremental seller state maintained during backtracking
  type SellerInfo = { qty: number; bookCost: number; shippingBase: number; perAdditional: number }
  const sellers = new Map<string, SellerInfo>()
  let assignedCost = 0

  function sellerCost(s: SellerInfo): number {
    return s.bookCost + shippingCost(s.qty, s.shippingBase, s.perAdditional)
  }

  function addToSeller(sellerId: string, listing: Listing, qty: number): void {
    const s = sellers.get(sellerId)
    if (s) {
      assignedCost -= sellerCost(s)
      s.qty += qty
      s.bookCost += listing.price * qty
      assignedCost += sellerCost(s)
    } else {
      const ns: SellerInfo = { qty, bookCost: listing.price * qty, shippingBase: listing.shipping_base, perAdditional: listing.shipping_per_additional }
      sellers.set(sellerId, ns)
      assignedCost += sellerCost(ns)
    }
  }

  function removeFromSeller(sellerId: string, listing: Listing, qty: number): void {
    const s = sellers.get(sellerId)!
    assignedCost -= sellerCost(s)
    s.qty -= qty
    s.bookCost -= listing.price * qty
    if (s.qty <= 0) {
      sellers.delete(sellerId)
    } else {
      assignedCost += sellerCost(s)
    }
  }

  function recordLeaf(): void {
    if (assignedCost >= bestCost) return
    bestCost = assignedCost
    const m: Assignment = new Map()
    for (let i = 0; i < n; i++) {
      const c = chosen[i]
      if (c) m.set(orderedBooks[i].item.id, c.listing)
    }
    bestAssignment = m
  }

  function backtrack(bookIdx: number): void {
    if (aborted) return
    if (bookIdx === n) {
      recordLeaf()
      return
    }

    // Books with no qualifying listings are skipped
    if (orderedCandidates[bookIdx].length === 0) {
      chosen[bookIdx] = null
      backtrack(bookIdx + 1)
      return
    }

    for (const candidate of orderedCandidates[bookIdx]) {
      if (++nodesVisited > nodeBudget) { aborted = true; return }

      const qty = orderedBooks[bookIdx].item.quantity
      chosen[bookIdx] = candidate
      addToSeller(candidate.sellerId, candidate.listing, qty)

      const lb = assignedCost + suffixMinPrice[bookIdx + 1]
      if (lb < bestCost) {
        backtrack(bookIdx + 1)
      }

      removeFromSeller(candidate.sellerId, candidate.listing, qty)
      if (aborted) return
    }
    chosen[bookIdx] = null
  }

  backtrack(0)
  return bestAssignment
}

/**
 * Standalone exact strategy (no warm start). Prefer optimize()'s auto mode,
 * which warm-starts this search with the local-search solution.
 */
export const exactStrategy: OptimizerStrategy = {
  name: 'exact',
  solve(bookOptions: BookOption[]): Assignment {
    return solveExact(bookOptions)
  },
}
