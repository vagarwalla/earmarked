import type { CartItem, Listing, OptimizationResult } from '../types'
import type { BookOption } from './shared'
import { buildBookOptions, makeBookOption } from './shared'
import { optimizeBookOptions } from './index'

export type OptimizeSource = 'abe' | 'thriftbooks' | 'bwb'
export const SINGLE_SOURCES: OptimizeSource[] = ['abe', 'thriftbooks', 'bwb']

export type BatchOptimizeResult = {
  best: OptimizationResult
  abe: OptimizationResult
  thriftbooks: OptimizationResult
  bwb: OptimizationResult
  combined: OptimizationResult
}

/** Derive the source store from a seller_id. */
export function getSellerSource(sellerId: string): OptimizeSource {
  if (sellerId === 'thriftbooks') return 'thriftbooks'
  if (sellerId === 'betterworldbooks') return 'bwb'
  return 'abe'
}

function filterBySource(bookOptions: BookOption[], src: OptimizeSource): BookOption[] {
  // Filtering preserves the cheapest-first sort; offers are rebuilt from the
  // narrowed listing set (qualification itself is not re-run).
  return bookOptions.map(({ item, listings }) =>
    makeBookOption(item, listings.filter((l) => getSellerSource(l.seller_id) === src)))
}

/**
 * Optimize all source views in one pass. Listings are qualified once
 * (buildBookOptions) and partitioned per source, instead of each view
 * re-filtering and re-qualifying the full pool.
 *
 * The combined view is guaranteed to be at least as good as every
 * single-source view: any single-source assignment is feasible in the
 * combined space, so if a heuristic combined run comes out worse than a
 * single-source result with the same coverage, that result is adopted.
 * `best` aliases `combined`.
 */
export function runBatchOptimize(
  items: CartItem[],
  listingsByIsbn: Map<string, Listing[]>,
): BatchOptimizeResult {
  const qualified = buildBookOptions(items, listingsByIsbn)

  const perSource = {} as Record<OptimizeSource, OptimizationResult>
  for (const src of SINGLE_SOURCES) {
    perSource[src] = optimizeBookOptions(filterBySource(qualified, src))
  }

  let combined = optimizeBookOptions(qualified)
  for (const src of SINGLE_SOURCES) {
    const single = perSource[src]
    // Same unassigned count implies identical coverage (single-source
    // coverage is a subset of combined coverage), so totals are comparable.
    if (
      single.unassigned.length === combined.unassigned.length &&
      single.grand_total < combined.grand_total - 1e-9
    ) {
      combined = single
    }
  }

  return {
    best: combined,
    abe: perSource.abe,
    thriftbooks: perSource.thriftbooks,
    bwb: perSource.bwb,
    combined,
  }
}
