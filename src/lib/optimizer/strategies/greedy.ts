import type { OptimizerStrategy, BookOption, Assignment, SellerOffer } from '../shared'
import { shippingCost } from '../shared'
import type { Rand } from '../rng'

/**
 * Core greedy solver. When randomness > 0, picks from the top sellers
 * with probability weighted by score (for multi-start diversification).
 * Pass a seeded `rand` for deterministic results.
 */
export function solveGreedy(bookOptions: BookOption[], randomness = 0, rand: Rand = Math.random): Assignment {
  // Seller catalog: seller_id → offer per item + shipping info
  const sellerCatalog = new Map<string, {
    catalog: Map<string, SellerOffer>
    shippingBase: number
    perAdditional: number
  }>()
  for (const { item, offers } of bookOptions) {
    for (const [sellerId, offer] of offers) {
      let seller = sellerCatalog.get(sellerId)
      if (!seller) {
        seller = { catalog: new Map(), shippingBase: offer.shipping_base, perAdditional: offer.shipping_per_additional }
        sellerCatalog.set(sellerId, seller)
      }
      seller.catalog.set(item.id, offer)
    }
  }

  const assignment: Assignment = new Map()
  const unassigned = new Set(bookOptions.map((b) => b.item.id))
  const sellerAssignedUnits = new Map<string, number>()

  while (unassigned.size > 0) {
    const scored: Array<{ sellerId: string; score: number; bookIds: string[] }> = []

    for (const [sellerId, seller] of sellerCatalog) {
      const ids: string[] = []
      let totalBookCost = 0
      let newUnits = 0
      for (const [itemId, offer] of seller.catalog) {
        if (!unassigned.has(itemId)) continue
        ids.push(itemId)
        totalBookCost += offer.total_price
        newUnits += offer.listings.length
      }
      if (ids.length === 0) continue

      const existingUnits = sellerAssignedUnits.get(sellerId) ?? 0
      const marginalShipping = existingUnits > 0
        ? shippingCost(existingUnits + newUnits, seller.shippingBase, seller.perAdditional) -
          shippingCost(existingUnits, seller.shippingBase, seller.perAdditional)
        : shippingCost(newUnits, seller.shippingBase, seller.perAdditional)

      scored.push({ sellerId, score: (totalBookCost + marginalShipping) / ids.length, bookIds: ids })
    }

    if (scored.length === 0) break

    scored.sort((a, b) => a.score - b.score)

    // Pick seller: deterministic (best) or randomized from top candidates
    let pick = scored[0]
    if (randomness > 0 && scored.length > 1) {
      const topK = Math.min(scored.length, Math.max(2, Math.ceil(scored.length * 0.4)))
      const candidates = scored.slice(0, topK)
      // Inverse-score weighting: lower score = higher weight
      const maxScore = candidates[candidates.length - 1].score
      const weights = candidates.map((c) => Math.max(0.1, maxScore - c.score + 1))
      const totalWeight = weights.reduce((s, w) => s + w, 0)
      let r = rand() * totalWeight
      for (let j = 0; j < candidates.length; j++) {
        r -= weights[j]
        if (r <= 0) { pick = candidates[j]; break }
      }
    }

    const seller = sellerCatalog.get(pick.sellerId)!
    for (const itemId of pick.bookIds) {
      const offer = seller.catalog.get(itemId)!
      assignment.set(itemId, offer)
      unassigned.delete(itemId)
      sellerAssignedUnits.set(pick.sellerId, (sellerAssignedUnits.get(pick.sellerId) ?? 0) + offer.listings.length)
    }
  }

  return assignment
}

/**
 * Greedy strategy: iteratively assigns books to the seller offering the best
 * marginal cost (considering grouping benefits from shared shipping).
 */
export const greedyStrategy: OptimizerStrategy = {
  name: 'greedy',
  solve(bookOptions: BookOption[]): Assignment {
    return solveGreedy(bookOptions, 0)
  },
}
