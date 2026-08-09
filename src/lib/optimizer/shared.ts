import type { CartItem, Condition, Listing, SellerGroup, OptimizationResult } from '../types'

export type { CartItem, Listing, SellerGroup, OptimizationResult }

/**
 * Single source of truth for "does this listing satisfy this item's filters".
 * Tri-state booleans follow types.ts: null = any, true = require, false = exclude.
 * `conditions`/`maxPrice` default to the item's own values but can be overridden
 * (the relaxation engine probes with expanded conditions / lifted price caps).
 */
export function listingQualifies(
  item: CartItem,
  l: Listing,
  conditions: Condition[] = item.conditions ?? [],
  maxPrice: number | null = item.max_price,
): boolean {
  return (
    conditions.includes(l.condition_normalized) &&
    (maxPrice == null || l.price <= maxPrice) &&
    (item.signed_only == null || (item.signed_only ? l.signed : !l.signed)) &&
    (item.first_edition_only == null || (item.first_edition_only ? l.first_edition : !l.first_edition)) &&
    (item.dust_jacket_only == null || (item.dust_jacket_only ? l.dust_jacket : !l.dust_jacket))
  )
}

/**
 * A seller's concrete offer to supply an item's full quantity:
 * the exact unit listings to buy and their summed price.
 */
export type SellerOffer = {
  seller_id: string
  seller_name: string
  /** One entry per unit; retailers repeat their stocked listing. */
  listings: Listing[]
  total_price: number
  /** Highest base quoted by this offer's unit listings — see combineShipping. */
  shipping_base: number
  shipping_per_additional: number
}

/**
 * Shipping terms are quoted PER LISTING (AbeBooks returns a shipping cost on
 * every copy, frequently $0 for free-shipping listings), but an order from one
 * seller is charged once. Combining terms therefore has to pick a single base
 * for the order, and the only safe choice is the highest quoted base: taking a
 * lower one claims a discount the seller never offered, and taking "whichever
 * listing we saw first" makes the total depend on cart ordering.
 *
 * max() is associative and commutative, so a group's terms are the same however
 * its listings are ordered or incrementally added and removed.
 */
export function combineShippingBase(a: number, b: number): number {
  return a > b ? a : b
}

function maxShippingBase(listings: Listing[]): number {
  let m = 0
  for (const l of listings) if (l.shipping_base > m) m = l.shipping_base
  return m
}

function maxShippingPerAdditional(listings: Listing[]): number {
  let m = 0
  for (const l of listings) if (l.shipping_per_additional > m) m = l.shipping_per_additional
  return m
}

export type BookOption = {
  item: CartItem
  /** All qualifying listings, sorted by unit price + shipping_base. */
  listings: Listing[]
  /** Fulfillable offers per seller, sorted by total_price + shipping_base. */
  offers: Map<string, SellerOffer>
}

// item_id → chosen SellerOffer
export type Assignment = Map<string, SellerOffer>

export interface OptimizerStrategy {
  name: string
  solve(bookOptions: BookOption[]): Assignment
}

// Direct retailers hold stock: one listing can supply any quantity.
// Marketplace (AbeBooks) listings are single copies.
const RETAILER_SELLER_IDS = new Set(['thriftbooks', 'betterworldbooks'])

/**
 * Build per-seller offers for an item. A marketplace seller must have
 * `quantity` distinct listings to qualify (its offer is the n cheapest);
 * a retailer fulfills any quantity from its cheapest listing.
 */
