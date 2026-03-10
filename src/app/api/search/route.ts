import { NextRequest, NextResponse } from 'next/server'
import { searchBooks } from '@/lib/openLibrary'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get('q')
  if (!query || query.length < 2) {
    return NextResponse.json([])
  }
  const results = await searchBooks(query)
  return NextResponse.json(results, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  })
}
