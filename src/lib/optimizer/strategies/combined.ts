import type { CartItem, Listing, OptimizationResult } from '../../types'
import { optimize } from '../index'

export { getSellerSource } from '../batch'

/**
 * Runs the optimizer across ALL sources pooled together (AbeBooks + ThriftBooks + BWB).
 * The optimizer freely assigns each book to whichever seller — from any source —
 * yields the lowest total cost, including bundled shipping.
 *
 * Prefer runBatchOptimize (optimizer/batch.ts) when the per-source views are
 * also needed: it qualifies listings once and guarantees combined ≤ single-source.
 */
export function runCombinedOptimizer(
  items: CartItem[],
  listingsByIsbn: Map<string, Listing[]>,
): OptimizationResult {
  return optimize(items, listingsByIsbn)
}
