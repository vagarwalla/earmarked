import { NextRequest, NextResponse } from 'next/server'
import { fetchGoodreadsData } from '@/lib/goodreads'

export async function GET(req: NextRequest) {
  const title = req.nextUrl.searchParams.get('title')
  const author = req.nextUrl.searchParams.get('author') ?? ''

  if (!title) return NextResponse.json(null, { status: 400 })

  const data = await fetchGoodreadsData(title, author)
  return NextResponse.json(data, {
    headers: {
      'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=86400',
    },
  })
}
