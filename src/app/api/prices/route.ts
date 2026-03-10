import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { fetchListingsByISBN } from '@/lib/abebooks'
import type { Listing, PriceResponse } from '@/lib/types'

const CACHE_TTL_HOURS = 6

export async function POST(req: NextRequest) {
  const { isbns }: { isbns: string[] } = await req.json()
  if (!isbns || isbns.length === 0) {
    return NextResponse.json({ listings: {}, sources: [] } satisfies PriceResponse)
  }

  const allListings: Record<string, Listing[]> = {}

  for (const isbn of isbns) {
    // Check cache
    const { data: cached } = await supabase
      .from('price_cache')
      .select('listings, cached_at')
      .eq('isbn', isbn)
      .single()

    if (cached) {
      const age = Date.now() - new Date(cached.cached_at).getTime()
      if (age < CACHE_TTL_HOURS * 3600 * 1000) {
        allListings[isbn] = cached.listings as Listing[]
        continue
      }
    }

    // Fetch fresh from AbeBooks
    const listings = await fetchListingsByISBN(isbn)
    allListings[isbn] = listings

    // Only cache real results (non-empty)
    if (listings.length > 0) {
      await supabase.from('price_cache').upsert({
        isbn,
        listings,
        cached_at: new Date().toISOString(),
      })
    }
  }

  // Build per-source summary (AbeBooks only for now — ThriftBooks and BetterWorldBooks
  // use Cloudflare/AWS WAF protection that blocks server-side requests)
  const totalFound = Object.values(allListings).reduce((n, ls) => n + ls.length, 0)
  const sources = [{
    name: 'AbeBooks',
    search_url: `https://www.abebooks.com/servlet/SearchResults?isbn=${isbns[0]}&sortby=17`,
    found: totalFound,
  }]

  return NextResponse.json({ listings: allListings, sources } satisfies PriceResponse)
}
