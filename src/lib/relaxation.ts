import type { CartItem, Condition, Edition, Listing } from './types'
import { listingQualifies } from './optimizer/shared'

export const CONDITION_ORDER: Condition[] = ['new', 'fine', 'good', 'fair']
export const CONDITION_LABELS: Record<Condition, string> = {
  new: 'New', fine: 'Fine', good: 'Good', fair: 'Fair',
}

export type RelaxSuggestion =
  | { type: 'condition'; newConditions: Condition[]; addedLabels: string[]; count: number }
  | { type: 'max_price'; count: number }

/** Tier indicating how significant a relaxed deal is relative to the strict criteria price. */
export type DealTier =
  | 'better_deal'  // saves ≥$4 or ≥40% — worth calling out prominently
  | 'heads_up'     // saves $1–$3.99 and <40% — informational for price-sensitive users
  | 'trivial'      // saves <$1 — user is already getting the best deal for their criteria

export interface RelaxedDeal {
  listing: Listing
  relaxationType: 'condition'
  newConditions: Condition[]
  addedLabels: string[]    // e.g. ['Good'] or ['Good', 'Fair']
  strictCheapest: number   // cheapest price within strict criteria
  relaxedCheapest: number  // cheapest price with relaxed criteria
  savingsAmount: number
  savingsPct: number
  tier: DealTier
}

export interface NearMissPrice {
  cheapestBlocked: number  // cheapest listing passing condition filter but blocked by price cap
  delta: number            // how much over the cap (cheapestBlocked - maxPrice)
}

export function computeListings(
  item: CartItem,
  byIsbn: Record<string, Listing[]>,
  conditions: Condition[],
  maxPrice: number | null,
): Listing[] {
  const isbns = [...new Set([
    ...(item.isbn_preferred ? [item.isbn_preferred] : []),
    ...(item.isbns_candidates ?? []),
  ])]
  return [...new Map(
    isbns.flatMap((isbn) => byIsbn[isbn] ?? []).map((l) => [l.listing_id, l])
  ).values()].filter((l) => listingQualifies(item, l, conditions, maxPrice))
}

/** Find the minimal constraint relaxation that yields at least one listing. */
export function findSuggestion(
  item: CartItem,
  byIsbn: Record<string, Listing[]>,
  conditions: Condition[],
  maxPrice: number | null,
): RelaxSuggestion | null {
  // First check: are there ANY raw listings for these ISBNs at all (ignoring condition/price)?
  const anyRaw = computeListings(item, byIsbn, CONDITION_ORDER, null)
  if (anyRaw.length === 0) return null  // needs editions relaxation

  // Try expanding conditions one step at a time
  const missing = CONDITION_ORDER.filter((c) => !conditions.includes(c))
  for (let i = 1; i <= missing.length; i++) {
    const expanded = [...conditions, ...missing.slice(0, i)]
    const count = computeListings(item, byIsbn, expanded, maxPrice).length
    if (count > 0) {
      return {
        type: 'condition',
        newConditions: expanded,
        addedLabels: missing.slice(0, i).map((c) => CONDITION_LABELS[c]),
        count,
      }
    }
  }

  // Try removing max_price cap
  if (maxPrice != null) {
    const count = computeListings(item, byIsbn, CONDITION_ORDER, null).length
    if (count > 0) return { type: 'max_price', count }
  }

  return null
}

/**
 * An alternate edition (a different cover) that has listings, optionally after
 * also relaxing conditions. `addedLabels` is empty when the edition qualifies
 * under the conditions the user already accepts.
 */
export interface EditionOption {
  edition: Edition
  isbn: string
  count: number
  cheapest: number
  cheapestCondition: Condition
  newConditions: Condition[]  // conditions needed for this edition (== current when addedLabels is empty)
  addedLabels: string[]       // e.g. ['Good'] — empty when no condition relaxation is needed
}

/** Cheapest-first, and prefer options that don't also require loosening condition. */
function compareEditionOptions(a: EditionOption, b: EditionOption): number {
  if (a.addedLabels.length !== b.addedLabels.length) return a.addedLabels.length - b.addedLabels.length
  if (a.cheapest !== b.cheapest) return a.cheapest - b.cheapest
  return b.edition.popularity_score - a.edition.popularity_score
}

