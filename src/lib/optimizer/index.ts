import type { CartItem, Listing, OptimizationResult } from '../types'
import type { Assignment, BookOption, OptimizerStrategy } from './shared'
import { buildBookOptions, buildGroups, shippingCost } from './shared'
import { greedyStrategy } from './strategies/greedy'
import { localSearchStrategy, solveLocalSearch } from './strategies/local-search'
import { exactStrategy, solveExact } from './strategies/exact'

export type { OptimizerStrategy }
export { greedyStrategy, localSearchStrategy, exactStrategy }

// Exact refinement is gated on an estimate of its search-space size (product
// of per-book candidate counts, computed in log space). Estimates above this
// are hopeless to prove optimal, so the local-search answer stands alone.
// The node budget inside solveExact is the hard backstop either way.
const EXACT_GATE_MAX_LOG_NODES = Math.log(1e7)
// Same cap solveExact applies per book — the estimate must match its space.
const EXACT_CANDIDATES_PER_BOOK = 6

function exactSearchLogNodes(bookOptions: BookOption[]): number {
  let logNodes = 0
  for (const { listings } of bookOptions) {
    const sellers = new Set<string>()
    for (const l of listings) {
      sellers.add(l.seller_id)
      if (sellers.size >= EXACT_CANDIDATES_PER_BOOK) break
    }
    if (sellers.size > 1) logNodes += Math.log(sellers.size)
  }
  return logNodes
}

/**
 * Default solve order:
 *   1. Seeded local search — cheap, bounded, deterministic.
 *   2. If the exact search space is small enough, refine with warm-started
 *      branch-and-bound. The warm start makes the result never worse than
 *      local search, even when the node budget aborts the search.
 */
function solveAuto(bookOptions: BookOption[]): Assignment {
  const ls = solveLocalSearch(bookOptions)
  if (exactSearchLogNodes(bookOptions) > EXACT_GATE_MAX_LOG_NODES) return ls
  return solveExact(bookOptions, { warmStart: ls })
}

export function optimize(
  items: CartItem[],
  listingsByIsbn: Map<string, Listing[]>,
  strategy?: OptimizerStrategy
): OptimizationResult {
  return optimizeBookOptions(buildBookOptions(items, listingsByIsbn), strategy)
}

/**
 * Optimize pre-built book options. Lets callers qualify listings once and
 * reuse/partition the result (see optimizer/batch.ts) instead of re-running
 * buildBookOptions per source view.
 */
export function optimizeBookOptions(
  bookOptions: BookOption[],
  strategy?: OptimizerStrategy
): OptimizationResult {
  const assignment = strategy ? strategy.solve(bookOptions) : solveAuto(bookOptions)
  const groups = buildGroups(bookOptions, assignment)

  const grand_total = groups.reduce((s, g) => s + g.group_total, 0)

  const unassigned = bookOptions
    .filter(({ item }) => !assignment.has(item.id))
    .map(({ item }) => item)

  // Naive baseline: each book bought as its own order at the cheapest total cost.
  // listings[0] is cheapest by total cost after buildBookOptions sorts by price + shipping_base.
  // One order per book: qty units share a single shipping charge.
  const naive_total = bookOptions.reduce((sum, { item, listings }) => {
    if (listings.length === 0) return sum
    const l = listings[0]
    return sum + l.price * item.quantity + shippingCost(item.quantity, l.shipping_base, l.shipping_per_additional)
  }, 0)

  return {
    groups: groups.sort((a, b) => b.assignments.length - a.assignments.length),
    unassigned,
    grand_total,
    naive_total,
    savings: Math.max(0, naive_total - grand_total),
  }
}
