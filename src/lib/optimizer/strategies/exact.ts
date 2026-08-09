import type { OptimizerStrategy, BookOption, Assignment, SellerOffer } from '../shared'
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

  // Cart-wide coverage: how many books each seller can supply in full
  const coverage = new Map<string, number>()
  for (const { offers } of bookOptions) {
    for (const sellerId of offers.keys()) coverage.set(sellerId, (coverage.get(sellerId) ?? 0) + 1)
  }

  // Candidate selection per book: CHEAPEST_SLOTS cheapest offers, then fill
  // remaining slots with the highest-coverage sellers not already included.
  // (offers are sorted by total_price + shipping_base.)
  const candidatesByBook: Array<SellerOffer[]> = bookOptions.map(({ offers }) => {
    const entries = Array.from(offers.values())
    const chosen = entries.slice(0, CHEAPEST_SLOTS)
    if (entries.length > CHEAPEST_SLOTS) {
      const rest = entries.slice(CHEAPEST_SLOTS)
        .map((offer, idx) => ({ offer, idx, cov: coverage.get(offer.seller_id) ?? 0 }))
        .sort((a, b) => b.cov - a.cov || a.idx - b.idx) // deterministic tie-break: cheaper first
      for (const r of rest.slice(0, MAX_CANDIDATES_PER_BOOK - CHEAPEST_SLOTS)) {
        chosen.push(r.offer)
      }
    }
    return chosen.sort((a, b) => (a.total_price + a.shipping_base) - (b.total_price + b.shipping_base))
  })

  // Branch most-constrained-first: fewest candidates, then largest cost
  // spread (a wide spread means picking wrong is expensive — decide early).
  const order = bookOptions.map((_, i) => i).sort((a, b) => {
    const ca = candidatesByBook[a], cb = candidatesByBook[b]
    if (ca.length !== cb.length) return ca.length - cb.length
    const spread = (c: SellerOffer[]) => c.length === 0 ? 0 :
      (c[c.length - 1].total_price + c[c.length - 1].shipping_base) -
      (c[0].total_price + c[0].shipping_base)
    return spread(cb) - spread(ca) || a - b
  })
  const orderedBooks = order.map((i) => bookOptions[i])
  const orderedCandidates = order.map((i) => candidatesByBook[i])

  // Suffix sums of cheapest book costs for the lower bound ($0 marginal
  // shipping for unassigned books is always a valid lower bound)
  const suffixMinPrice = new Array(n + 1).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    const cheapest = orderedCandidates[i].length > 0 ? orderedCandidates[i][0].total_price : 0
    suffixMinPrice[i] = suffixMinPrice[i + 1] + cheapest
  }

  // Incumbent: warm start if provided, else empty (Infinity cost)
  let bestAssignment: Assignment = opts.warmStart ? new Map(opts.warmStart) : new Map()
  let bestCost = opts.warmStart ? computeTotalCost(bookOptions, opts.warmStart) : Infinity

  const chosen: Array<SellerOffer | null> = new Array(n).fill(null)
  let nodesVisited = 0
  let aborted = false

  // Incremental seller state maintained during backtracking
  type SellerInfo = { qty: number; bookCost: number; shippingBase: number; perAdditional: number }
  const sellers = new Map<string, SellerInfo>()
  let assignedCost = 0

  function sellerCost(s: SellerInfo): number {
    return s.bookCost + shippingCost(s.qty, s.shippingBase, s.perAdditional)
  }

  function addOffer(offer: SellerOffer): void {
    const units = offer.listings.length
    const s = sellers.get(offer.seller_id)
    if (s) {
      assignedCost -= sellerCost(s)
      s.qty += units
      s.bookCost += offer.total_price
      assignedCost += sellerCost(s)
    } else {
      const ns: SellerInfo = { qty: units, bookCost: offer.total_price, shippingBase: offer.shipping_base, perAdditional: offer.shipping_per_additional }
      sellers.set(offer.seller_id, ns)
      assignedCost += sellerCost(ns)
    }
  }

  function removeOffer(offer: SellerOffer): void {
    const units = offer.listings.length
    const s = sellers.get(offer.seller_id)!
    assignedCost -= sellerCost(s)
    s.qty -= units
    s.bookCost -= offer.total_price
    if (s.qty <= 0) {
      sellers.delete(offer.seller_id)
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
      if (c) m.set(orderedBooks[i].item.id, c)
    }
    bestAssignment = m
  }

  function backtrack(bookIdx: number): void {
    if (aborted) return
    if (bookIdx === n) {
      recordLeaf()
      return
    }

    // Books with no fulfillable offers are skipped
    if (orderedCandidates[bookIdx].length === 0) {
      chosen[bookIdx] = null
      backtrack(bookIdx + 1)
      return
    }

    for (const candidate of orderedCandidates[bookIdx]) {
      if (++nodesVisited > nodeBudget) { aborted = true; return }

      chosen[bookIdx] = candidate
      addOffer(candidate)

      const lb = assignedCost + suffixMinPrice[bookIdx + 1]
      if (lb < bestCost) {
        backtrack(bookIdx + 1)
      }

      removeOffer(candidate)
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
