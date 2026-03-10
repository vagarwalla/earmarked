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
  for (const { item } of bookOptions) {
    const l = assignment.get(item.id)
    if (!l) continue
    sellerQty.set(l.seller_id, (sellerQty.get(l.seller_id) ?? 0) + item.quantity)
    sellerBookCost.set(l.seller_id, (sellerBookCost.get(l.seller_id) ?? 0) + l.price * item.quantity)
  }
  let cost = 0
  for (const [sid, bookCost] of sellerBookCost) {
    cost += bookCost + shippingCost(sellerQty.get(sid)!)
  }
  return cost
}

export function buildBookOptions(
  items: CartItem[],
  listingsByIsbn: Map<string, Listing[]>
): BookOption[] {
  return items.map((item) => {
    const candidateIsbns = item.isbns_candidates ?? (item.isbn_preferred ? [item.isbn_preferred] : [])
    const rawListings = candidateIsbns.flatMap((isbn) => listingsByIsbn.get(isbn) ?? [])
    const qualified = rawListings.filter(
      (l) =>
        (item.conditions ?? []).includes(l.condition_normalized) &&
        (item.max_price == null || l.price <= item.max_price)
    )
    return { item, listings: qualified.sort((a, b) => a.price - b.price) }
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
    group.shipping = shippingCost(totalQty, group.assignments[0]?.listing.shipping_base ?? 3.99)
    group.group_total = group.books_subtotal + group.shipping
    groups.push(group)
  }
  return groups
}
