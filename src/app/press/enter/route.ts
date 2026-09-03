/**
 * press — the owner's door.
 *
 *   /press/enter?key=<PRESS_OWNER_KEY>   → sets the cookie, goes to /press
 *   /press/enter?leave=1                 → clears it
 *
 * Bookmark the first one and it is a button: one click, straight into the
 * workbench, no address to type and no link to wait for. The key is spent once
 * and remembered for a year; rotating `PRESS_OWNER_KEY` in the environment
 * invalidates every browser that has it, which is the whole of "sign out
 * everywhere".
 *
 * **The URL is a password.** Anybody holding it is the owner — they can read
 * every article, place an order, and change the shipping address. It belongs
 * in a bookmark and nowhere else: not in a message, not in a screenshot, not
 * in a repo. That is the same bargain `PRESS_PASSWORD` made, and it is why
 * this is opt-in: with `PRESS_OWNER_KEY` unset the route does not work at all.
 *
 * Outside the middleware's matcher, necessarily — this is where the credential
 * comes from, so requiring one to reach it is a loop.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { OWNER_COOKIE, OWNER_COOKIE_MAX_AGE, keysMatch, ownerKey } from '@/lib/press/auth'
import { pressUiEnabled } from '@/lib/press/local'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  if (!pressUiEnabled()) return new NextResponse('not found', { status: 404 })

  // Leaving needs no key: it only ever removes something.
  if (request.nextUrl.searchParams.get('leave') === '1') {
    const out = NextResponse.redirect(new URL('/press/sign-in', request.url))
    out.cookies.delete(OWNER_COOKIE)
    return out
  }

  const expected = ownerKey()
  const given = request.nextUrl.searchParams.get('key')

  // 404 for a door that does not exist, and 404 for a wrong key — the two are
  // deliberately indistinguishable, so probing this URL says nothing about
  // whether there is anything here to find.
  if (!expected || !given || !keysMatch(given, expected)) {
    return new NextResponse('not found', { status: 404 })
  }

  const response = NextResponse.redirect(new URL('/press', request.url))
  response.cookies.set(OWNER_COOKIE, expected, {
    httpOnly: true,
    // Never over plain HTTP, except on a laptop — where there is no TLS and
    // also nothing to protect, because localhost is already the owner.
    secure: request.nextUrl.protocol === 'https:',
    sameSite: 'lax',
    path: '/',
    maxAge: OWNER_COOKIE_MAX_AGE,
  })
  return response
}
