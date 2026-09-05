import type { Condition, Listing, SourceFetch } from './types'

const SEARCH_URL = 'https://www.abebooks.com/servlet/SearchResults'

// Used when a listing's shipping attribute is absent or unparseable. Standard
// AbeBooks US rate — a conservative guess beats silently assuming free shipping.
export const ABE_DEFAULT_SHIPPING = 3.99

export function normalizeCondition(cond: string): Condition {
  const c = cond.toLowerCase()
  if (c.includes('new') && !c.includes('like') && !c.includes('as') && !c.includes('near')) return 'new'
  if (c.includes('like new') || c.includes('as new') || c.includes('near fine') || c.includes('fine')) return 'fine'
  if (c.includes('very good') || c.includes('good')) return 'good'
  if (c.includes('acceptable') || c.includes('fair') || c.includes('poor')) return 'fair'
  return 'good'
}

const CONDITION_RANK: Record<Condition, number> = {
  new: 4,
  fine: 3,
  good: 2,
  fair: 1,
}

export function conditionMeets(actual: Condition, minimum: Condition): boolean {
  return CONDITION_RANK[actual] >= CONDITION_RANK[minimum]
}

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.abebooks.com/',
}

function searchUrl(isbn: string): string {
  return `${SEARCH_URL}?isbn=${isbn}&sortby=17&n=100110615`
}

