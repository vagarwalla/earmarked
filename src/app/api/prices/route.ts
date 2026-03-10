import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { fetchListingsByISBN } from '@/lib/abebooks'

const CACHE_TTL_HOURS = 6

export async function POST(req: NextRequest) {
  const { isbns }: { isbns: string[] } = await req.json()
  if (!isbns || isbns.length === 0) {
    return NextResponse.json({})
  }

  const results: Record<string, unknown[]> = {}

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
        results[isbn] = cached.listings
        continue
      }
    }

    // Fetch fresh
    const listings = await fetchListingsByISBN(isbn)
    results[isbn] = listings

    // Only cache real results, not placeholders (price === 0 means fallback)
    const hasRealListings = listings.some((l) => (l as { price: number }).price > 0)
    if (hasRealListings) {
      await supabase.from('price_cache').upsert({
        isbn,
        listings,
        cached_at: new Date().toISOString(),
      })
    }
  }

  return NextResponse.json(results)
}
