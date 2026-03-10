import type { OptimizerStrategy, BookOption, Assignment } from '../shared'
import { shippingCost } from '../shared'

/**
 * Greedy strategy: scores sellers by how many books they carry, then assigns
 * books to the top-scoring seller first. Fast (O(n²)) but not optimal — it
 * optimises for grouping rather than total cost, so it can miss cheaper splits.
 */
export const greedyStrategy: OptimizerStrategy = {
  name: 'greedy',

  solve(bookOptions: BookOption[]): Assignment {
    // Build seller catalog: seller_id → cheapest listing per item_id
    const sellerCatalog = new Map<string, { name: string; catalog: Map<string, import('../shared').Listing> }>()
    for (const { item, listings } of bookOptions) {
      for (const listing of listings) {
        if (!sellerCatalog.has(listing.seller_id)) {
          sellerCatalog.set(listing.seller_id, { name: listing.seller_name, catalog: new Map() })
        }
        const seller = sellerCatalog.get(listing.seller_id)!
        if (!seller.catalog.has(item.id)) seller.catalog.set(item.id, listing) // first = cheapest
      }
    }

    const assignment: Assignment = new Map()
    const unassigned = new Set(bookOptions.map((b) => b.item.id))

    // Score each seller by book count (desc), then total cost (asc)
    const sellerScores = Array.from(sellerCatalog.entries())
      .map(([sellerId, { catalog }]) => {
        const ids = Array.from(unassigned).filter((id) => catalog.has(id))
        const totalBookCost = ids.reduce((s, id) => s + (catalog.get(id)?.price ?? 0), 0)
        return { sellerId, bookCount: ids.length, score: totalBookCost + shippingCost(ids.length) }
      })
      .sort((a, b) => b.bookCount !== a.bookCount ? b.bookCount - a.bookCount : a.score - b.score)

    // Assign books to sellers greedily (only if seller has ≥ 2 books)
    for (const { sellerId } of sellerScores) {
      const seller = sellerCatalog.get(sellerId)!
      const booksForSeller = Array.from(unassigned).filter((id) => seller.catalog.has(id))
      if (booksForSeller.length >= 2) {
        for (const itemId of booksForSeller) {
          assignment.set(itemId, seller.catalog.get(itemId)!)
          unassigned.delete(itemId)
        }
      }
    }

    // Remaining unassigned → globally cheapest qualifying listing
    for (const itemId of unassigned) {
      const opt = bookOptions.find((b) => b.item.id === itemId)!
      if (opt.listings.length > 0) assignment.set(itemId, opt.listings[0])
    }

    return assignment
  },
}
