import type { OptimizerStrategy, BookOption, Assignment, Listing } from '../shared'
import { shippingCost, buildCandidatesByBook } from '../shared'

// Per-book branching: the cheapest sellers for each book, always unioned with
// consolidation "hub" sellers (see buildCandidatesByBook). Optimality only
// requires the single cheapest-by-total seller plus all hubs, so a small top-K
// keeps branching tight while preserving the guarantee.
const TOP_K_PER_BOOK = 4
const MAX_HUBS = 8
const MAX_CANDIDATES_PER_BOOK = 12

// Defensive wall-clock cap. With realistic data branch-and-bound finishes in a
// few ms; this guard only fires on pathological carts (many highly-overlapping
// sellers) and returns the best complete assignment found so far.
const TIME_BUDGET_MS = 1000

/**
 * Exact strategy: branch-and-bound over all possible seller assignments.
 * Optimal over the candidate set, which is constructed to provably contain a
 * globally optimal solution (cheapest per-book sellers ∪ all consolidation
 * hubs — see buildCandidatesByBook). Practical for carts up to ~12 books.
 *
 * Uses incremental state tracking during backtracking to avoid rebuilding
 * seller maps from scratch at every node. Lower bound uses actual seller
 * shipping params for assigned books and $0 marginal shipping for unassigned
 * books (valid because flat-rate sellers have per_additional = 0).
 */
export const exactStrategy: OptimizerStrategy = {
  name: 'exact',

  solve(bookOptions: BookOption[]): Assignment {
    const n = bookOptions.length

    // For each book: cheapest listing per seller (incl. hubs), cheapest-first.
    const candidateMaps = buildCandidatesByBook(bookOptions, {
      topKPerBook: TOP_K_PER_BOOK,
      maxHubs: MAX_HUBS,
      maxPerBook: MAX_CANDIDATES_PER_BOOK,
    })
    const candidates: Array<Array<{ sellerId: string; listing: Listing }>> = candidateMaps.map((m) =>
      Array.from(m.values())
        .sort((a, b) => a.price - b.price)
        .map((listing) => ({ sellerId: listing.seller_id, listing }))
    )

    // Pre-compute the sum of cheapest prices for books [i..n-1] (suffix sums)
    // Used by lowerBound to avoid re-summing unassigned book prices each time
    const suffixMinPrice = new Array(n + 1).fill(0)
    for (let i = n - 1; i >= 0; i--) {
      const qty = bookOptions[i].item.quantity
      const cheapest = candidates[i].length > 0 ? candidates[i][0].listing.price * qty : 0
      suffixMinPrice[i] = suffixMinPrice[i + 1] + cheapest
    }

    const chosen: Array<{ sellerId: string; listing: Listing } | null> = new Array(n).fill(null)
    let bestCost = Infinity
    let bestChosen: typeof chosen = []

    // Incremental seller state maintained during backtracking
    type SellerInfo = { qty: number; bookCost: number; shippingBase: number; perAdditional: number }
    const sellers = new Map<string, SellerInfo>()
    // Running cost of all assigned sellers (book prices + shipping)
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

    const deadline = Date.now() + TIME_BUDGET_MS
    let aborted = false

    function backtrack(bookIdx: number) {
      if (aborted) return
      if (bookIdx === n) {
        if (assignedCost < bestCost) {
          bestCost = assignedCost
          bestChosen = chosen.slice()
        }
        return
      }

      // Depth-first explores the cheapest candidate first, so a complete
      // assignment is recorded almost immediately; if the budget is exhausted
      // we bail out and keep the best one found so far.
      if ((bookIdx & 7) === 0 && Date.now() > deadline) {
        aborted = true
        return
      }

      // Books with no qualifying listings are skipped
      if (candidates[bookIdx].length === 0) {
        chosen[bookIdx] = null
        backtrack(bookIdx + 1)
        return
      }

      for (const candidate of candidates[bookIdx]) {
        const qty = bookOptions[bookIdx].item.quantity
        chosen[bookIdx] = candidate
        addToSeller(candidate.sellerId, candidate.listing, qty)

        // Lower bound = assignedCost + sum of cheapest prices for remaining books
        // (with $0 marginal shipping — valid lower bound)
        const lb = assignedCost + suffixMinPrice[bookIdx + 1]
        if (lb < bestCost) {
          backtrack(bookIdx + 1)
        }

        removeFromSeller(candidate.sellerId, candidate.listing, qty)
      }
      chosen[bookIdx] = null
    }

    backtrack(0)

    const assignment: Assignment = new Map()
    for (let i = 0; i < n; i++) {
      const c = bestChosen[i]
      if (c) assignment.set(bookOptions[i].item.id, c.listing)
    }
    return assignment
  },
}
