/**
 * press — the far end of a magic link.
 *
 * Supabase sends the reader here with a one-time code. Exchanging it sets the
 * session cookie; attaching it writes `auth_user_id` onto the invitation that
 * was already waiting for their address.
 *
 * Outside the middleware's matcher, like the sign-in page: this is where a
 * session comes from, so requiring one to reach it is a loop.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { attachAccount, sessionClient } from '@/lib/press/auth'
import { pressUiEnabled } from '@/lib/press/local'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Back to the sign-in page, saying what went wrong in one short phrase. */
function refuse(request: NextRequest, reason: string): NextResponse {
  const url = new URL('/press/sign-in', request.url)
  url.searchParams.set('error', reason)
  return NextResponse.redirect(url)
}

export async function GET(request: NextRequest) {
  if (!pressUiEnabled()) return new NextResponse('not found', { status: 404 })

  const code = request.nextUrl.searchParams.get('code')
  if (!code) return refuse(request, 'no-code')

  const supabase = await sessionClient()
  const { data, error } = await supabase.auth.exchangeCodeForSession(code)
  if (error || !data.user) return refuse(request, 'link-expired')

  // Signed in as far as Supabase is concerned, and still not necessarily
  // welcome: the invitation is a press_accounts row, and somebody could have
  // been removed between the link being sent and being followed. Sign them
  // back out rather than leaving a session that every page will refuse.
  const account = await attachAccount(data.user)
  if (!account) {
    await supabase.auth.signOut()
    return refuse(request, 'not-invited')
  }

  return NextResponse.redirect(new URL('/press', request.url))
}
