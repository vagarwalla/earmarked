import type { CartItem, Listing, SellerGroup, OptimizationResult } from './types'

// AbeBooks standard US shipping estimate
function shippingCost(n: number, base = 3.99, perAdditional = 1.99): number {
  if (n <= 0) return 0
  return base + (n - 1) * perAdditional
}

export function optimize(
  items: CartItem[],
  listingsByIsbn: Map<string, Listing[]>
): OptimizationResult {
  // Step 1: For each cart item, get all qualifying listings
  // (condition >= min, filtered by format if not flexible)
  type BookOption = {
    item: CartItem
    listings: Listing[] // already filtered
  }

  const bookOptions: BookOption[] = items.map((item) => {
    const rawListings = item.isbn_preferred
      ? listingsByIsbn.get(item.isbn_preferred) || []
      : []
    const qualified = rawListings.filter((l) =>
      (item.conditions ?? []).includes(l.condition_normalized) &&
      (item.max_price == null || l.price <= item.max_price)
    )
    return { item, listings: qualified.sort((a, b) => a.price - b.price) }
  })

  // Step 2: Build seller catalog: seller_id -> Map<item_id, cheapest_listing>
  type SellerCatalog = Map<string, { name: string; catalog: Map<string, Listing> }>
  const sellerCatalog: SellerCatalog = new Map()

  for (const { item, listings } of bookOptions) {
    for (const listing of listings) {
      if (!sellerCatalog.has(listing.seller_id)) {
        sellerCatalog.set(listing.seller_id, {
          name: listing.seller_name,
          catalog: new Map(),
        })
      }
      const seller = sellerCatalog.get(listing.seller_id)!
      if (!seller.catalog.has(item.id)) {
        seller.catalog.set(item.id, listing) // first = cheapest (already sorted)
      }
    }
  }

  // Step 3: Greedy assignment
  // Score each seller by: (count of books they have) - shipping_overhead
  // We want to find an assignment that minimizes total cost

  const assignment = new Map<string, { item: CartItem; listing: Listing }>()
  // item_id -> {item, listing}

  // Track which items are unassigned
  const unassigned = new Set(items.map((i) => i.id))

  // Try to find dominant sellers (ones with many books)
  const sellerScores = Array.from(sellerCatalog.entries())
    .map(([sellerId, { name, catalog }]) => {
      const bookCount = Array.from(unassigned).filter((id) => catalog.has(id)).length
      // Compute total book cost if we bought everything from this seller
      const totalBookCost = Array.from(unassigned)
        .filter((id) => catalog.has(id))
        .reduce((sum, id) => sum + (catalog.get(id)?.price || 0), 0)
      const shipping = shippingCost(bookCount)
      return { sellerId, name, bookCount, totalBookCost, shipping, score: totalBookCost + shipping }
    })
    .sort((a, b) => {
      // Prefer sellers with more books and lower total cost
      if (b.bookCount !== a.bookCount) return b.bookCount - a.bookCount
      return a.score - b.score
    })

  // Greedy: assign books to sellers starting from best seller
  for (const { sellerId, name: _name } of sellerScores) {
    const seller = sellerCatalog.get(sellerId)!
    const booksForSeller: string[] = []

    for (const itemId of unassigned) {
      if (seller.catalog.has(itemId)) {
        booksForSeller.push(itemId)
      }
    }

    if (booksForSeller.length === 0) continue

    // Check: is it cheaper to buy these books from this seller vs individually?
    // For the greedy pass, just assign if seller has >= 2 books OR no other option
    if (booksForSeller.length >= 2) {
      for (const itemId of booksForSeller) {
        const item = items.find((i) => i.id === itemId)!
        const listing = seller.catalog.get(itemId)!
        assignment.set(itemId, { item, listing })
        unassigned.delete(itemId)
      }
    }
  }

  // Remaining unassigned: assign to globally cheapest listing.
  // Fall back to raw (unfiltered) listings as an estimate if no condition-filtered ones exist.
  for (const itemId of unassigned) {
    const bookOpt = bookOptions.find((b) => b.item.id === itemId)!
    let listingsToUse = bookOpt.listings
    if (listingsToUse.length === 0 && bookOpt.item.isbn_preferred) {
      const raw = listingsByIsbn.get(bookOpt.item.isbn_preferred) ?? []
      listingsToUse = [...raw].sort((a, b) => a.price - b.price)
    }
    if (listingsToUse.length > 0) {
      assignment.set(itemId, { item: bookOpt.item, listing: listingsToUse[0] })
    }
  }

  // Step 4: Build seller groups from assignment
  const groupMap = new Map<string, SellerGroup>()

  for (const [, { item, listing }] of assignment) {
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
    const qty = item.quantity
    const subtotal = listing.price * qty
    group.assignments.push({ item, listing, quantity: qty, subtotal })
    group.books_subtotal += subtotal
  }

  // Step 5: Calculate shipping per group
  const groups: SellerGroup[] = []
  for (const group of groupMap.values()) {
    const totalQty = group.assignments.reduce((s, a) => s + a.quantity, 0)
    group.shipping = shippingCost(totalQty, group.assignments[0]?.listing.shipping_base || 3.99)
    group.group_total = group.books_subtotal + group.shipping
    groups.push(group)
  }

  // Items with no listings: unresolved
  const grand_total = groups.reduce((s, g) => s + g.group_total, 0)

  // Naive total: each book at cheapest available price + $3.99 shipping each
  const naive_total = bookOptions.reduce((sum, { item, listings }) => {
    if (listings.length === 0) return sum
    return sum + (listings[0].price + 3.99) * item.quantity
  }, 0)

  const savings = Math.max(0, naive_total - grand_total)

  return {
    groups: groups.sort((a, b) => b.assignments.length - a.assignments.length),
    grand_total,
    naive_total,
    savings,
  }
}
