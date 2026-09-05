import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { fetchListingsByISBN } from '@/lib/abebooks'
import { fetchThriftBooksListings } from '@/lib/thriftbooks'
import { fetchBWBListings } from '@/lib/bwb'
import type { Listing, PriceResponse, SourceFetch, SourceInfo } from '@/lib/types'

const CACHE_TTL_HOURS = 6

// Rows cached before this were written while the AbeBooks scraper was blind to
// the site's new front end (it returned nothing for months), so they hold only
// ThriftBooks results. Ignore them and re-scrape rather than serve them out.
const CACHE_MIN_DATE = Date.parse('2026-09-05T00:00:00Z')

// ISBNs are fetched concurrently. Serially they cannot fit the budget: BWB alone
// costs ~10s per ISBN (Cloudflare challenge wait), so a one-at-a-time loop blows
// the 60s function limit (vercel.json) after roughly six books and the whole
// request dies — which reads downstream as "no listings for any of these books".
const FETCH_CONCURRENCY = 4

// Stop starting new lookups here and return what we have, so a big stack yields
// partial results plus an honest list of what went unchecked.
const DEADLINE_MS = 45_000

// Fast mode is for probing: when the panel is sweeping the other editions of
// a book that came up empty, it asks for the two cheap sources only. Better
// World Books costs ~10s per ISBN behind a browser, which turns a sweep of 40
// editions into minutes; the winners get a full lookup afterwards anyway.
const FAST_CONCURRENCY = 6

// Fast results are cached under their own key so they never stand in for a
// full lookup (they hold no BWB listings), while a full row satisfies both.
const FAST_KEY = 'f:'

const SOURCES: Array<{
  name: string
  fetch: (isbn: string) => Promise<SourceFetch>
  searchUrl: (isbn: string) => string
  /** Included in fast (probe) lookups. */
  fast: boolean
}> = [
  {
    name: 'AbeBooks',
    fetch: fetchListingsByISBN,
    searchUrl: (isbn) => `https://www.abebooks.com/servlet/SearchResults?isbn=${isbn}&sortby=17`,
    fast: true,
  },
  {
    name: 'ThriftBooks',
    fetch: fetchThriftBooksListings,
    searchUrl: (isbn) => `https://www.thriftbooks.com/browse/?b.search=${isbn}`,
    fast: true,
  },
  {
    name: 'Better World Books',
    fetch: fetchBWBListings,
    searchUrl: (isbn) => `https://www.betterworldbooks.com/search/results?q=${isbn}`,
    fast: false,
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
    const fast = body?.fast === true
    if (isbns.length === 0) {
      return NextResponse.json({ listings: {}, sources: [], unchecked_isbns: [] } satisfies PriceResponse)
    }

    const sources = fast ? SOURCES.filter((s) => s.fast) : SOURCES
    const concurrency = fast ? FAST_CONCURRENCY : FETCH_CONCURRENCY
    const unique = [...new Set(isbns)]
    const allListings: Record<string, Listing[]> = {}
    const health = sources.map(() => ({ found: 0, failed: 0, error: null as string | null }))

    // One cache round-trip for the whole batch instead of a query per ISBN.
    // A cache outage must not take price search down with it — worst case we
    // re-scrape everything.
    let cachedRows: Array<{ isbn: string; listings: unknown; cached_at: string }> | null = null
    try {
      const { data } = await supabase
        .from('price_cache')
        .select('isbn, listings, cached_at')
        .in('isbn', fast ? [...unique, ...unique.map((i) => FAST_KEY + i)] : unique)
      cachedRows = data
    } catch (err) {
      console.error('price_cache read failed:', (err as Error).message)
    }

    const cutoff = Math.max(Date.now() - CACHE_TTL_HOURS * 3600 * 1000, CACHE_MIN_DATE)
    const cached = new Set<string>()
    // A full row wins over a fast one for the same ISBN.
    const rows = [...(cachedRows ?? [])].sort((a, b) => Number(a.isbn.startsWith(FAST_KEY)) - Number(b.isbn.startsWith(FAST_KEY)))
    for (const row of rows) {
      const isbn = row.isbn.startsWith(FAST_KEY) ? row.isbn.slice(FAST_KEY.length) : row.isbn
      if (cached.has(isbn)) continue
      if (new Date(row.cached_at).getTime() >= cutoff) {
        allListings[isbn] = row.listings as Listing[]
        cached.add(isbn)
      }
    }

    const queue = unique.filter((isbn) => !cached.has(isbn))
    const unchecked: string[] = []
    const toCache: Array<{ isbn: string; listings: Listing[]; cached_at: string }> = []

    let cursor = 0
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (cursor < queue.length) {
          const isbn = queue[cursor++]
          if (Date.now() - startedAt > DEADLINE_MS) {
            unchecked.push(isbn)
            continue
          }

          const results = await Promise.all(sources.map((s) => s.fetch(isbn)))
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
            toCache.push({ isbn: fast ? FAST_KEY + isbn : isbn, listings, cached_at: new Date().toISOString() })
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

    const sourceInfo: SourceInfo[] = sources.map((source, i) => ({
      name: source.name,
      search_url: source.searchUrl(unique[0]),
      found: health[i].found,
      failed: health[i].failed,
      error: summarize(health[i].error),
    }))

    for (const s of sourceInfo) {
      if (s.failed > 0) console.error(`${s.name}: ${s.failed}/${queue.length} lookups failed — ${s.error}`)
    }
    if (unchecked.length > 0) {
      console.error(`prices: ${unchecked.length} ISBNs unchecked after ${Date.now() - startedAt}ms`)
    }

    return NextResponse.json({ listings: allListings, sources: sourceInfo, unchecked_isbns: unchecked } satisfies PriceResponse)
  } catch (err) {
    console.error('prices route failed:', err)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