/**
 * Search alternate editions of the same work for listings, expanding conditions
 * only as far as each edition needs. Explores both axes at once — a different
 * cover may have stock under the user's current conditions, or only under
 * looser ones — so the caller can offer whichever costs the user least.
 *
 * `editions` should already exclude ISBNs the item is searching, and `byIsbn`
 * must hold listings for them. Results are deduplicated by cover image so the
 * user sees genuinely different covers rather than reprints that look alike.
 */
export function findEditionOptions(
  item: CartItem,
  editions: Edition[],
  byIsbn: Record<string, Listing[]>,
  conditions: Condition[],
  maxPrice: number | null,
  limit = 3,
): EditionOption[] {
  const missing = CONDITION_ORDER.filter((c) => !conditions.includes(c))
  const bestByCover = new Map<string, EditionOption>()

  for (const edition of editions) {
    // Probe this edition alone — the item's own ISBNs already came up empty.
    const probe: CartItem = { ...item, isbn_preferred: edition.isbn, isbns_candidates: null }

    let listings = computeListings(probe, byIsbn, conditions, maxPrice)
    let newConditions = conditions
    let addedLabels: string[] = []

    for (let i = 1; listings.length === 0 && i <= missing.length; i++) {
      const expanded = [...conditions, ...missing.slice(0, i)]
      const expandedListings = computeListings(probe, byIsbn, expanded, maxPrice)
      if (expandedListings.length > 0) {
        listings = expandedListings
        newConditions = expanded
        addedLabels = missing.slice(0, i).map((c) => CONDITION_LABELS[c])
      }
    }
    if (listings.length === 0) continue

    const cheapest = listings.reduce((a, b) => (a.price <= b.price ? a : b))
    const option: EditionOption = {
      edition,
      isbn: edition.isbn,
      count: listings.length,
      cheapest: cheapest.price,
      cheapestCondition: cheapest.condition_normalized,
      newConditions,
      addedLabels,
    }

    const coverKey = edition.cover_url ?? `isbn:${edition.isbn}`
    const incumbent = bestByCover.get(coverKey)
    if (!incumbent || compareEditionOptions(option, incumbent) < 0) bestByCover.set(coverKey, option)
  }

  return [...bestByCover.values()].sort(compareEditionOptions).slice(0, limit)
}

/**
 * Find the best deal available by relaxing conditions one level at a time (downward only —
 * worse/cheaper conditions). Returns null when no strictly cheaper option exists.
 * Always returns a result (with tier='trivial') if savings are >$0 but <$1.
 */
export function findRelaxedDeal(
  item: CartItem,
  byIsbn: Record<string, Listing[]>,
  currentListings: Listing[],
  conditions: Condition[],
  maxPrice: number | null,
): RelaxedDeal | null {
  if (currentListings.length === 0) return null

  const strictCheapest = Math.min(...currentListings.map((l) => l.price))

  // Only expand downward to worse (cheaper) conditions
  const lowestIdx = Math.max(...conditions.map((c) => CONDITION_ORDER.indexOf(c)))
  const worseConditions = CONDITION_ORDER.slice(lowestIdx + 1).filter((c) => !conditions.includes(c))
  if (worseConditions.length === 0) return null

  for (let i = 1; i <= worseConditions.length; i++) {
    const expanded = [...conditions, ...worseConditions.slice(0, i)]
    const expandedListings = computeListings(item, byIsbn, expanded, maxPrice)
    if (expandedListings.length === 0) continue

    const relaxedCheapest = Math.min(...expandedListings.map((l) => l.price))
    if (relaxedCheapest >= strictCheapest) continue

    const savingsAmount = strictCheapest - relaxedCheapest
    const savingsPct = savingsAmount / strictCheapest
    const tier: DealTier =
      (savingsAmount >= 4 || savingsPct >= 0.4) ? 'better_deal' :
      savingsAmount >= 1 ? 'heads_up' :
      'trivial'

    const listing = expandedListings.reduce((a, b) => a.price <= b.price ? a : b)
    return {
      listing,
      relaxationType: 'condition',
      newConditions: expanded,
      addedLabels: worseConditions.slice(0, i).map((c) => CONDITION_LABELS[c]),
      strictCheapest,
      relaxedCheapest,
      savingsAmount,
      savingsPct,
      tier,
    }
  }

  return null
}

