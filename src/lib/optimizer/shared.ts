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
