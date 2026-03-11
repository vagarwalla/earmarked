// BookFinder is a price-aggregation site that scrapes 40+ used-book stores,
// including ThriftBooks and BetterWorldBooks, and serves everything as
// server-rendered HTML — no WAF blocking, no JS needed.
//
// Parsing approach reverse-engineered from bookfind.py (github.com/rayment/bookfind):
//   - `class="results-table-Logo"` marks section headers: 1st = new books, 2nd = used
//   - Elements with `data-price="N.NN"` delimit individual listing rows
//   - `class="results-price"` holds <a href="...?bu=ENCODED_STORE_URL">$PRICE</a>
//   - The decoded `bu` query param is the actual store listing URL
//   - `class="item-note"` contains optional condition text

import type { Listing } from './types'
import { normalizeCondition } from './abebooks'

const SEARCH_URL = 'https://bookfinder.com/search/'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://bookfinder.com/',
}

export async function fetchBookFinderListings(isbn: string): Promise<Listing[]> {
  const url = `${SEARCH_URL}?keywords=${isbn}&currency=USD&destination=us&lang=en&st=sh&ac=qr&submit=`
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      console.error(`BookFinder search failed: ${res.status}`)
      return []
    }
    const html = await res.text()
    return parseBookFinderHTML(html, isbn)
  } catch (err) {
    console.error('BookFinder fetch error:', err)
    return []
  }
}

function decodeStoreUrl(href: string): string | null {
  const qIdx = href.indexOf('?')
  if (qIdx < 0) return null
  try {
    const params = new URLSearchParams(href.slice(qIdx + 1))
    let bu = params.get('bu')
    if (!bu) return null
    // Handle double-encoded URLs (decode again if still percent-encoded)
    if (bu.includes('%')) {
      try { bu = decodeURIComponent(bu) } catch {}
    }
    return bu
  } catch {
    return null
  }
}

function parseBookFinderHTML(html: string, isbn: string): Listing[] {
  const listings: Listing[] = []

  // Section boundaries: each `results-table-Logo` increments the section counter.
  // Section 1 = new books, section 2 = used books.
  const sectionPositions: number[] = []
  const secRe = /class="results-table-Logo"/g
  let m: RegExpExecArray | null
  while ((m = secRe.exec(html)) !== null) sectionPositions.push(m.index)

  // Slice HTML into per-listing chunks using data-price positions as boundaries
  const pricePositions: number[] = []
  const priceRe = /data-price="/g
  while ((m = priceRe.exec(html)) !== null) pricePositions.push(m.index)

  for (let i = 0; i < pricePositions.length; i++) {
    const start = pricePositions[i]
    // Cap chunk at next listing or 5 000 chars to avoid runaway matches
    const end = Math.min(pricePositions[i + 1] ?? html.length, start + 5000)
    const chunk = html.slice(start, end)

    // Section: count markers before this listing's position
    const section = sectionPositions.filter(sp => sp <= start).length  // 1=new, 2=used

    // Price from data-price attribute
    const priceAttrM = /^data-price="([\d.]+)"/.exec(chunk)
    if (!priceAttrM) continue
    const price = parseFloat(priceAttrM[1])
    if (!price || price <= 0) continue

    // Find the redirect href containing ?bu= (the actual store URL)
    const buHrefM = /href="([^"]*[?&]bu=[^"]*)"/i.exec(chunk)
    if (!buHrefM) continue
    const storeUrl = decodeStoreUrl(buHrefM[1])
    if (!storeUrl) continue

    const isThriftBooks = /thriftbooks\.com/i.test(storeUrl)
    const isBWB = /betterworldbooks\.com/i.test(storeUrl)
    if (!isThriftBooks && !isBWB) continue

    // Condition text from item-note, falling back to section-based inference
    const noteM = /class="item-note"[^>]*>([\s\S]*?)(?=<\/[a-z]|<[a-z][^>]+class=)/.exec(chunk)
    const conditionRaw = noteM
      ? noteM[1].replace(/<[^>]+>/g, '').trim()
      : section === 1 ? 'New' : 'Good'
    const condition = conditionRaw || (section === 1 ? 'New' : 'Good')

    const sellerName = isThriftBooks ? 'ThriftBooks' : 'Better World Books'
    const sellerId = isThriftBooks ? 'thriftbooks' : 'betterworldbooks'

    listings.push({
      listing_id: `bf_${sellerId}_${isbn}_${i}`,
      seller_id: sellerId,
      seller_name: sellerName,
      price,
      // Both ship per-order, not per-book — so shipping_per_additional = 0.
      // ThriftBooks: $3.99/order (free on orders ≥ $15 for club members)
      // Better World Books: $3.99/order standard
      shipping_base: 3.99,
      shipping_per_additional: 0,
      condition,
      condition_normalized: normalizeCondition(condition),
      signed: false,
      first_edition: false,
      dust_jacket: false,
      url: storeUrl,
      isbn,
    })
  }

  return listings
}
