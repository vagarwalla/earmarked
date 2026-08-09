import type { OptimizerStrategy, BookOption, Assignment, SellerOffer } from '../shared'
import { CostTracker } from '../shared'
import type { Rand } from '../rng'
import { mulberry32, seedFromBookOptions } from '../rng'
import { solveGreedy } from './greedy'

const MAX_CANDIDATES_PER_BOOK = 10
const NUM_STARTS = 5
const ILS_PERTURB_MIN = 2
const ILS_PERTURB_MAX = 4
// Wall-clock backstop only (serverless safety) — the primary budget is
// iteration-based so results are deterministic for a given input.
const HARD_DEADLINE_MS = 1000

/** ILS iterations per start. Iteration cost grows with n, so the count shrinks. */
function ilsIterations(n: number): number {
  if (n <= 10) return 40
  if (n <= 20) return 25
  return 12
}

/**
 * Run single-swap local search on an assignment, improving it in-place.
 * Returns the final assignment and its cost.
 */
function localSearchImprove(
  bookOptions: BookOption[],
  assignment: Assignment,
  candidatesByBook: Array<Map<string, SellerOffer>>,
  hardDeadline: number = Infinity,
  twoSwap = true,
): { assignment: Assignment; cost: number } {
  const tracker = CostTracker.fromAssignment(bookOptions, assignment)

  let improved = true
  while (improved && Date.now() < hardDeadline) {
    improved = false

    for (let i = 0; i < bookOptions.length; i++) {
      const opt = bookOptions[i]
      const currentOffer = assignment.get(opt.item.id)
      if (!currentOffer) continue

      let bestOffer = currentOffer
      let bestCost = tracker.totalCost

      for (const [sellerId, offer] of candidatesByBook[i]) {
        if (sellerId === currentOffer.seller_id) continue

        tracker.removeOffer(currentOffer)
        tracker.addOffer(offer)

        if (tracker.totalCost < bestCost - 0.001) {
          bestCost = tracker.totalCost
          bestOffer = offer
        }

        tracker.removeOffer(offer)
        tracker.addOffer(currentOffer)
      }

      if (bestOffer !== currentOffer) {
        tracker.removeOffer(currentOffer)
        tracker.addOffer(bestOffer)
        assignment.set(opt.item.id, bestOffer)
        improved = true
      }
    }
  }

  // 2-swap pass: try swapping sellers for all pairs of assigned books
  if (twoSwap && bookOptions.length <= 30) {
    let twoSwapImproved = true
    while (twoSwapImproved && Date.now() < hardDeadline) {
      twoSwapImproved = false

      for (let i = 0; i < bookOptions.length; i++) {
        const optI = bookOptions[i]
        const offerI = assignment.get(optI.item.id)
        if (!offerI) continue

        for (let j = i + 1; j < bookOptions.length; j++) {
          const optJ = bookOptions[j]
          const offerJ = assignment.get(optJ.item.id)
          if (!offerJ) continue
          if (offerI.seller_id === offerJ.seller_id) continue

          // Try: book i goes to each of i's seller candidates, book j goes to each of j's
          const baseCost = tracker.totalCost
          let bestCostDelta = 0
          let bestOfferI: SellerOffer | null = null
          let bestOfferJ: SellerOffer | null = null

          // Remove both from current sellers
          tracker.removeOffer(offerI)
          tracker.removeOffer(offerJ)

          for (const [sidI, candI] of candidatesByBook[i]) {
            for (const [sidJ, candJ] of candidatesByBook[j]) {
              // Skip if this is the same as current assignment
              if (sidI === offerI.seller_id && sidJ === offerJ.seller_id) continue

              tracker.addOffer(candI)
              tracker.addOffer(candJ)

              const delta = tracker.totalCost - baseCost
              if (delta < bestCostDelta - 0.001) {
                bestCostDelta = delta
                bestOfferI = candI
                bestOfferJ = candJ
              }

              tracker.removeOffer(candI)
              tracker.removeOffer(candJ)
            }
          }

          // Restore original
          tracker.addOffer(offerI)
          tracker.addOffer(offerJ)

          if (bestOfferI && bestOfferJ) {
            // Commit the 2-swap
            tracker.removeOffer(offerI)
            tracker.removeOffer(offerJ)
            tracker.addOffer(bestOfferI)
            tracker.addOffer(bestOfferJ)
            assignment.set(optI.item.id, bestOfferI)
            assignment.set(optJ.item.id, bestOfferJ)
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
  candidatesByBook: Array<Map<string, SellerOffer>>,
  numPerturb: number,
  rand: Rand,
): Assignment {
  const result = new Map(assignment)
  const indices = bookOptions
    .map((_, i) => i)
    .filter((i) => candidatesByBook[i].size > 1 && result.has(bookOptions[i].item.id))

  const count = Math.min(numPerturb, indices.length)
  // Fisher-Yates partial shuffle
  for (let k = 0; k < count; k++) {
    const j = k + Math.floor(rand() * (indices.length - k))
    ;[indices[k], indices[j]] = [indices[j], indices[k]]
  }

  for (let k = 0; k < count; k++) {
    const i = indices[k]
    const opt = bookOptions[i]
    const currentSeller = result.get(opt.item.id)?.seller_id
    const candidates = Array.from(candidatesByBook[i].entries()).filter(([sid]) => sid !== currentSeller)
    if (candidates.length > 0) {
      const [, offer] = candidates[Math.floor(rand() * candidates.length)]
      result.set(opt.item.id, offer)
    }
  }

  return result
}

/**
 * Local search with multi-start and Iterated Local Search (ILS).
 * Starts from multiple greedy solutions (one deterministic, rest randomized),
 * applies single-swap local search, then perturbs and re-optimizes for a
 * fixed number of iterations per start. All randomness comes from a PRNG
 * seeded by the input, so identical inputs give identical results; a
 * wall-clock cap exists only as a serverless backstop.
 */
export function solveLocalSearch(bookOptions: BookOption[], seed?: number): Assignment {
  if (bookOptions.length === 0) return new Map()

  const rand = mulberry32(seed ?? seedFromBookOptions(bookOptions))

  // Top offers per book (offers are sorted by total_price + shipping_base)
  const candidatesByBook: Array<Map<string, SellerOffer>> = bookOptions.map((opt) => {
    const top = new Map<string, SellerOffer>()
    for (const [sellerId, offer] of opt.offers) {
      top.set(sellerId, offer)
      if (top.size >= MAX_CANDIDATES_PER_BOOK) break
    }
    return top
  })

  let bestAssignment: Assignment = new Map()
  let bestCost = Infinity
  const hardDeadline = Date.now() + HARD_DEADLINE_MS
  const iterations = ilsIterations(bookOptions.length)
  // The full 2-swap pass is quadratic in books × candidates; beyond a dozen
  // books it dominates runtime, so ILS iterations run single-swap only and
  // one 2-swap polish is applied to the winner at the end.
  const twoSwapInIls = bookOptions.length <= 12

  for (let start = 0; start < NUM_STARTS; start++) {
    // First start is deterministic greedy, rest are randomized
    const initial = solveGreedy(bookOptions, start === 0 ? 0 : 0.3, rand)
    let { assignment: current, cost: currentCost } = localSearchImprove(
      bookOptions, initial, candidatesByBook, hardDeadline, twoSwapInIls,
    )

    if (currentCost < bestCost) {
      bestCost = currentCost
      bestAssignment = new Map(current)
    }

    // ILS: perturb and re-optimize, a fixed iteration count per start
    for (let iter = 0; iter < iterations && Date.now() < hardDeadline; iter++) {
      const numPerturb = ILS_PERTURB_MIN + Math.floor(rand() * (ILS_PERTURB_MAX - ILS_PERTURB_MIN + 1))
      const perturbed = perturb(bookOptions, current, candidatesByBook, numPerturb, rand)
      const { assignment: candidate, cost: candidateCost } = localSearchImprove(
        bookOptions, perturbed, candidatesByBook, hardDeadline, twoSwapInIls,
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

  // Final 2-swap polish for mid-size carts that skipped it during ILS
  if (!twoSwapInIls) {
    const polished = localSearchImprove(
      bookOptions, new Map(bestAssignment), candidatesByBook, hardDeadline, true,
    )
    if (polished.cost < bestCost) {
      bestCost = polished.cost
      bestAssignment = polished.assignment
    }
  }

  return bestAssignment
}

export const localSearchStrategy: OptimizerStrategy = {
  name: 'local-search',
  solve(bookOptions: BookOption[]): Assignment {
    return solveLocalSearch(bookOptions)
  },
}
