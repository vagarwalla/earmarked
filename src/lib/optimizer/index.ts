import type { CartItem, Listing, OptimizationResult } from '../types'
import type { OptimizerStrategy } from './shared'
import { buildBookOptions, buildGroups, shippingCost } from './shared'
import { greedyStrategy } from './strategies/greedy'
import { localSearchStrategy } from './strategies/local-search'
import { exactStrategy } from './strategies/exact'

export type { OptimizerStrategy }
export { greedyStrategy, localSearchStrategy, exactStrategy }

// Exact is optimal but only practical up to ~12 books given the branching factor.
// Incremental state tracking makes this feasible. Beyond that, local search
// (multi-start + ILS from greedy) is near-optimal and fast.
const EXACT_BOOK_LIMIT = 12

function autoSelectStrategy(itemCount: number): OptimizerStrategy {
  return itemCount <= EXACT_BOOK_LIMIT ? exactStrategy : localSearchStrategy
}

export function optimize(
  items: CartItem[],
  listingsByIsbn: Map<string, Listing[]>,
  strategy?: OptimizerStrategy
): OptimizationResult {
  const bookOptions = buildBookOptions(items, listingsByIsbn)
  const chosen = strategy ?? autoSelectStrategy(items.length)
  const assignment = chosen.solve(bookOptions)
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
