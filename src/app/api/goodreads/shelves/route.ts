import { NextRequest, NextResponse } from 'next/server'
import {
  parseGoodreadsUserId,
  parseGoodreadsShelfFromUrl,
  fetchShelves,
  GoodreadsError,
} from '@/lib/goodreadsShelf'

// Every account has these even if the profile page lists none of them
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
      // Profile loaded but listed no shelves — layout changed, or the shelves
      // are hidden. The built-in three exist on every account, so offer those.
      shelves = DEFAULT_SHELVES.map((name) => ({ name, count: -1 }))
    }
    if (requestedShelf && !shelves.some((s) => s.name === requestedShelf)) {
      shelves = [{ name: requestedShelf, count: -1 }, ...shelves]
    }
    return NextResponse.json({ userId, shelves, requestedShelf })
  } catch (err) {
    // A missing profile is final: the shelf feeds are gated the same way, so
    // offering shelves here would only push the dead end one screen later.
    if (err instanceof GoodreadsError && err.reason === 'not-found') {
      return NextResponse.json(
        { error: `Goodreads has no public profile at ID ${userId}. Check the URL, and that your profile is set to public.` },
        { status: 404 }
      )
    }
    if (requestedShelf) {
      // Goodreads is flaky but the URL already names the shelf — the RSS feed
      // is a separate surface and may well answer.
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