export async function fetchListingsByISBN(isbn: string): Promise<SourceFetch> {
  try {
    const res = await fetch(searchUrl(isbn), {
      headers: {
        ...BASE_HEADERS,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      console.error(`AbeBooks search failed for ${isbn}: ${res.status}`)
      return { listings: [], error: `HTTP ${res.status}` }
    }

    const html = await res.text()
    // AbeBooks moved to a React front end (September 2026) that ships the
    // results as JSON inside the page; the old server-rendered <li> markup is
    // gone. Read the JSON first and keep the HTML parser as a fallback in case
    // the old page is still served to some visitors.
    const fromJson = parseListingsFromFlightJSON(html, isbn)
    const listings = fromJson.length > 0 ? fromJson : parseListingsFromHTML(html, isbn)
    return { listings, error: null }
  } catch (err) {
    console.error(`AbeBooks fetch error for ${isbn}:`, err)
    return { listings: [], error: (err as Error).message }
  }
}

function parseListingsFromHTML(html: string, isbn: string): Listing[] {
  const listings: Listing[] = []

  // AbeBooks uses server-rendered HTML with these exact attributes (verified March 2026):
  // - Listing container: <li data-test-id="listing-item">
  // - Price:             data-csa-c-cost="7.40"  (on the "Add to basket" button)
  // - Shipping:          data-csa-c-shipping-cost="0.0"
  // - Listing ID:        data-listingid="32405132647"
  // - Condition:         data-test-id="listing-book-condition">Used - Softcover</span>
  // - Signed:            data-test-id="listing-signed">Signed</span>  (only present if signed)
  // - First Edition:     data-test-id="listing-firstedition">First Edition</span>  (only if FE)
  // - Dust Jacket:       no dedicated element — appears as "With dust jacket" in listing-description
  // - Seller name:       seller-name">World of Books
  // - Book detail URL:   href="/{slug}/{listingId}/bd"

  const listingBlockRe = /<li[^>]*data-test-id="listing-item"[^>]*>([\s\S]*?)<\/li>/g
  const idRe = /data-listingid="(\d+)"/
  const costRe = /data-csa-c-cost="([\d.]+)"/
  const shipRe = /data-csa-c-shipping-cost="([\d.]+)"/
  const condRe = /data-test-id="listing-book-condition"[^>]*>([\s\S]*?)<\/span>/
  // listing-optional-condition holds the actual quality ("Condition: Very good", "Condition: Fair", etc.)
  // It is more precise than listing-book-condition which often only says "Used - Hardcover"
  const optCondRe = /data-test-id="listing-optional-condition"[^>]*>([\s\S]*?)<\/span>/
  const signedRe = /data-test-id="listing-signed"/
  const firstEditionRe = /data-test-id="listing-firstedition"/
  const descRe = /data-test-id="listing-description"[^>]*>([\s\S]*?)<\/p>/
  const sellerRe = /seller-name">([^<]+)/
  const hrefRe = /href="(\/[^"]+\/\d+\/bd)"/
  const sfRe = /href="\/[^"]+\/(\d+)\/sf(?:\?[^"]*)?"/

  let m: RegExpExecArray | null
  while ((m = listingBlockRe.exec(html)) !== null) {
    const block = m[1]

    const costMatch = costRe.exec(block)
    if (!costMatch) continue

    const price = parseFloat(costMatch[1])
    if (!price || price <= 0) continue

    const idMatch = idRe.exec(block)
    const shipMatch = shipRe.exec(block)
    const condMatch = condRe.exec(block)
    const optCondMatch = optCondRe.exec(block)
    const sellerMatch = sellerRe.exec(block)
    const hrefMatch = hrefRe.exec(block)
    const sfMatch = sfRe.exec(block)

    const listingId = idMatch ? idMatch[1] : undefined
    const sellerId = sfMatch ? sfMatch[1] : undefined
    // A parsed "0.0" genuinely means free shipping, but a MISSING attribute
    // means we failed to read it — defaulting that to free silently
    // under-reports every total. Fall back to the standard US rate instead.
    const parsedShipping = shipMatch ? parseFloat(shipMatch[1]) : NaN
    const shipping = Number.isFinite(parsedShipping) ? parsedShipping : ABE_DEFAULT_SHIPPING
    const signed = signedRe.test(block)
    const first_edition = firstEditionRe.test(block)
    const descMatch = descRe.exec(block)
    const dust_jacket = descMatch ? /with dust jacket/i.test(descMatch[1]) : false

    // Prefer listing-optional-condition (e.g. "Condition: Very good") over
    // listing-book-condition (e.g. "Used - Hardcover") — the latter is a format
    // label and often omits quality info entirely.
    const rawCond = condMatch ? condMatch[1].trim() : 'Good'
    const optCond = optCondMatch ? optCondMatch[1].trim().replace(/^Condition:\s*/i, '') : null
    const condition = optCond ?? rawCond

    // Skip non-book media — check condition text for format keywords
    // (AbeBooks lists CDs, DVDs, etc. in the same search results for ISBN lookups)
    const condLower = condition.toLowerCase()
    const NON_BOOK = [/\bcd\b/, /\bdvd\b/, /\bvhs\b/, /\bcassette\b/, /\bvinyl\b/, /\baudio cd\b/, /\bmp3\b/, /\bdigital\b/]
    if (NON_BOOK.some((r) => r.test(condLower))) continue

    const sellerName = sellerMatch ? sellerMatch[1].trim() : 'AbeBooks Seller'
    const url = hrefMatch
      ? `https://www.abebooks.com${hrefMatch[1]}`
      : searchUrl(isbn)

    listings.push({
      listing_id: listingId ?? `${isbn}_${listings.length}`,
      seller_id: sellerId ?? listingId ?? `seller_${listings.length}`,
      seller_name: sellerName,
      price,
      shipping_base: shipping,
      shipping_per_additional: 1.99,
      condition,
      condition_normalized: normalizeCondition(condition),
      signed,
      first_edition,
      dust_jacket,
      url,
      isbn,
    })
  }

  return listings
}

// ── Next.js flight payload parser ────────────────────────────────────────────
//
// The new search page streams its React tree through `self.__next_f.push([1,
// "<escaped JSON>"])` script tags. One of those chunks holds
// `"searchResultsArray":{"results":[{"listing":{...}}, …]}` — every listing on
// the page with price, shipping, condition, vendor, and the add-to-basket link.

interface AbeMoney { amount: number; currency: string }

interface AbeFlightListing {
  listingId?: number
  bdpCanonicalUrl?: string
  addToBasketUrl?: string
  quantity?: number
  isbn13?: string
  isbn10?: string
  binding?: string
  description?: string
  condition?: string          // enum, e.g. USED_VERYGOOD, USED_ASNEW, NEW
  vendorCondition?: string    // seller's own words, e.g. "Very Good"
  productType?: string
  bsaCodes?: string[]
  searchAttributes?: string[]
  vendorId?: number
  vendorName?: string
  priceInPurchaseCurrency?: AbeMoney
  shippingPriceInPurchaseCurrency?: AbeMoney
  shippingRates?: Array<{ shippingPriceInPurchaseCurrency?: AbeMoney }>
}

const ABE_ORIGIN = 'https://www.abebooks.com'

/** Map AbeBooks' condition enum onto our four-step scale. */
export function normalizeAbeConditionCode(code: string | undefined, fallback: string): Condition {
  const c = (code ?? '').toUpperCase()
  if (c === 'NEW') return 'new'
  if (/ASNEW|NEARFINE|FINE|LIKENEW/.test(c)) return 'fine'
  if (/VERYGOOD|GOOD/.test(c)) return 'good'
  if (/FAIR|POOR|ACCEPTABLE/.test(c)) return 'fair'
  return normalizeCondition(fallback)
}

/** Human label for a condition enum when the seller gave none. */
function labelForConditionCode(code: string | undefined): string | null {
  const c = (code ?? '').toUpperCase()
  if (!c) return null
  if (c === 'NEW') return 'New'
  if (c.includes('ASNEW')) return 'As New'
  if (c.includes('NEARFINE')) return 'Near Fine'
  if (c.includes('FINE')) return 'Fine'
  if (c.includes('VERYGOOD')) return 'Very Good'
  if (c.includes('GOOD')) return 'Good'
  if (c.includes('FAIR')) return 'Fair'
  if (c.includes('POOR')) return 'Poor'
  return null
}

/** Every `self.__next_f.push([1, "…"])` chunk, unescaped. */
function flightChunks(html: string): string[] {
  const chunks: string[] = []
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (!m[1].includes('searchResultsArray')) continue
    try {
      chunks.push(JSON.parse(`"${m[1]}"`))
    } catch {
      // A chunk we cannot unescape is not the one we want.
    }
  }
  return chunks
}

