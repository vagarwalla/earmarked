import { NextRequest, NextResponse } from 'next/server'
import { parseGoodreadsUserId, fetchShelves } from '@/lib/goodreadsShelf'

// Every account has these even if the profile page fails to list them
const DEFAULT_SHELVES = ['read', 'currently-reading', 'to-read']

export async function GET(req: NextRequest) {
  const user = req.nextUrl.searchParams.get('user')
  if (!user) return NextResponse.json({ error: 'user required' }, { status: 400 })

  const userId = parseGoodreadsUserId(user)
  if (!userId) {
    return NextResponse.json(
      { error: 'Could not find a Goodreads user ID. Paste your profile URL (goodreads.com/user/show/…) or numeric ID.' },
      { status: 400 }
    )
  }

  try {
    let shelves = await fetchShelves(userId)
    if (shelves.length === 0) {
      // Profile page layout changed or shelves not listed — offer the built-in shelves
      shelves = DEFAULT_SHELVES.map((name) => ({ name, count: -1 }))
    }
    return NextResponse.json({ userId, shelves })
  } catch {
    return NextResponse.json(
      { error: 'Could not reach Goodreads. Check the profile is public and try again.' },
      { status: 502 }
    )
  }
}
