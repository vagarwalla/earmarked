import type { CartItem, Listing, SellerGroup, OptimizationResult } from '../types'

export type { CartItem, Listing, SellerGroup, OptimizationResult }

export type BookOption = {
  item: CartItem
  listings: Listing[] // filtered by condition + price, sorted cheapest first
}

// item_id → chosen Listing
export type Assignment = Map<string, Listing>

export interface OptimizerStrategy {
  name: string
  solve(bookOptions: BookOption[]): Assignment
}

// AbeBooks standard US shipping
export function shippingCost(n: number, base = 3.99, perAdditional = 1.99): number {
  if (n <= 0) return 0
  return base + (n - 1) * perAdditional
}

export function computeTotalCost(bookOptions: BookOption[], assignment: Assignment): number {
  const sellerQty = new Map<string, number>()
  const sellerBookCost = new Map<string, number>()
  const sellerShippingBase = new Map<string, number>()
  const sellerShippingPerAdditional = new Map<string, number>()
  for (const { item } of bookOptions) {
    const l = assignment.get(item.id)
    if (!l) continue
    sellerQty.set(l.seller_id, (sellerQty.get(l.seller_id) ?? 0) + item.quantity)
    sellerBookCost.set(l.seller_id, (sellerBookCost.get(l.seller_id) ?? 0) + l.price * item.quantity)
    if (!sellerShippingBase.has(l.seller_id)) {
      sellerShippingBase.set(l.seller_id, l.shipping_base)
      sellerShippingPerAdditional.set(l.seller_id, l.shipping_per_additional)
    }
  }
  let cost = 0
  for (const [sid, bookCost] of sellerBookCost) {
    cost += bookCost + shippingCost(
      sellerQty.get(sid)!,
      sellerShippingBase.get(sid) ?? 3.99,
      sellerShippingPerAdditional.get(sid) ?? 1.99,
    )
  }
  return cost
}

export type SellerState = {
  qty: number
  bookCost: number
  shippingBase: number
  perAdditional: number
}

/**
 * Mutable cost tracker for incremental swap evaluation.
 * Maintains per-seller state and a running total cost so that
 * reassigning a single book is O(1) instead of O(n).
 */
export class CostTracker {
  sellers = new Map<string, SellerState>()
  totalCost = 0

  static fromAssignment(bookOptions: BookOption[], assignment: Assignment): CostTracker {
    const t = new CostTracker()
    for (const { item } of bookOptions) {
      const l = assignment.get(item.id)
      if (!l) continue
      t.addBook(l.seller_id, l.price, item.quantity, l.shipping_base, l.shipping_per_additional)
    }
    return t
  }

  private sellerCost(s: SellerState): number {
    return s.bookCost + shippingCost(s.qty, s.shippingBase, s.perAdditional)
  }

  addBook(sellerId: string, price: number, qty: number, shippingBase: number, perAdditional: number): void {
    const s = this.sellers.get(sellerId)
    if (s) {
      this.totalCost -= this.sellerCost(s)
      s.qty += qty
      s.bookCost += price * qty
      this.totalCost += this.sellerCost(s)
    } else {
      const ns: SellerState = { qty, bookCost: price * qty, shippingBase, perAdditional }
      this.sellers.set(sellerId, ns)
      this.totalCost += this.sellerCost(ns)
    }
  }

  removeBook(sellerId: string, price: number, qty: number): void {
    const s = this.sellers.get(sellerId)
    if (!s) return
    this.totalCost -= this.sellerCost(s)
    s.qty -= qty
    s.bookCost -= price * qty
    if (s.qty <= 0) {
      this.sellers.delete(sellerId)
    } else {
      this.totalCost += this.sellerCost(s)
    }
  }
}

/**
 * Count, for each seller, how many distinct cart books it can supply.
 * Sellers covering >= 2 books are "consolidation hubs" — buying multiple
 * books from them shares a single shipping fee.
 */
export function buildSellerCoverage(bookOptions: BookOption[]): Map<string, number> {
  const coverage = new Map<string, number>()
  for (const { listings } of bookOptions) {
    const seen = new Set<string>()
    for (const l of listings) {
      if (seen.has(l.seller_id)) continue
      seen.add(l.seller_id)
      coverage.set(l.seller_id, (coverage.get(l.seller_id) ?? 0) + 1)
    }
  }
  return coverage
}

export interface CandidateOptions {
  topKPerBook?: number // cheapest distinct sellers per book to always include
  maxHubs?: number // cap on number of multi-book hub sellers considered
  maxPerBook?: number // hard cap on candidates per book (bounds branching)
}

