/**
 * press — the door, and keeping the session behind it fresh.
 *
 * This was HTTP Basic with a single shared `PRESS_PASSWORD`, and its own
 * comment said "the user half is ignored; there is one reader". That was true
 * for as long as there was one reader. It is a Supabase session now: sign-in
 * is a magic link (see src/lib/press/auth.ts), the invitation is a
 * `press_accounts` row, and which account you are is what every page and route
 * scopes its database client to.
 *
 * Two jobs, and both have to happen here:
 *
 *   Refresh. A Supabase access token is short-lived, and a Server Component
 *   cannot write cookies — so if nothing refreshed on the way in, a session
 *   would expire mid-visit and the page would have no way to say so. Every
 *   request through here gets `getUser()` called on it, which rotates the
 *   cookie when it needs rotating.
 *
 *   Refuse. No session means the sign-in page for anything you look at, and a
 *   401 for anything a script calls. Which account you are is *not* decided
 *   here: that is `currentAccount()`, server-side, on the far side of this,
 *   because the answer needs the service-role key and belongs next to the
 *   query it scopes.
 *
 * Deliberately NOT covered, exactly as before: /press/confirm/[token] and
 * /api/press/action/[token] carry their own signed one-time tokens and are
 * opened from an email on a phone, and /api/press/email-in authenticates with
 * a webhook secret. Demanding a session there would break the approval loop.
 * /press/sign-in and /press/auth/callback are where a session comes from, so
 * requiring one to reach them is a redirect loop.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

/** JSON for the API, a page for a person. Both say the same thing. */
function refuse(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Sign in to use press.' }, { status: 401 })
  }
  const url = new URL('/press/sign-in', request.url)
  return NextResponse.redirect(url)
}

export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  // Fail closed. An unconfigured deployment used to mean "open, by design"
  // — `PRESS_PASSWORD` unset was the frictionless local default — and that
  // default is wrong now that the pages behind it belong to several people.
  if (!url || !anonKey) return refuse(request)

  // The response the refreshed cookies are written onto. Built before the
  // call, because `setAll` fires during it.
  let response = NextResponse.next({ request })

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(written) {
        for (const { name, value } of written) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of written) response.cookies.set(name, value, options)
      },
    },
  })

  // getUser, not getSession: the cookie is whatever the browser sent, and only
  // this asks the server whether the token inside it is real. It is also what
  // does the refreshing.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return refuse(request)
  return response
}

export const config = {
  matcher: [
    // The workbench, but not /press/sign-in, /press/auth/* or
    // /press/confirm/[token] beneath it.
    '/press',
    '/api/press/issue/:path*',
    '/api/press/file/:path*',
    // A pool you can delete from, an address you can change and a button that
    // spends money all need the same session the page does — and a matcher
    // that lists routes one by one is a matcher that will one day be missing
    // one, so every new /api/press/* route belongs here unless it is
    // deliberately public like action/ and email-in/.
    '/api/press/item/:path*',
    '/api/press/paste',
    '/api/press/job',
    '/api/press/job/:path*',
    '/api/press/settings',
    '/api/press/orders',
    '/api/press/order',
  ],
}
