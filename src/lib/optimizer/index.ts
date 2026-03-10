import type { CartItem, Listing, OptimizationResult } from '../types'
import type { OptimizerStrategy } from './shared'
import { buildBookOptions, buildGroups } from './shared'
import { greedyStrategy } from './strategies/greedy'
import { localSearchStrategy } from './strategies/local-search'
import { exactStrategy } from './strategies/exact'

export type { OptimizerStrategy }
export { greedyStrategy, localSearchStrategy, exactStrategy }

// Exact is optimal but only practical up to ~10 books given the branching factor.
// Beyond that, local search (which starts from greedy) is near-optimal and fast.
const EXACT_BOOK_LIMIT = 10

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

  // Naive baseline: each book bought separately at cheapest price + $3.99 shipping
  const naive_total = bookOptions.reduce((sum, { item, listings }) => {
    if (listings.length === 0) return sum
    return sum + (listings[0].price + 3.99) * item.quantity
  }, 0)

  return {
    groups: groups.sort((a, b) => b.assignments.length - a.assignments.length),
    grand_total,
    naive_total,
    savings: Math.max(0, naive_total - grand_total),
  }
}
