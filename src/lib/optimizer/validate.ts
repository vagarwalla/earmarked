import type { CartItem, Listing } from '../types'

// Hand-rolled validation (the project has no schema library). Checks every
// field the optimizer's cost math or filtering actually reads; unknown extra
// fields pass through untouched.

const MAX_ITEMS = 500
const MAX_LISTINGS_TOTAL = 50_000

export type ValidationResult =
  | { ok: true; items: CartItem[]; listingsByIsbn: Map<string, Listing[]> }
  | { ok: false; error: string }

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isNullableBoolean(v: unknown): boolean {
  return v == null || typeof v === 'boolean'
}

function itemError(it: unknown, idx: number): string | null {
  if (typeof it !== 'object' || it === null) return `items[${idx}] is not an object`
  const o = it as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id.length === 0) return `items[${idx}].id must be a non-empty string`
  if (!isFiniteNumber(o.quantity) || o.quantity < 1) return `items[${idx}].quantity must be a number >= 1`
  if (!Array.isArray(o.conditions) || o.conditions.some((c) => typeof c !== 'string'))
    return `items[${idx}].conditions must be an array of strings`
  if (o.max_price != null && !isFiniteNumber(o.max_price)) return `items[${idx}].max_price must be a finite number or null`
  if (o.isbn_preferred != null && typeof o.isbn_preferred !== 'string') return `items[${idx}].isbn_preferred must be a string or null`
  if (o.isbns_candidates != null && (!Array.isArray(o.isbns_candidates) || o.isbns_candidates.some((s) => typeof s !== 'string')))
    return `items[${idx}].isbns_candidates must be an array of strings or null`
  for (const flag of ['signed_only', 'first_edition_only', 'dust_jacket_only'] as const) {
    if (!isNullableBoolean(o[flag])) return `items[${idx}].${flag} must be a boolean or null`
  }
  return null
}

function listingError(l: unknown, isbn: string, idx: number): string | null {
  if (typeof l !== 'object' || l === null) return `listingsByIsbn[${isbn}][${idx}] is not an object`
  const o = l as Record<string, unknown>
  for (const key of ['listing_id', 'seller_id', 'seller_name', 'condition_normalized'] as const) {
    if (typeof o[key] !== 'string' || o[key].length === 0)
      return `listingsByIsbn[${isbn}][${idx}].${key} must be a non-empty string`
  }
  if (!isFiniteNumber(o.price) || o.price < 0) return `listingsByIsbn[${isbn}][${idx}].price must be a number >= 0`
  for (const key of ['shipping_base', 'shipping_per_additional'] as const) {
    if (!isFiniteNumber(o[key]) || (o[key] as number) < 0)
      return `listingsByIsbn[${isbn}][${idx}].${key} must be a number >= 0`
  }
  for (const key of ['signed', 'first_edition', 'dust_jacket'] as const) {
    if (typeof o[key] !== 'boolean') return `listingsByIsbn[${isbn}][${idx}].${key} must be a boolean`
  }
  return null
}

export function validateOptimizeRequest(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'request body must be a JSON object' }
  const { items, listingsByIsbn } = body as Record<string, unknown>

  if (!Array.isArray(items)) return { ok: false, error: 'items must be an array' }
  if (items.length > MAX_ITEMS) return { ok: false, error: `items exceeds the maximum of ${MAX_ITEMS}` }
  for (let i = 0; i < items.length; i++) {
    const err = itemError(items[i], i)
    if (err) return { ok: false, error: err }
  }

  if (typeof listingsByIsbn !== 'object' || listingsByIsbn === null || Array.isArray(listingsByIsbn))
    return { ok: false, error: 'listingsByIsbn must be an object mapping ISBN to listings' }
  let totalListings = 0
  const map = new Map<string, Listing[]>()
  for (const [isbn, ls] of Object.entries(listingsByIsbn as Record<string, unknown>)) {
    if (!Array.isArray(ls)) return { ok: false, error: `listingsByIsbn[${isbn}] must be an array` }
    totalListings += ls.length
    if (totalListings > MAX_LISTINGS_TOTAL)
      return { ok: false, error: `total listings exceed the maximum of ${MAX_LISTINGS_TOTAL}` }
    for (let i = 0; i < ls.length; i++) {
      const err = listingError(ls[i], isbn, i)
      if (err) return { ok: false, error: err }
    }
    map.set(isbn, ls as Listing[])
  }

  return { ok: true, items: items as CartItem[], listingsByIsbn: map }
}