export function buildSellerOffers(item: CartItem, qualified: Listing[]): Map<string, SellerOffer> {
  const qty = item.quantity
  const bySeller = new Map<string, Listing[]>()
  for (const l of qualified) {
    const arr = bySeller.get(l.seller_id)
    if (arr) arr.push(l)
    else bySeller.set(l.seller_id, [l])
  }
  const offers: Array<[string, SellerOffer]> = []
  for (const [sellerId, ls] of bySeller) {
    let units: Listing[]
    if (RETAILER_SELLER_IDS.has(sellerId)) {
      units = new Array(qty).fill(ls[0])
    } else {
      if (ls.length < qty) continue // seller can't supply the full quantity
      units = ls.slice(0, qty) // n cheapest distinct copies
    }
    offers.push([sellerId, {
      seller_id: sellerId,
      seller_name: ls[0].seller_name,
      listings: units,
      total_price: units.reduce((s, l) => s + l.price, 0),
      // Terms for the units actually bought, not for the seller's cheapest listing
      shipping_base: maxShippingBase(units),
      shipping_per_additional: maxShippingPerAdditional(units),
    }])
  }
  offers.sort((a, b) =>
    (a[1].total_price + a[1].shipping_base) - (b[1].total_price + b[1].shipping_base))
  return new Map(offers)
}

/** Construct a BookOption from an item and its qualified, sorted listings. */
export function makeBookOption(item: CartItem, qualified: Listing[]): BookOption {
  return { item, listings: qualified, offers: buildSellerOffers(item, qualified) }
}

// AbeBooks standard US shipping
export function shippingCost(n: number, base = 3.99, perAdditional = 1.99): number {
  if (n <= 0) return 0
  return base + (n - 1) * perAdditional
}

export function computeTotalCost(bookOptions: BookOption[], assignment: Assignment): number {
  const sellerUnits = new Map<string, number>()
  const sellerBookCost = new Map<string, number>()
  const sellerShippingBase = new Map<string, number>()
  const sellerShippingPerAdditional = new Map<string, number>()
  for (const { item } of bookOptions) {
    const offer = assignment.get(item.id)
    if (!offer) continue
    sellerUnits.set(offer.seller_id, (sellerUnits.get(offer.seller_id) ?? 0) + offer.listings.length)
    sellerBookCost.set(offer.seller_id, (sellerBookCost.get(offer.seller_id) ?? 0) + offer.total_price)
    // Highest quoted terms win for the order, independent of iteration order
    sellerShippingBase.set(offer.seller_id,
      combineShippingBase(sellerShippingBase.get(offer.seller_id) ?? 0, offer.shipping_base))
    sellerShippingPerAdditional.set(offer.seller_id,
      combineShippingBase(sellerShippingPerAdditional.get(offer.seller_id) ?? 0, offer.shipping_per_additional))
  }
  let cost = 0
  for (const [sid, bookCost] of sellerBookCost) {
    cost += bookCost + shippingCost(
      sellerUnits.get(sid)!,
      sellerShippingBase.get(sid)!,
      sellerShippingPerAdditional.get(sid)!,
    )
  }
  return cost
}

/**
 * Multiset of quoted values whose maximum survives add/remove in any order.
 * Needed because incremental search adds and removes offers constantly, and
 * dropping the offer that quoted the highest base must restore the previous
 * highest — not leave the seller charging a base nothing in the order quotes.
 */
class MaxBag {
  max = 0
  // Nearly every seller quotes one distinct base across an order, and this sits
  // in the branch-and-bound inner loop, so the single-value case stays
  // allocation-free; the Map is only created once a second value appears.
  private soleValue = 0
  private soleCount = 0
  private counts: Map<number, number> | null = null

  add(v: number): void {
    if (this.counts === null) {
      if (this.soleCount === 0) {
        this.soleValue = v
        this.soleCount = 1
        this.max = v
        return
      }
      if (v === this.soleValue) {
        this.soleCount++
        return
      }
      this.counts = new Map([[this.soleValue, this.soleCount]])
      this.soleCount = 0
    }
    this.counts.set(v, (this.counts.get(v) ?? 0) + 1)
    if (v > this.max) this.max = v
  }

