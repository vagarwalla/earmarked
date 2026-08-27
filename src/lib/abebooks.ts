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
    return { listings: parseListingsFromHTML(html, isbn), error: null }
  } catch (err) {
    console.error(`AbeBooks fetch error for ${isbn}:`, err)
    return { listings: [], error: (err as Error).message }
  }
}

/**
 * Readable text from a fragment of markup. AbeBooks wraps most values in nested
 * spans, and the raw fragment is not safe to keep: it reaches the UI as the
 * condition label, and stray markup also derails normalizeCondition (the "as" in
 * `class=` reads as "as new").
 */
function text(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Condition text without the "Condition:" prefix the screen-reader copy carries. */
function stripLabel(fragment: string): string {
  return text(fragment).replace(/^Condition:\s*/i, '')
}

/**
 * One string per listing, each running from its container marker to the start
 * of the next. Listings nest their own <li> chips, so the enclosing element
 * cannot be matched by a balanced-tag regex; the marker is the reliable seam.
 */
function splitListingBlocks(html: string): string[] {
  const markerRe = /<li[^>]*data-test-id="listing-item(?:-[^"]*)?"/g
  const starts: number[] = []
  for (let m = markerRe.exec(html); m !== null; m = markerRe.exec(html)) starts.push(m.index)

  return starts.map((start, i) => html.slice(start, starts[i + 1] ?? html.length))
}

function parseListingsFromHTML(html: string, isbn: string): Listing[] {
  const listings: Listing[] = []

  // AbeBooks uses server-rendered HTML with these exact attributes (verified
  // against a live search page, August 2026 — see __tests__/fixtures/abebooks-srp.html):
  // - Listing container: <li data-test-id="listing-item-{listingId}">
  // - Price:             data-csa-c-cost="7.40"  (on the "Add to basket" button)
  // - Shipping:          data-csa-c-shipping-cost="0"
  // - Listing ID:        data-listingid="32405132647"
  // - Condition:         data-test-id="listing-condition">Used - Fair</span>
  // - Signed / 1st ed:   <ul aria-label="Attributes"> chips, e.g. aria-label="Signed"
  // - Dust Jacket:       no chip — only ever mentioned in the description text
  // - Seller name:       data-test-id="listing-seller-link" ...>Dream Books Co.</a>
  // - Seller ID:         href="/{slug}/{sellerId}/sf"
  // - Book detail URL:   href="/{slug}/{listingId}/bd"
  //
  // Blocks are split on the container marker rather than matched as <li>…</li>:
  // a listing contains nested <li> chips, so a non-greedy match stops early and
  // truncates the block before the price.
  const idRe = /data-listingid="(\d+)"/
  const costRe = /data-csa-c-cost="([\d.]+)"/
  const shipRe = /data-csa-c-shipping-cost="([\d.]+)"/
  // The quality appears twice: once inside a wrapper that also carries a
  // screen-reader copy, and once on its own as plain text. Prefer the latter.
  const condRe = /data-test-id="listing-condition"[^>]*>([\s\S]*?)<\/span>/
  const bookCondRe = /data-test-id="listing-book-condition(?:-\d+)?"[^>]*>([\s\S]*?)<\/(?:p|span)>/
  // listing-optional-condition holds the actual quality ("Condition: Very good", "Condition: Fair", etc.)
  // It is more precise than listing-book-condition which often only says "Used - Hardcover"
  const optCondRe = /data-test-id="listing-optional-condition"[^>]*>([\s\S]*?)<\/span>/
  const attributesRe = /<ul[^>]*aria-label="Attributes"[\s\S]*?<\/ul>/
  const descRe = /data-test-id="(?:listing-description|description-\d+)"[^>]*>([\s\S]*?)<\/p>/
  const sellerRe = /data-test-id="listing-seller-link"[^>]*>([^<]+)</
  const hrefRe = /href="(\/[^"]+\/\d+\/bd)"/
  const sfRe = /href="\/[^"]+\/(\d+)\/sf(?:\?[^"]*)?"/

  for (const block of splitListingBlocks(html)) {
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
    // Collectible attributes are chips in an "Attributes" list, alongside the
    // binding. Scoping to that list keeps a description that merely discusses a
    // first edition from being read as one.
    const attributes = attributesRe.exec(block)?.[0] ?? ''
    const signed = /aria-label="Signed"/.test(attributes)
    const first_edition = /aria-label="First Edition"/.test(attributes)
    const descMatch = descRe.exec(block)
    const dust_jacket = descMatch ? /\bwith dust ?jacket\b/i.test(descMatch[1]) : false

    // Prefer listing-optional-condition (e.g. "Condition: Very good") over
    // listing-book-condition (e.g. "Used - Hardcover") — the latter is a format
    // label and often omits quality info entirely.
    const bookCondMatch = bookCondRe.exec(block)
    const rawCond = stripLabel(condMatch?.[1] ?? bookCondMatch?.[1] ?? 'Good') || 'Good'
    const optCond = optCondMatch ? stripLabel(optCondMatch[1]) : null
    const condition = optCond ?? rawCond

    // Skip non-book media — check condition text for format keywords
    // (AbeBooks lists CDs, DVDs, etc. in the same search results for ISBN lookups)
    const condLower = condition.toLowerCase()
    const NON_BOOK = [/\bcd\b/, /\bdvd\b/, /\bvhs\b/, /\bcassette\b/, /\bvinyl\b/, /\baudio cd\b/, /\bmp3\b/, /\bdigital\b/]
    if (NON_BOOK.some((r) => r.test(condLower))) continue

    const sellerName = sellerMatch ? text(sellerMatch[1]) : 'AbeBooks Seller'
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
