import { NextRequest, NextResponse } from 'next/server'
import { fetchShelfBooks } from '@/lib/goodreadsShelf'

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get('userId')
  const shelf = req.nextUrl.searchParams.get('shelf')
  if (!userId || !shelf) {
    return NextResponse.json({ error: 'userId and shelf required' }, { status: 400 })
  }

  try {
    const { books, ownerName } = await fetchShelfBooks(userId, shelf)
    return NextResponse.json({ books, ownerName })
  } catch {
    return NextResponse.json(
      { error: 'Could not load that shelf from Goodreads. Check the profile is public and try again.' },
      { status: 502 }
    )
  }
}
