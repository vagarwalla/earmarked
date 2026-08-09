import { NextRequest, NextResponse } from 'next/server'
import { parseGoodreadsUserId, parseGoodreadsShelfFromUrl, fetchShelves } from '@/lib/goodreadsShelf'

// Every account has these even if neither scraped page lists them
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

  // A pasted shelf URL (?shelf=… or ?tag=…) names the exact shelf to import
  const requestedShelf = parseGoodreadsShelfFromUrl(user)

  try {
    let shelves = await fetchShelves(userId)
    if (shelves.length === 0) {
      // Page layouts changed or shelves not listed — offer the built-in shelves
      shelves = DEFAULT_SHELVES.map((name) => ({ name, count: -1 }))
    }
    if (requestedShelf && !shelves.some((s) => s.name === requestedShelf)) {
      shelves = [{ name: requestedShelf, count: -1 }, ...shelves]
    }
    return NextResponse.json({ userId, shelves, requestedShelf })
  } catch {
    if (requestedShelf) {
      // Shelf pages unreachable but the URL already tells us which shelf to load
      return NextResponse.json({
        userId,
        shelves: [{ name: requestedShelf, count: -1 }],
        requestedShelf,
      })
    }
    return NextResponse.json(
      { error: 'Could not reach Goodreads. Check the profile is public and try again.' },
      { status: 502 }
    )
  }
}
