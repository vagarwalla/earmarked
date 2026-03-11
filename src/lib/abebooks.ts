import type { Condition, Listing } from './types'

const SEARCH_URL = 'https://www.abebooks.com/servlet/SearchResults'

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

export async function fetchListingsByISBN(isbn: string): Promise<Listing[]> {
  try {
    const res = await fetch(searchUrl(isbn), {
      headers: {
        ...BASE_HEADERS,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      console.error(`AbeBooks search failed: ${res.status}`)
      return []
    }

    const html = await res.text()
    return parseListingsFromHTML(html, isbn)
  } catch (err) {
    console.error('AbeBooks fetch error:', err)
    return []
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
    const shipping = shipMatch ? parseFloat(shipMatch[1]) : 0
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
      shipping_base: isNaN(shipping) ? 0 : shipping,
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