  remove(v: number): void {
    if (this.counts === null) {
      if (this.soleCount > 0 && v === this.soleValue && --this.soleCount === 0) this.max = 0
      return
    }
    const c = this.counts.get(v)
    if (c === undefined) return
    if (c > 1) {
      this.counts.set(v, c - 1)
      return
    }
    this.counts.delete(v)
    if (v < this.max) return
    let m = 0
    for (const k of this.counts.keys()) if (k > m) m = k
    this.max = m
  }
}

export type SellerState = {
  qty: number
  bookCost: number
  bases: MaxBag
  perAdditionals: MaxBag
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
      const offer = assignment.get(item.id)
      if (!offer) continue
      t.addOffer(offer)
    }
    return t
  }

  private sellerCost(s: SellerState): number {
    return s.bookCost + shippingCost(s.qty, s.bases.max, s.perAdditionals.max)
  }

  addOffer(offer: SellerOffer): void {
    this.addBook(offer.seller_id, offer.total_price, offer.listings.length, offer.shipping_base, offer.shipping_per_additional)
  }

  removeOffer(offer: SellerOffer): void {
    this.removeBook(offer.seller_id, offer.total_price, offer.listings.length, offer.shipping_base, offer.shipping_per_additional)
  }

  /** `cost` is the total book cost being added for `units` units. */
  addBook(sellerId: string, cost: number, units: number, shippingBase: number, perAdditional: number): void {
    let s = this.sellers.get(sellerId)
    if (s) {
      this.totalCost -= this.sellerCost(s)
    } else {
      s = { qty: 0, bookCost: 0, bases: new MaxBag(), perAdditionals: new MaxBag() }
      this.sellers.set(sellerId, s)
    }
    s.qty += units
    s.bookCost += cost
    s.bases.add(shippingBase)
    s.perAdditionals.add(perAdditional)
    this.totalCost += this.sellerCost(s)
  }

  removeBook(sellerId: string, cost: number, units: number, shippingBase: number, perAdditional: number): void {
    const s = this.sellers.get(sellerId)
    if (!s) return
    this.totalCost -= this.sellerCost(s)
    s.qty -= units
    s.bookCost -= cost
    s.bases.remove(shippingBase)
    s.perAdditionals.remove(perAdditional)
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
    const qualified = rawListings.filter((l) => listingQualifies(item, l))
    // Sort by total standalone cost (price + shipping_base) so candidate selection
    // in all strategies considers actual cost, not just book price.
    qualified.sort((a, b) => (a.price + a.shipping_base) - (b.price + b.shipping_base))
    return makeBookOption(item, qualified)
  })
}

export function buildGroups(bookOptions: BookOption[], assignment: Assignment): SellerGroup[] {
  const optionById = new Map(bookOptions.map((b) => [b.item.id, b]))
  const groupMap = new Map<string, SellerGroup>()
  for (const [itemId, offer] of assignment) {
    const opt = optionById.get(itemId)!
    if (!groupMap.has(offer.seller_id)) {
      groupMap.set(offer.seller_id, {
        seller_id: offer.seller_id,
        seller_name: offer.seller_name,
        assignments: [],
        books_subtotal: 0,
        shipping: 0,
        group_total: 0,
      })
    }
    const group = groupMap.get(offer.seller_id)!
    group.assignments.push({
      item: opt.item,
      listing: offer.listings[0],
      listings: offer.listings,
      quantity: opt.item.quantity,
      subtotal: offer.total_price,
    })
    group.books_subtotal += offer.total_price
  }

  // Shipping derives from the same units and combined terms the strategies'
  // cost model uses, over every listing in the group — never one representative
  // listing, whose base may be lower than what other copies in the order quote.
  const groups: SellerGroup[] = []
  for (const group of groupMap.values()) {
    const units = group.assignments.flatMap((a) => a.listings)
    group.shipping = shippingCost(units.length, maxShippingBase(units), maxShippingPerAdditional(units))
    group.group_total = group.books_subtotal + group.shipping
    groups.push(group)
  }
  return groups
}
