import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { fetchListingsByISBN } from '@/lib/abebooks'
import { fetchBookFinderListings } from '@/lib/bookfinder'
import type { Listing, PriceResponse, SourceInfo } from '@/lib/types'

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

    // Fetch from AbeBooks and BookFinder (ThriftBooks + Better World Books) in parallel
    const [abeListings, bookfinderListings] = await Promise.all([
      fetchListingsByISBN(isbn),
      fetchBookFinderListings(isbn),
    ])
    const listings = [...abeListings, ...bookfinderListings]
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

  const allFlat = Object.values(allListings).flat()
  const abeFound = allFlat.filter(l => l.seller_id !== 'thriftbooks' && l.seller_id !== 'betterworldbooks').length
  const tbFound = allFlat.filter(l => l.seller_id === 'thriftbooks').length
  const bwbFound = allFlat.filter(l => l.seller_id === 'betterworldbooks').length

  const sources: SourceInfo[] = [
    {
      name: 'AbeBooks',
      search_url: `https://www.abebooks.com/servlet/SearchResults?isbn=${isbns[0]}&sortby=17`,
      found: abeFound,
    },
    {
      name: 'ThriftBooks',
      search_url: `https://www.thriftbooks.com/browse/?b.search=${isbns[0]}`,
      found: tbFound,
    },
    {
      name: 'Better World Books',
      search_url: `https://www.betterworldbooks.com/search/results?q=${isbns[0]}`,
      found: bwbFound,
    },
  ]

  return NextResponse.json({ listings: allListings, sources } satisfies PriceResponse)
}
