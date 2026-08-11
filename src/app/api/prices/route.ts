import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { fetchListingsByISBN } from '@/lib/abebooks'
import { fetchThriftBooksListings } from '@/lib/thriftbooks'
import { fetchBWBListings } from '@/lib/bwb'
import type { Listing, PriceResponse, SourceFetch, SourceInfo } from '@/lib/types'

const CACHE_TTL_HOURS = 6

// ISBNs are fetched concurrently. Serially they cannot fit the budget: BWB alone
// costs ~10s per ISBN (Cloudflare challenge wait), so a one-at-a-time loop blows
// the 60s function limit (vercel.json) after roughly six books and the whole
// request dies — which reads downstream as "no listings for any of these books".
const FETCH_CONCURRENCY = 4

// Stop starting new lookups here and return what we have, so a big stack yields
// partial results plus an honest list of what went unchecked.
const DEADLINE_MS = 45_000

const SOURCES: Array<{
  name: string
  fetch: (isbn: string) => Promise<SourceFetch>
  searchUrl: (isbn: string) => string
}> = [
  {
    name: 'AbeBooks',
    fetch: fetchListingsByISBN,
    searchUrl: (isbn) => `https://www.abebooks.com/servlet/SearchResults?isbn=${isbn}&sortby=17`,
  },
  {
    name: 'ThriftBooks',
    fetch: fetchThriftBooksListings,
    searchUrl: (isbn) => `https://www.thriftbooks.com/browse/?b.search=${isbn}`,
  },
  {
    name: 'Better World Books',
    fetch: fetchBWBListings,
    searchUrl: (isbn) => `https://www.betterworldbooks.com/search/results?q=${isbn}`,
  },
]

/** First line only, clipped — some drivers (Playwright) throw multi-line banners. */
function summarize(error: string | null): string | null {
  if (!error) return null
  const firstLine = error.split('\n')[0].trim()
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now()
  try {
    const body = await req.json().catch(() => null)
    const isbns: string[] = Array.isArray(body?.isbns) ? body.isbns : []
    if (isbns.length === 0) {
      return NextResponse.json({ listings: {}, sources: [], unchecked_isbns: [] } satisfies PriceResponse)
    }

    const unique = [...new Set(isbns)]
    const allListings: Record<string, Listing[]> = {}
    const health = SOURCES.map(() => ({ found: 0, failed: 0, error: null as string | null }))

    // One cache round-trip for the whole batch instead of a query per ISBN.
    // A cache outage must not take price search down with it — worst case we
    // re-scrape everything.
    let cachedRows: Array<{ isbn: string; listings: unknown; cached_at: string }> | null = null
    try {
      const { data } = await supabase
        .from('price_cache')
        .select('isbn, listings, cached_at')
        .in('isbn', unique)
      cachedRows = data
    } catch (err) {
      console.error('price_cache read failed:', (err as Error).message)
    }

    const cutoff = Date.now() - CACHE_TTL_HOURS * 3600 * 1000
    const cached = new Set<string>()
    for (const row of cachedRows ?? []) {
      if (new Date(row.cached_at).getTime() >= cutoff) {
        allListings[row.isbn] = row.listings as Listing[]
        cached.add(row.isbn)
      }
    }

    const queue = unique.filter((isbn) => !cached.has(isbn))
    const unchecked: string[] = []
    const toCache: Array<{ isbn: string; listings: Listing[]; cached_at: string }> = []

    let cursor = 0
    await Promise.all(
      Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, async () => {
        while (cursor < queue.length) {
          const isbn = queue[cursor++]
          if (Date.now() - startedAt > DEADLINE_MS) {
            unchecked.push(isbn)
            continue
          }

          const results = await Promise.all(SOURCES.map((s) => s.fetch(isbn)))
          const listings: Listing[] = []
          results.forEach((result, i) => {
            if (result.error) {
              health[i].failed++
              health[i].error ??= result.error
            } else {
              health[i].found += result.listings.length
            }
            listings.push(...result.listings)
          })

          allListings[isbn] = listings
          // Only cache real results, so a blocked scraper can't poison the cache
          // with emptiness for the next six hours.
          if (listings.length > 0) {
            toCache.push({ isbn, listings, cached_at: new Date().toISOString() })
          }
        }
      }),
    )

    if (toCache.length > 0) {
      try {
        const { error } = await supabase.from('price_cache').upsert(toCache)
        if (error) console.error('price_cache upsert failed:', error.message)
      } catch (err) {
        // Losing the write costs a re-scrape later; losing the results costs the request.
        console.error('price_cache upsert threw:', (err as Error).message)
      }
    }

    const sources: SourceInfo[] = SOURCES.map((source, i) => ({
      name: source.name,
      search_url: source.searchUrl(unique[0]),
      found: health[i].found,
      failed: health[i].failed,
      error: summarize(health[i].error),
    }))

    for (const s of sources) {
      if (s.failed > 0) console.error(`${s.name}: ${s.failed}/${queue.length} lookups failed — ${s.error}`)
    }
    if (unchecked.length > 0) {
      console.error(`prices: ${unchecked.length} ISBNs unchecked after ${Date.now() - startedAt}ms`)
    }

    return NextResponse.json({ listings: allListings, sources, unchecked_isbns: unchecked } satisfies PriceResponse)
  } catch (err) {
    console.error('prices route failed:', err)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
