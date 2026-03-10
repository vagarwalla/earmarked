import type { OptimizerStrategy, BookOption, Assignment, Listing } from '../shared'
import { shippingCost } from '../shared'

// Top sellers to consider per book (limits branching factor)
const MAX_CANDIDATES_PER_BOOK = 6

/**
 * Exact strategy: branch-and-bound over all possible seller assignments.
 * Guaranteed optimal. Practical for carts up to ~10 books with the branching
 * factor capped at MAX_CANDIDATES_PER_BOOK per book.
 *
 * Lower bound: exact cost for assigned books + cheapest price for each
 * unassigned book + $1.99 shipping per unassigned book (best-case marginal
 * shipping assuming they join an existing seller order).
 */
export const exactStrategy: OptimizerStrategy = {
  name: 'exact',

  solve(bookOptions: BookOption[]): Assignment {
    const n = bookOptions.length

    // For each book: cheapest listing per seller, sorted cheapest-first
    const candidates: Array<Array<{ sellerId: string; listing: Listing }>> = bookOptions.map((opt) => {
      const bySellerCheapest = new Map<string, Listing>()
      for (const l of opt.listings) {
        if (!bySellerCheapest.has(l.seller_id)) {
          bySellerCheapest.set(l.seller_id, l)
          if (bySellerCheapest.size >= MAX_CANDIDATES_PER_BOOK) break
        }
      }
      return Array.from(bySellerCheapest.values())
        .sort((a, b) => a.price - b.price)
        .map((listing) => ({ sellerId: listing.seller_id, listing }))
    })

    const chosen: Array<{ sellerId: string; listing: Listing } | null> = new Array(n).fill(null)
    let bestCost = Infinity
    let bestChosen: typeof chosen = []

    // Lower bound for partial assignment (first k books assigned):
    // exact cost of assigned portion + floor estimate for the rest
    function lowerBound(k: number): number {
      const sellerQty = new Map<string, number>()
      const sellerBookCost = new Map<string, number>()

      for (let i = 0; i < k; i++) {
        const c = chosen[i]
        if (!c) continue
        const qty = bookOptions[i].item.quantity
        sellerQty.set(c.sellerId, (sellerQty.get(c.sellerId) ?? 0) + qty)
        sellerBookCost.set(c.sellerId, (sellerBookCost.get(c.sellerId) ?? 0) + c.listing.price * qty)
      }

      let lb = 0
      for (const [sid, bookCost] of sellerBookCost) {
        lb += bookCost + shippingCost(sellerQty.get(sid)!)
      }

      // Remaining books: cheapest price + $1.99 marginal shipping each
      // ($1.99 assumes they join an existing order; valid lower bound since
      //  a new seller would cost $3.99 base which is higher)
      for (let i = k; i < n; i++) {
        if (candidates[i].length > 0) {
          const qty = bookOptions[i].item.quantity
          lb += candidates[i][0].listing.price * qty + 1.99 * qty
        }
      }

      return lb
    }

    function exactCost(): number {
      const sellerQty = new Map<string, number>()
      const sellerBookCost = new Map<string, number>()
      for (let i = 0; i < n; i++) {
        const c = chosen[i]
        if (!c) continue
        const qty = bookOptions[i].item.quantity
        sellerQty.set(c.sellerId, (sellerQty.get(c.sellerId) ?? 0) + qty)
        sellerBookCost.set(c.sellerId, (sellerBookCost.get(c.sellerId) ?? 0) + c.listing.price * qty)
      }
      let cost = 0
      for (const [sid, bookCost] of sellerBookCost) {
        cost += bookCost + shippingCost(sellerQty.get(sid)!)
      }
      return cost
    }

    function backtrack(bookIdx: number) {
      if (bookIdx === n) {
        const cost = exactCost()
        if (cost < bestCost) {
          bestCost = cost
          bestChosen = chosen.slice()
        }
        return
      }

      // Books with no qualifying listings are skipped (assigned nothing)
      if (candidates[bookIdx].length === 0) {
        chosen[bookIdx] = null
        backtrack(bookIdx + 1)
        return
      }

      for (const candidate of candidates[bookIdx]) {
        chosen[bookIdx] = candidate
        if (lowerBound(bookIdx + 1) < bestCost) {
          backtrack(bookIdx + 1)
        }
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
