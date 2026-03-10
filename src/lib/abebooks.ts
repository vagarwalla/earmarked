import type { Condition, Listing } from './types'

const SEARCH_URL = 'https://www.abebooks.com/servlet/SearchResults'

export function normalizeCondition(cond: string): Condition {
  const c = cond.toLowerCase()
  if (c.includes('new') && !c.includes('like') && !c.includes('as')) return 'new'
  if (c.includes('like new') || c.includes('as new') || c.includes('fine')) return 'like_new'
  if (c.includes('very good')) return 'very_good'
  if (c.includes('good')) return 'good'
  return 'good'
}

const CONDITION_RANK: Record<Condition, number> = {
  new: 4,
  like_new: 3,
  very_good: 2,
  good: 1,
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
  // - Seller name:       seller-name">World of Books
  // - Book detail URL:   href="/{slug}/{listingId}/bd"

  const listingBlockRe = /<li[^>]*data-test-id="listing-item"[^>]*>([\s\S]*?)<\/li>/g
  const idRe = /data-listingid="(\d+)"/
  const costRe = /data-csa-c-cost="([\d.]+)"/
  const shipRe = /data-csa-c-shipping-cost="([\d.]+)"/
  const condRe = /data-test-id="listing-book-condition"[^>]*>([\s\S]*?)<\/span>/
  const sellerRe = /seller-name">([^<]+)/
  const hrefRe = /href="(\/[^"]+\/\d+\/bd)"/

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
    const sellerMatch = sellerRe.exec(block)
    const hrefMatch = hrefRe.exec(block)

    const listingId = idMatch ? idMatch[1] : undefined
    const shipping = shipMatch ? parseFloat(shipMatch[1]) : 0
    const condition = condMatch ? condMatch[1].trim() : 'Good'
    const sellerName = sellerMatch ? sellerMatch[1].trim() : 'AbeBooks Seller'
    const url = hrefMatch
      ? `https://www.abebooks.com${hrefMatch[1]}`
      : searchUrl(isbn)

    listings.push({
      listing_id: listingId ?? `${isbn}_${listings.length}`,
      seller_id: listingId ?? `seller_${listings.length}`,
      seller_name: sellerName,
      price,
      shipping_base: isNaN(shipping) ? 0 : shipping,
      shipping_per_additional: 1.99,
      condition,
      condition_normalized: normalizeCondition(condition),
      url,
      isbn,
    })
  }

  return listings
}