/**
 * Build the set of seller candidates each book should consider, as a map of
 * seller_id → cheapest qualifying listing for that book.
 *
 * Why this matters: picking only the per-book cheapest sellers misses the
 * single most valuable move in bundle optimization — consolidating many books
 * onto one seller to share shipping. A large seller that carries most of the
 * cart at moderate prices can rank outside every book's top-K cheapest yet be
 * the globally optimal choice. So we always union in "hub" sellers (those
 * covering >= 2 books).
 *
 * Correctness: in any optimal assignment, a book is bought either from a seller
 * holding only that book — in which case the per-book cheapest-by-total seller
 * is at least as good — or from a seller holding >= 2 books, which by
 * definition is a hub. Including the top cheapest sellers plus all hubs is
 * therefore sufficient to contain an optimal solution (subject to maxHubs,
 * which only bites in pathological carts with many highly-overlapping sellers).
 */
export function buildCandidatesByBook(
  bookOptions: BookOption[],
  { topKPerBook = 6, maxHubs = 10, maxPerBook = 18 }: CandidateOptions = {}
): Array<Map<string, Listing>> {
  const coverage = buildSellerCoverage(bookOptions)
  const hubSellers = [...coverage.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1]) // most coverage first
    .slice(0, maxHubs)
    .map(([sid]) => sid)

  return bookOptions.map((opt) => {
    // Cheapest listing per seller, in ascending total-cost order
    // (opt.listings is pre-sorted by price + shipping_base).
    const cheapestPerSeller = new Map<string, Listing>()
    for (const l of opt.listings) {
      if (!cheapestPerSeller.has(l.seller_id)) cheapestPerSeller.set(l.seller_id, l)
    }

    const result = new Map<string, Listing>()
    // 1. The top-K cheapest sellers for this book.
    for (const [sid, l] of cheapestPerSeller) {
      if (result.size >= topKPerBook) break
      result.set(sid, l)
    }
    // 2. Every hub seller that carries this book — even if priced above the
    //    top-K — because consolidating here may win on shipping.
    for (const sid of hubSellers) {
      if (result.size >= maxPerBook) break
      if (result.has(sid)) continue
      const l = cheapestPerSeller.get(sid)
      if (l) result.set(sid, l)
    }
    return result
  })
}

export function buildBookOptions(
  items: CartItem[],
  listingsByIsbn: Map<string, Listing[]>
): BookOption[] {
  return items.map((item) => {
    // Always include isbn_preferred; isbns_candidates may be [] (not null) so can't rely on ?? alone
    const candidateIsbns = [...new Set([
      ...(item.isbn_preferred ? [item.isbn_preferred] : []),
      ...(item.isbns_candidates ?? []),
    ])]
    const rawListings = candidateIsbns.flatMap((isbn) => listingsByIsbn.get(isbn) ?? [])
    const qualified = rawListings.filter(
      (l) =>
        (item.conditions ?? []).includes(l.condition_normalized) &&
        (item.max_price == null || l.price <= item.max_price) &&
        (item.signed_only == null || (item.signed_only ? l.signed : !l.signed)) &&
        (item.first_edition_only == null || (item.first_edition_only ? l.first_edition : !l.first_edition)) &&
        (item.dust_jacket_only == null || (item.dust_jacket_only ? l.dust_jacket : !l.dust_jacket))
    )
    // Sort by total standalone cost (price + shipping_base) so candidate selection
    // in all strategies considers actual cost, not just book price.
    return { item, listings: qualified.sort((a, b) => (a.price + a.shipping_base) - (b.price + b.shipping_base)) }
  })
}

export function buildGroups(bookOptions: BookOption[], assignment: Assignment): SellerGroup[] {
  const groupMap = new Map<string, SellerGroup>()
  for (const [itemId, listing] of assignment) {
    const opt = bookOptions.find((b) => b.item.id === itemId)!
    if (!groupMap.has(listing.seller_id)) {
      groupMap.set(listing.seller_id, {
        seller_id: listing.seller_id,
        seller_name: listing.seller_name,
        assignments: [],
        books_subtotal: 0,
        shipping: 0,
        group_total: 0,
      })
    }
    const group = groupMap.get(listing.seller_id)!
    const qty = opt.item.quantity
    group.assignments.push({ item: opt.item, listing, quantity: qty, subtotal: listing.price * qty })
    group.books_subtotal += listing.price * qty
  }

  const groups: SellerGroup[] = []
  for (const group of groupMap.values()) {
    const totalQty = group.assignments.reduce((s, a) => s + a.quantity, 0)
    group.shipping = shippingCost(
      totalQty,
      group.assignments[0]?.listing.shipping_base ?? 3.99,
      group.assignments[0]?.listing.shipping_per_additional ?? 1.99,
    )
    group.group_total = group.books_subtotal + group.shipping
    groups.push(group)
  }
  return groups
}
