/**
 * press — a password on the review UI.
 *
 * /press lists what V has been reading and lets anyone reorder her next issue,
 * so it stayed local-only. Putting it behind a tunnel to view it from
 * elsewhere makes it internet-reachable, and an obscure URL is not a password.
 *
 * HTTP Basic, deliberately: no session store, no cookie, no dependency, and
 * every client — browser, curl, the streaming rebuild fetch — already speaks
 * it. One env var is the whole configuration.
 *
 *   PRESS_PASSWORD unset  → open (localhost stays frictionless)
 *   PRESS_PASSWORD set    → required on /press and the editing APIs
 *
 * Deliberately NOT covered: /press/confirm/[token] and /api/press/action/
 * [token] carry their own signed one-time tokens and are opened from an email
 * on a phone, and /api/press/email-in authenticates with a webhook secret.
 * Demanding a password there would break the approval loop.
 */

import { NextResponse, type NextRequest } from 'next/server'

/** Length-independent comparison, so a wrong guess leaks nothing by timing. */
function secretsMatch(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

function unauthorized(): NextResponse {
  return new NextResponse('Authentication required.', {
    status: 401,
    headers: {
      // Prompts the browser; `curl -u` and fetch credentials both satisfy it.
      'WWW-Authenticate': 'Basic realm="press", charset="UTF-8"',
      'cache-control': 'no-store',
    },
  })
}

export function middleware(request: NextRequest) {
  const password = process.env.PRESS_PASSWORD
  if (!password) return NextResponse.next()

  const header = request.headers.get('authorization')
  if (!header?.startsWith('Basic ')) return unauthorized()

  let decoded: string
  try {
    decoded = atob(header.slice('Basic '.length))
  } catch {
    return unauthorized()
  }

  // "user:pass" — the user half is ignored; there is one reader.
  const supplied = decoded.slice(decoded.indexOf(':') + 1)
  if (!secretsMatch(supplied, password)) return unauthorized()

  return NextResponse.next()
}

export const config = {
  matcher: [
    // The review page itself, but not /press/confirm/[token] beneath it.
    '/press',
    '/api/press/issue/:path*',
    '/api/press/file/:path*',
    // The workbench's own routes. A pool you can delete from, an address you
    // can change and a button that spends money all need the same password the
    // page does — and a matcher that lists routes one by one is a matcher that
    // will one day be missing one, so every new /api/press/* route belongs
    // here unless it is deliberately public like action/ and email-in/.
    '/api/press/item/:path*',
    '/api/press/settings',
    '/api/press/orders',
  ],
}
