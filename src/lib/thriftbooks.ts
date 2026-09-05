// ThriftBooks scraper.
//
// Approach:
//   GET https://www.thriftbooks.com/browse/?b.search={isbn}
//   ThriftBooks 302-redirects this to the canonical work page:
//     /w/{slug}/{workId}/
//   That page is server-rendered and embeds all edition/condition data as JSON
//   directly in the HTML (no JS execution needed).  We extract:
//     - The canonical work URL  → slug + workId for building listing links
//     - JSON `conditions` arrays grouped by media type, each entry having:
//         quality, isbn, ean, idAmazon, price, exLib, noDj
//   We filter to conditions whose `ean` (or `isbn`) matches the requested ISBN,
//   and where price > 0.

import type { Listing, SourceFetch } from './types'
import { normalizeCondition } from './abebooks'

const SEARCH_BASE = 'https://www.thriftbooks.com/browse/?b.search='

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

export async function fetchThriftBooksListings(isbn: string): Promise<SourceFetch> {
  try {
    const res = await fetch(`${SEARCH_BASE}${encodeURIComponent(isbn)}`, {
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      console.error(`ThriftBooks search failed for ${isbn}: ${res.status}`)
      return { listings: [], error: `HTTP ${res.status}` }
    }
    const html = await res.text()
    const finalUrl = res.url
    return { listings: parseThriftBooksHTML(html, finalUrl, isbn), error: null }
  } catch (err) {
    console.error(`ThriftBooks fetch error for ${isbn}:`, err)
    return { listings: [], error: (err as Error).message }
  }
}

interface TBCondition {
  quality: string
  isbn: string
  ean: string
  idAmazon: number
  /** Inventory-quality id: the thing ThriftBooks' own add-to-cart call takes. */
  idIq: number | null
  price: number
  exLib: boolean
  noDj: boolean
}

/** Each `{…}` inside a `"conditions":[…]` array, parsed leniently. */
function parseConditionObjects(blockText: string): TBCondition[] {
  const out: TBCondition[] = []
  const objRe = /\{[^{}]*\}/g
  let m: RegExpExecArray | null
  while ((m = objRe.exec(blockText)) !== null) {
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(m[0]) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof raw.quality !== 'string' || typeof raw.price !== 'number') continue
    out.push({
      quality: raw.quality,
      isbn: typeof raw.isbn === 'string' ? raw.isbn : '',
      ean: typeof raw.ean === 'string' ? raw.ean : '',
      idAmazon: typeof raw.idAmazon === 'number' ? raw.idAmazon : 0,
      idIq: typeof raw.idIq === 'number' ? raw.idIq : null,
      price: raw.price,
      exLib: raw.exLib === true,
      noDj: raw.noDj === true,
    })
  }
  return out
}

function parseThriftBooksHTML(html: string, pageUrl: string, requestedIsbn: string): Listing[] {
  const listings: Listing[] = []

  // Extract slug + workId from the canonical <link> or the response URL.
  // Both /w/{slug}/{id}/ and /w/{slug}/{id}/item/ patterns are handled.
  const workUrlMatch =
    /rel="canonical"\s+href="(https?:\/\/www\.thriftbooks\.com\/w\/[^"]+\/(\d+)\/[^"]*)"/.exec(html) ||
    /https?:\/\/www\.thriftbooks\.com\/w\/([^/]+)\/(\d+)\//.exec(pageUrl)

  let slug = ''
  let workId = ''
  if (workUrlMatch) {
    // First pattern: group 1 = full URL, group 2 = workId
    // Second pattern: group 1 = slug, group 2 = workId
    const fullUrlM = /\/w\/([^/]+)\/(\d+)\//.exec(workUrlMatch[1] || pageUrl)
    if (fullUrlM) {
      slug = fullUrlM[1]
      workId = fullUrlM[2]
    }
  }

  // Normalise ISBN for comparison: accept both 10-digit and 13-digit forms.
  // The embedded data uses both `ean` (ISBN-13) and `isbn` (ISBN-10) fields.
  const isbn13 = requestedIsbn.length === 13 ? requestedIsbn : null
  const isbn10 = requestedIsbn.length === 10 ? requestedIsbn : null

  // Locate all `conditions` JSON arrays in the page.
  // The structure is: ..."conditions":[{...},{...}]...
  // We use a simple regex to grab each element.
  const conditionBlockRe = /"conditions":\[([^\]]+)\]/g
  let blockMatch: RegExpExecArray | null
  let listingIdx = 0

  while ((blockMatch = conditionBlockRe.exec(html)) !== null) {
    const blockText = blockMatch[1]
    for (const cond of parseConditionObjects(blockText)) {
      // Filter: must match the requested ISBN (either 10 or 13 digit)
      const matchesIsbn =
        (isbn13 && (cond.ean === isbn13)) ||
        (isbn10 && (cond.isbn === isbn10)) ||
        // Also handle the case where caller passes 13-digit but we compare isbn10
        (requestedIsbn.length === 13 && cond.ean === requestedIsbn) ||
        (requestedIsbn.length === 10 && cond.isbn === requestedIsbn)

      if (!matchesIsbn) continue
      if (cond.price <= 0) continue

      // Build the listing URL
      const listingUrl =
        slug && workId
          ? `https://www.thriftbooks.com/w/${slug}/${workId}/item/?selectedISBN=${cond.isbn}#edition=${cond.idAmazon}`
          : `https://www.thriftbooks.com/browse/?b.search=${encodeURIComponent(requestedIsbn)}`

      // Build condition notes including ex-library / no-dust-jacket flags
      const conditionParts = [cond.quality]
      if (cond.exLib) conditionParts.push('Ex-Library')
      if (cond.noDj) conditionParts.push('No DJ')
      const conditionText = conditionParts.join(', ')

      listings.push({
        listing_id: `tb_${cond.idAmazon}_${listingIdx++}`,
        seller_id: 'thriftbooks',
        seller_name: 'ThriftBooks',
        price: cond.price,
        shipping_base: 3.99,
        shipping_per_additional: 0,
        condition: conditionText,
        condition_normalized: normalizeCondition(cond.quality),
        signed: false,
        first_edition: false,
        dust_jacket: !cond.noDj,
        url: listingUrl,
        isbn: requestedIsbn,
        // ThriftBooks' own client navigates to /addtocart/{idIq}/{quantity}
        // after a cart add; opened directly it puts this copy in the cart.
        ...(cond.idIq ? { add_to_cart_url: `https://www.thriftbooks.com/addtocart/${cond.idIq}/1` } : {}),
      })
    }
  }

  return listings
}
