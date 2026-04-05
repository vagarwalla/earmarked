import type { OptimizerStrategy, BookOption, Assignment, Listing } from '../shared'
import { shippingCost } from '../shared'

/**
 * Core greedy solver. When randomness > 0, picks from the top sellers
 * with probability weighted by score (for multi-start diversification).
 */
export function solveGreedy(bookOptions: BookOption[], randomness = 0): Assignment {
  // Build seller catalog: seller_id → cheapest listing per item_id + shipping info
  const sellerCatalog = new Map<string, {
    name: string
    catalog: Map<string, Listing>
    shippingBase: number
    perAdditional: number
  }>()
  for (const { item, listings } of bookOptions) {
    for (const listing of listings) {
      if (!sellerCatalog.has(listing.seller_id)) {
        sellerCatalog.set(listing.seller_id, {
          name: listing.seller_name,
          catalog: new Map(),
          shippingBase: listing.shipping_base,
          perAdditional: listing.shipping_per_additional,
        })
      }
      const seller = sellerCatalog.get(listing.seller_id)!
      if (!seller.catalog.has(item.id)) seller.catalog.set(item.id, listing) // first = cheapest
    }
  }

  const assignment: Assignment = new Map()
  const unassigned = new Set(bookOptions.map((b) => b.item.id))
  const sellerAssignedQty = new Map<string, number>()

  while (unassigned.size > 0) {
    const scored: Array<{ sellerId: string; score: number; bookIds: string[] }> = []

    for (const [sellerId, seller] of sellerCatalog) {
      const ids = Array.from(unassigned).filter((id) => seller.catalog.has(id))
      if (ids.length === 0) continue

      const opts = ids.map((id) => bookOptions.find((b) => b.item.id === id)!)
      const totalBookCost = ids.reduce((s, id, i) => s + seller.catalog.get(id)!.price * opts[i].item.quantity, 0)
      const newUnits = opts.reduce((s, o) => s + o.item.quantity, 0)
      const existingQty = sellerAssignedQty.get(sellerId) ?? 0

      const marginalShipping = existingQty > 0
        ? shippingCost(existingQty + newUnits, seller.shippingBase, seller.perAdditional) -
          shippingCost(existingQty, seller.shippingBase, seller.perAdditional)
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
      let r = Math.random() * totalWeight
      for (let j = 0; j < candidates.length; j++) {
        r -= weights[j]
        if (r <= 0) { pick = candidates[j]; break }
      }
    }

    const seller = sellerCatalog.get(pick.sellerId)!
    for (const itemId of pick.bookIds) {
      const listing = seller.catalog.get(itemId)!
      const qty = bookOptions.find((b) => b.item.id === itemId)!.item.quantity
      assignment.set(itemId, listing)
      unassigned.delete(itemId)
      sellerAssignedQty.set(pick.sellerId, (sellerAssignedQty.get(pick.sellerId) ?? 0) + qty)
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
