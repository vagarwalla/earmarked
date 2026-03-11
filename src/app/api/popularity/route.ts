import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const MAX_ISBNS = 50 // fetch all in parallel — keep total well under route timeout

async function fetchOCLCHoldings(isbn: string): Promise<number> {
  try {
    const url = `https://classify.oclc.org/classify2/Classify?isbn=${isbn}&summary=true`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return 0
    const xml = await res.text()
    // Matches <work ... holdings="N" ...> — works for response codes 0 (single) and 2 (multiple)
    const match = /<work[^>]+holdings="(\d+)"/.exec(xml)
    return match ? parseInt(match[1], 10) : 0
  } catch {
    return 0
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { isbns?: string[] }
  const isbns = (body.isbns ?? []).slice(0, MAX_ISBNS)
  if (isbns.length === 0) return NextResponse.json({})

  // Pull cached rows from Supabase
  const { data: cached } = await supabase
    .from('isbn_popularity')
    .select('isbn, holdings, cached_at')
    .in('isbn', isbns)

  const result: Record<string, number> = {}
  for (const row of cached ?? []) {
    const age = Date.now() - new Date(row.cached_at).getTime()
    if (age < CACHE_TTL_MS) result[row.isbn] = row.holdings
  }

  const uncached = isbns.filter((isbn) => !(isbn in result))

  if (uncached.length > 0) {
    // Fetch all uncached ISBNs in parallel — total time = slowest single request, not sum
    const holdings = await Promise.all(uncached.map(fetchOCLCHoldings))
    const rows = uncached.map((isbn, i) => ({
      isbn,
      holdings: holdings[i],
      cached_at: new Date().toISOString(),
    }))
    for (const row of rows) result[row.isbn] = row.holdings

    // Cache results fire-and-forget — don't block the response on the write
    supabase.from('isbn_popularity').upsert(rows, { onConflict: 'isbn' })
  }

  return NextResponse.json(result)
}
