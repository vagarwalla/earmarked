import type { OptimizerStrategy, BookOption, Assignment, Listing } from '../shared'
import { CostTracker } from '../shared'
import { solveGreedy } from './greedy'

const MAX_CANDIDATES_PER_BOOK = 10
const NUM_STARTS = 5
const ILS_PERTURB_MIN = 2
const ILS_PERTURB_MAX = 4

function timeBudgetMs(n: number): number {
  if (n <= 10) return 50
  if (n <= 20) return 200
  return 500
}

/**
 * Run single-swap local search on an assignment, improving it in-place.
 * Returns the final assignment and its cost.
 */
function localSearchImprove(
  bookOptions: BookOption[],
  assignment: Assignment,
  candidatesByBook: Array<Map<string, Listing>>,
): { assignment: Assignment; cost: number } {
  const tracker = CostTracker.fromAssignment(bookOptions, assignment)

  let improved = true
  while (improved) {
    improved = false

    for (let i = 0; i < bookOptions.length; i++) {
      const opt = bookOptions[i]
      const currentListing = assignment.get(opt.item.id)
      if (!currentListing) continue
      const qty = opt.item.quantity

      let bestListing = currentListing
      let bestCost = tracker.totalCost

      for (const [sellerId, listing] of candidatesByBook[i]) {
        if (sellerId === currentListing.seller_id) continue

        tracker.removeBook(currentListing.seller_id, currentListing.price, qty)
        tracker.addBook(sellerId, listing.price, qty, listing.shipping_base, listing.shipping_per_additional)

        if (tracker.totalCost < bestCost - 0.001) {
          bestCost = tracker.totalCost
          bestListing = listing
        }

        tracker.removeBook(sellerId, listing.price, qty)
        tracker.addBook(currentListing.seller_id, currentListing.price, qty, currentListing.shipping_base, currentListing.shipping_per_additional)
      }

      if (bestListing !== currentListing) {
        tracker.removeBook(currentListing.seller_id, currentListing.price, qty)
        tracker.addBook(bestListing.seller_id, bestListing.price, qty, bestListing.shipping_base, bestListing.shipping_per_additional)
        assignment.set(opt.item.id, bestListing)
        improved = true
      }
    }
  }

  // 2-swap pass: try swapping sellers for all pairs of assigned books
  if (bookOptions.length <= 30) {
    let twoSwapImproved = true
    while (twoSwapImproved) {
      twoSwapImproved = false

      for (let i = 0; i < bookOptions.length; i++) {
        const optI = bookOptions[i]
        const listingI = assignment.get(optI.item.id)
        if (!listingI) continue
        const qtyI = optI.item.quantity

        for (let j = i + 1; j < bookOptions.length; j++) {
          const optJ = bookOptions[j]
          const listingJ = assignment.get(optJ.item.id)
          if (!listingJ) continue
          if (listingI.seller_id === listingJ.seller_id) continue
          const qtyJ = optJ.item.quantity

          // Try: book i goes to each of j's seller candidates, book j goes to each of i's seller candidates
          const baseCost = tracker.totalCost
          let bestCostDelta = 0
          let bestListingI: Listing | null = null
          let bestListingJ: Listing | null = null

          // Remove both from current sellers
          tracker.removeBook(listingI.seller_id, listingI.price, qtyI)
          tracker.removeBook(listingJ.seller_id, listingJ.price, qtyJ)
          const costWithout = tracker.totalCost

          for (const [sidI, candI] of candidatesByBook[i]) {
            for (const [sidJ, candJ] of candidatesByBook[j]) {
              // Skip if this is the same as current assignment
              if (sidI === listingI.seller_id && sidJ === listingJ.seller_id) continue

              tracker.addBook(sidI, candI.price, qtyI, candI.shipping_base, candI.shipping_per_additional)
              tracker.addBook(sidJ, candJ.price, qtyJ, candJ.shipping_base, candJ.shipping_per_additional)

              const delta = tracker.totalCost - baseCost
              if (delta < bestCostDelta - 0.001) {
                bestCostDelta = delta
                bestListingI = candI
                bestListingJ = candJ
              }

              tracker.removeBook(sidI, candI.price, qtyI)
              tracker.removeBook(sidJ, candJ.price, qtyJ)
            }
          }

          // Restore original
          tracker.addBook(listingI.seller_id, listingI.price, qtyI, listingI.shipping_base, listingI.shipping_per_additional)
          tracker.addBook(listingJ.seller_id, listingJ.price, qtyJ, listingJ.shipping_base, listingJ.shipping_per_additional)

          if (bestListingI && bestListingJ) {
            // Commit the 2-swap
            tracker.removeBook(listingI.seller_id, listingI.price, qtyI)
            tracker.removeBook(listingJ.seller_id, listingJ.price, qtyJ)
            tracker.addBook(bestListingI.seller_id, bestListingI.price, qtyI, bestListingI.shipping_base, bestListingI.shipping_per_additional)
            tracker.addBook(bestListingJ.seller_id, bestListingJ.price, qtyJ, bestListingJ.shipping_base, bestListingJ.shipping_per_additional)
            assignment.set(optI.item.id, bestListingI)
            assignment.set(optJ.item.id, bestListingJ)
            twoSwapImproved = true
          }
        }
      }
    }
  }

  return { assignment, cost: tracker.totalCost }
}

