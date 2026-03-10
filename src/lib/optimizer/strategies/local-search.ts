import type { OptimizerStrategy, BookOption, Assignment } from '../shared'
import { computeTotalCost } from '../shared'
import { greedyStrategy } from './greedy'

// How many unique sellers to consider per book on each improvement pass
const MAX_CANDIDATES_PER_BOOK = 10

/**
 * Local search strategy: starts from the greedy solution and repeatedly tries
 * reassigning each book to a cheaper seller until no single-book swap improves
 * the total cost. Near-optimal in practice; handles any cart size.
 *
 * Time complexity: O(iterations × books × candidates × books) — fast for typical carts.
 */
export const localSearchStrategy: OptimizerStrategy = {
  name: 'local-search',

  solve(bookOptions: BookOption[]): Assignment {
    const assignment = new Map(greedyStrategy.solve(bookOptions))

    // Pre-compute cheapest listing per seller for each book
    const candidatesByBook: Array<Map<string, import('../shared').Listing>> = bookOptions.map((opt) => {
      const bySellerCheapest = new Map<string, import('../shared').Listing>()
      for (const l of opt.listings) {
        if (!bySellerCheapest.has(l.seller_id)) {
          bySellerCheapest.set(l.seller_id, l)
          if (bySellerCheapest.size >= MAX_CANDIDATES_PER_BOOK) break
        }
      }
      return bySellerCheapest
    })

    let improved = true
    while (improved) {
      improved = false

      for (let i = 0; i < bookOptions.length; i++) {
        const opt = bookOptions[i]
        const currentListing = assignment.get(opt.item.id)
        const baseCost = computeTotalCost(bookOptions, assignment)

        let bestListing = currentListing
        let bestCost = baseCost

        for (const [sellerId, listing] of candidatesByBook[i]) {
          if (sellerId === currentListing?.seller_id) continue

          // Trial: swap this book to the candidate seller
          assignment.set(opt.item.id, listing)
          const trialCost = computeTotalCost(bookOptions, assignment)

          if (trialCost < bestCost - 0.001) {
            bestCost = trialCost
            bestListing = listing
          }

          // Always revert before trying the next candidate
          if (currentListing) assignment.set(opt.item.id, currentListing)
          else assignment.delete(opt.item.id)
        }

        if (bestListing !== currentListing) {
          assignment.set(opt.item.id, bestListing!)
          improved = true
        }
      }
    }

    return assignment
  },
}