/**
 * Find if the max_price cap is narrowly blocking listings that pass all other criteria.
 * Returns a signal only when the cheapest blocked listing is within $2 of the cap.
 */
export function findNearMissPrice(
  item: CartItem,
  byIsbn: Record<string, Listing[]>,
  conditions: Condition[],
  maxPrice: number | null,
): NearMissPrice | null {
  if (maxPrice == null) return null

  // Find listings passing condition filter but blocked by price cap
  const conditionOnly = computeListings(item, byIsbn, conditions, null)
  const blocked = conditionOnly.filter((l) => l.price > maxPrice)
  if (blocked.length === 0) return null

  const cheapestBlocked = Math.min(...blocked.map((l) => l.price))
  const delta = cheapestBlocked - maxPrice
  if (delta > 2) return null

  return { cheapestBlocked, delta }
}

export interface ShippingRelaxSuggestion {
  itemId: string
  title: string
  currentPrice: number
  relaxedPrice: number
  savings: number
  addedLabels: string[]
  newConditions: Condition[]
}

/**
 * When a seller group's shipping exceeds a threshold, find books in the group that
 * have cheaper listings available with relaxed conditions.
 */
export function findShippingRelaxSuggestions(
  assignments: Array<{ item: CartItem; listing: Listing }>,
  byIsbn: Record<string, Listing[]>,
  conditionOverrides: Record<string, Condition[]>,
  maxPriceOverrides: Record<string, number | null>,
): ShippingRelaxSuggestion[] {
  const suggestions: ShippingRelaxSuggestion[] = []

  for (const { item, listing } of assignments) {
    const conditions = conditionOverrides[item.id] ?? item.conditions ?? []
    const maxPrice = item.id in maxPriceOverrides ? maxPriceOverrides[item.id] : item.max_price

    const lowestIdx = Math.max(...conditions.map((c) => CONDITION_ORDER.indexOf(c)))
    const worseConditions = CONDITION_ORDER.slice(lowestIdx + 1).filter((c) => !conditions.includes(c))
    if (worseConditions.length === 0) continue

    for (let i = 1; i <= worseConditions.length; i++) {
      const expanded = [...conditions, ...worseConditions.slice(0, i)]
      const expandedListings = computeListings(item, byIsbn, expanded, maxPrice)
      if (expandedListings.length === 0) continue

      const relaxedCheapest = Math.min(...expandedListings.map((l) => l.price))
      if (relaxedCheapest < listing.price - 1) {
        suggestions.push({
          itemId: item.id,
          title: item.title,
          currentPrice: listing.price,
          relaxedPrice: relaxedCheapest,
          savings: listing.price - relaxedCheapest,
          addedLabels: worseConditions.slice(0, i).map((c) => CONDITION_LABELS[c]),
          newConditions: expanded,
        })
        break
      }
    }
  }

  return suggestions.sort((a, b) => b.savings - a.savings)
}

/** If cheapest listing > $20, find the minimal relaxation that would yield cheaper options. */
export function findCheaperSuggestion(
  item: CartItem,
  byIsbn: Record<string, Listing[]>,
  currentListings: Listing[],
  conditions: Condition[],
  maxPrice: number | null,
): { addedLabels: string[]; newConditions: Condition[]; cheaperPrice: number } | null {
  if (currentListings.length === 0) return null
  const currentCheapest = Math.min(...currentListings.map((l) => l.price))
  if (currentCheapest <= 20) return null

  const missing = CONDITION_ORDER.filter((c) => !conditions.includes(c))
  if (missing.length === 0) return null

  for (let i = 1; i <= missing.length; i++) {
    const expanded = [...conditions, ...missing.slice(0, i)]
    const expanded_listings = computeListings(item, byIsbn, expanded, maxPrice)
    if (expanded_listings.length === 0) continue
    const cheaperPrice = Math.min(...expanded_listings.map((l) => l.price))
    if (cheaperPrice < currentCheapest - 1) {
      return { addedLabels: missing.slice(0, i).map((c) => CONDITION_LABELS[c]), newConditions: expanded, cheaperPrice }
    }
  }
  return null
}