/**
 * Perturb an assignment by randomly reassigning numPerturb books to random sellers.
 */
function perturb(
  bookOptions: BookOption[],
  assignment: Assignment,
  candidatesByBook: Array<Map<string, Listing>>,
  numPerturb: number,
): Assignment {
  const result = new Map(assignment)
  const indices = bookOptions
    .map((_, i) => i)
    .filter((i) => candidatesByBook[i].size > 1 && result.has(bookOptions[i].item.id))

  const count = Math.min(numPerturb, indices.length)
  // Fisher-Yates partial shuffle
  for (let k = 0; k < count; k++) {
    const j = k + Math.floor(Math.random() * (indices.length - k))
    ;[indices[k], indices[j]] = [indices[j], indices[k]]
  }

  for (let k = 0; k < count; k++) {
    const i = indices[k]
    const opt = bookOptions[i]
    const currentSeller = result.get(opt.item.id)?.seller_id
    const candidates = Array.from(candidatesByBook[i].entries()).filter(([sid]) => sid !== currentSeller)
    if (candidates.length > 0) {
      const [, listing] = candidates[Math.floor(Math.random() * candidates.length)]
      result.set(opt.item.id, listing)
    }
  }

  return result
}

/**
 * Local search strategy with multi-start and Iterated Local Search (ILS).
 * Starts from multiple greedy solutions (one deterministic, rest randomized),
 * applies single-swap local search, then perturbs and re-optimizes within
 * a time budget.
 */
export const localSearchStrategy: OptimizerStrategy = {
  name: 'local-search',

  solve(bookOptions: BookOption[]): Assignment {
    if (bookOptions.length === 0) return new Map()

    // Pre-compute cheapest listing per seller for each book
    const candidatesByBook: Array<Map<string, Listing>> = bookOptions.map((opt) => {
      const bySellerCheapest = new Map<string, Listing>()
      for (const l of opt.listings) {
        if (!bySellerCheapest.has(l.seller_id)) {
          bySellerCheapest.set(l.seller_id, l)
          if (bySellerCheapest.size >= MAX_CANDIDATES_PER_BOOK) break
        }
      }
      return bySellerCheapest
    })

    let bestAssignment: Assignment = new Map()
    let bestCost = Infinity
    const deadline = Date.now() + timeBudgetMs(bookOptions.length)

    for (let start = 0; start < NUM_STARTS; start++) {
      // First start is deterministic greedy, rest are randomized
      const initial = solveGreedy(bookOptions, start === 0 ? 0 : 0.3)
      let { assignment: current, cost: currentCost } = localSearchImprove(
        bookOptions, initial, candidatesByBook,
      )

      if (currentCost < bestCost) {
        bestCost = currentCost
        bestAssignment = new Map(current)
      }

      // ILS: perturb and re-optimize within time budget
      while (Date.now() < deadline) {
        const numPerturb = ILS_PERTURB_MIN + Math.floor(Math.random() * (ILS_PERTURB_MAX - ILS_PERTURB_MIN + 1))
        const perturbed = perturb(bookOptions, current, candidatesByBook, numPerturb)
        const { assignment: candidate, cost: candidateCost } = localSearchImprove(
          bookOptions, perturbed, candidatesByBook,
        )

        if (candidateCost < currentCost - 0.001) {
          current = candidate
          currentCost = candidateCost
          if (currentCost < bestCost) {
            bestCost = currentCost
            bestAssignment = new Map(current)
          }
        }
      }
    }

    return bestAssignment
  },
}