/** The JSON object starting at `start` (which must point at `{`), by brace matching. */
function sliceObject(text: string, start: number): string | null {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

export function parseListingsFromFlightJSON(html: string, isbn: string): Listing[] {
  const listings: Listing[] = []
  const seen = new Set<string>()

  for (const chunk of flightChunks(html)) {
    const re = /"listing":\{/g
    let m: RegExpExecArray | null
    while ((m = re.exec(chunk)) !== null) {
      const objText = sliceObject(chunk, m.index + '"listing":'.length)
      if (!objText) continue
      let raw: AbeFlightListing
      try {
        raw = JSON.parse(objText) as AbeFlightListing
      } catch {
        continue
      }
      const listing = toListing(raw, isbn, listings.length)
      if (!listing || seen.has(listing.listing_id)) continue
      seen.add(listing.listing_id)
      listings.push(listing)
    }
  }

  return listings
}

const NON_BOOK_BINDING = /\b(cd|dvd|vhs|cassette|vinyl|audio|mp3|digital)\b/i

function toListing(raw: AbeFlightListing, isbn: string, index: number): Listing | null {
  const price = raw.priceInPurchaseCurrency?.amount
  if (typeof price !== 'number' || !(price > 0)) return null
  if (raw.productType && raw.productType !== 'DEFAULT') return null
  if (raw.binding && NON_BOOK_BINDING.test(raw.binding)) return null

  // Cheapest offered rate is the one the basket defaults to. An unreadable
  // shipping figure falls back to the standard rate rather than to free.
  const rates = (raw.shippingRates ?? [])
    .map((r) => r.shippingPriceInPurchaseCurrency?.amount)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
  const headline = raw.shippingPriceInPurchaseCurrency?.amount
  const shipping = rates.length > 0
    ? Math.min(...rates)
    : typeof headline === 'number' && Number.isFinite(headline) ? headline : ABE_DEFAULT_SHIPPING

  const codes = [...(raw.bsaCodes ?? []), ...(raw.searchAttributes ?? [])].map((c) => c.toUpperCase())
  const description = raw.description ?? ''
  const signed = codes.some((c) => c.includes('SIGNED')) || /\bsigned\b/i.test(description)
  const first_edition = codes.some((c) => c.includes('FIRST_EDITION') || c === 'FIRSTEDITION')
    || /\bfirst edition\b|\b1st edition\b/i.test(description)
  const noJacket = codes.some((c) => c.includes('NO_JACKET'))
  const dust_jacket = !noJacket && (
    codes.some((c) => c.startsWith('JACKET_CONDITION') || c.includes('DUST_JACKET'))
    || /\b(with|in) dust ?jacket\b|\bdj\b/i.test(description)
  )

  // Sellers' own wording is inconsistent ("very_good", "acceptable", "Very Good"),
  // so the enum's label is shown when there is one.
  const vendorCondition = raw.vendorCondition?.trim()
  const condition = labelForConditionCode(raw.condition) || vendorCondition || 'Good'
  const condition_normalized = normalizeAbeConditionCode(raw.condition, condition)

  const listingId = raw.listingId != null ? String(raw.listingId) : `${isbn}_${index}`
  const sellerId = raw.vendorId != null ? String(raw.vendorId) : listingId
  const url = raw.bdpCanonicalUrl ? `${ABE_ORIGIN}${raw.bdpCanonicalUrl}` : searchUrl(isbn)
  const add_to_cart_url = raw.addToBasketUrl
    ? `${ABE_ORIGIN}${raw.addToBasketUrl}`
    : raw.listingId != null ? `${ABE_ORIGIN}/checkout/basket?ac=a&ik=${raw.listingId}` : undefined

  return {
    listing_id: listingId,
    seller_id: sellerId,
    seller_name: raw.vendorName?.trim() || 'AbeBooks Seller',
    price,
    shipping_base: shipping,
    shipping_per_additional: 1.99,
    condition,
    condition_normalized,
    signed,
    first_edition,
    dust_jacket,
    url,
    isbn,
    ...(add_to_cart_url ? { add_to_cart_url } : {}),
  }
}
