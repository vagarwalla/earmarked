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
//         quality, isbn, ean, idIq, idAmazon, price, exLib, noDj
//   We filter to conditions whose `ean` (or `isbn`) matches the requested ISBN,
//   and where price > 0.
//
//   The payload appears more than once per page, so the same copy is read
//   several times and has to be de-duplicated by inventory id.

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
  /** Stable inventory id for this copy — unique per quality/edition. */
  idIq: number
  idAmazon: number
  price: number
  exLib: boolean
  noDj: boolean
}

/**
 * Pull out every `"conditions":[...]` array by matching brackets, then JSON.parse
 * it. Reading the fields off the raw text with one big regex instead would tie
 * us to the order ThriftBooks happens to serialise its keys in, and go quietly
 * empty the day that changes.
 */
function extractConditionArrays(html: string): TBCondition[][] {
  const arrays: TBCondition[][] = []
  const KEY = '"conditions":'

  for (let at = html.indexOf(KEY); at !== -1; at = html.indexOf(KEY, at + KEY.length)) {
    const open = html.indexOf('[', at + KEY.length)
    if (open === -1) continue

    let depth = 0
    let inString = false
    let escaped = false
    let close = -1

    for (let i = open; i < html.length; i++) {
      const ch = html[i]
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = !inString
      } else if (!inString) {
        if (ch === '[') depth++
        else if (ch === ']' && --depth === 0) {
          close = i
          break
        }
      }
    }
    if (close === -1) continue

    try {
      const parsed: unknown = JSON.parse(html.slice(open, close + 1))
      if (Array.isArray(parsed)) arrays.push(parsed as TBCondition[])
    } catch {
      // A block we cannot parse is one source of copies lost, not a failed page.
    }
    at = close
  }

  return arrays
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

  // A work page carries the same media/conditions payload more than once (the
  // server-rendered markup and the hydration state each embed a copy), so the
  // same physical copy shows up in several blocks. Keying by the inventory id
  // collapses them — without it the optimizer sees phantom duplicate stock and
  // will happily "buy" two of a book ThriftBooks has one of.
  const seen = new Set<string>()

  for (const conditions of extractConditionArrays(html)) {
    for (const cond of conditions) {
      // Filter: must match the requested ISBN (either 10 or 13 digit)
      const matchesIsbn = isbn13 ? cond.ean === isbn13 : cond.isbn === isbn10
      if (!matchesIsbn) continue
      if (!(cond.price > 0)) continue

      const key = `${cond.idIq ?? cond.idAmazon}_${cond.quality}_${cond.price}`
      if (seen.has(key)) continue
      seen.add(key)

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
        listing_id: `tb_${cond.idIq ?? cond.idAmazon}`,
        seller_id: 'thriftbooks',
        seller_name: 'ThriftBooks',
        price: cond.price,
        shipping_base: 3.99,
        shipping_per_additional: 0,
        condition: conditionText,
        condition_normalized: normalizeCondition(cond.quality),
        signed: false,
        first_edition: false,
        // `noDj` marks copies known to be missing a jacket. Its absence says
        // nothing — most of this catalogue is paperback — so claiming a jacket
        // here would both mislead and hijack the "dust jacket only" filter.
        dust_jacket: false,
        url: listingUrl,
        isbn: requestedIsbn,
      })
    }
  }

  return listings
}
