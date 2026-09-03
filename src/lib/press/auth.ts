/**
 * press — who is signed in.
 *
 * Supabase Auth with magic links. A password would be a support burden for an
 * audience of about six people and none of them would remember it; a link in
 * an email is the whole ceremony.
 *
 * Two identity tables, and the split is deliberate. `auth.users` is Supabase's
 * — it exists because somebody signed in. `press_accounts` is ours: it is the
 * invitation, and it can exist for months before anybody accepts it. The first
 * sign-in matches them by email and writes `auth_user_id` onto the waiting row
 * (`attachAccount` below). Nothing else in press ever looks at `auth.users`.
 *
 * Invite-only, and not for the sake of the data. An account is somebody who
 * can make the one Fly machine render a hundred pages and make this app fetch
 * arbitrary URLs on their behalf; an open sign-up turns both of those into
 * somebody else's resource. The list is `press_accounts`, and the check
 * happens before a link is ever sent (see the sign-in action).
 *
 * None of which applies on a laptop — see `runningLocally` below.
 *
 * Server-only.
 */

import { cookies, headers } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { pressDbAsService } from './db'
import type { PressAccount } from './accounts'

/** The public pair. The anon key is meant to be in the browser. */
function publicKeys(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  if (!url || !anonKey) return null
  return { url, anonKey }
}

/** The pair, or a sentence saying which half is missing. For the sign-in form. */
function requirePublicKeys(): { url: string; anonKey: string } {
  const keys = publicKeys()
  if (!keys) {
    throw new Error(
      'press/auth: missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY — sign-in needs both',
    )
  }
  return keys
}

/**
 * A client that reads and writes the session cookie.
 *
 * The anon key, not the service one: this speaks to GoTrue on behalf of the
 * person at the keyboard, and it is the only Supabase client in press that is
 * allowed to know who they are. Reading their *reading* is still
 * `pressDb(owner)` with the service key — see db.ts for why.
 */
export async function sessionClient(): Promise<SupabaseClient> {
  const store = await cookies()
  const { url, anonKey } = requirePublicKeys()

  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll(written) {
        try {
          for (const { name, value, options } of written) store.set(name, value, options)
        } catch {
          // Called from a Server Component, where cookies are read-only. The
          // middleware refreshes the session on every request, so nothing is
          // lost by the write not landing here.
        }
      },
    },
  })
}

/**
 * The signed-in Supabase user, or null.
 *
 * Null rather than a throw when the public keys are missing, because that is
 * the honest answer: with no anon key, nobody can be signed in. It matters on
 * a laptop, where `currentAccount()` falls through to the owner and press
 * works as it always did — before this, a `.env.local` with no anon key in it
 * turned every page into a 500 about a key only the sign-in form needs.
 *
 * Deployed it changes nothing: the middleware refuses every request outright
 * when the keys are absent, so nothing gets far enough to ask.
 */
export async function signedInUser(): Promise<User | null> {
  if (!publicKeys()) return null

  const supabase = await sessionClient()
  // getUser, not getSession: the session cookie is whatever the browser sent,
  // and only getUser asks the server whether the token in it is real.
  const { data } = await supabase.auth.getUser()
  return data.user ?? null
}

/**
 * Attach a Supabase user to the invitation waiting for their address.
 *
 * Idempotent, and matched on email rather than on anything the user controls:
 * the invitation names an address, and signing in proves you read mail at it.
 * Returns null when nobody invited them — which is how an uninvited sign-in is
 * refused, after Supabase has happily created a user for them.
 */
export async function attachAccount(user: User): Promise<PressAccount | null> {
  const email = user.email?.trim()
  if (!email) return null

  const db = pressDbAsService()

  // Already attached: the common case, and one query.
  const { data: mine } = await db
    .from('press_accounts')
    .select('*')
    .eq('auth_user_id', user.id)
    .maybeSingle()
  if (mine) return mine as PressAccount

  const { data: invited } = await db
    .from('press_accounts')
    .select('*')
    .ilike('email', email)
    .is('auth_user_id', null)
    .maybeSingle()
  if (!invited) return null

  const { data: attached, error } = await db
    .from('press_accounts')
    .update({ auth_user_id: user.id, updated_at: new Date().toISOString() })
    .eq('id', (invited as PressAccount).id)
    // Only if nobody beat us to it — two tabs finishing the same magic link is
    // two of these running at once.
    .is('auth_user_id', null)
    .select()
    .maybeSingle()
  if (error) throw new Error(`press/auth: attachAccount: ${error.message}`)

  return (attached as PressAccount) ?? (invited as PressAccount)
}

/** The press account of whoever is signed in, or null if nobody is. */
export async function signedInAccount(): Promise<PressAccount | null> {
  const user = await signedInUser()
  if (!user) return null
  return attachAccount(user)
}


/**
 * Is this a laptop rather than a deployment?
 *
 * If so, there is nothing to sign in to: `currentAccount()` returns the owner
 * and every page just works, which is how press behaved for its whole life
 * before sign-in existed (`PRESS_PASSWORD` unset meant open, and the file that
 * did it said "localhost stays frictionless" in as many words).
 *
 * It gives away nothing. Reaching press at all needs `.env.local`, and
 * `.env.local` holds `SUPABASE_SERVICE_ROLE_KEY` — which is every account's
 * everything, with or without a session. Asking somebody holding that key to
 * prove who they are is ceremony, not security.
 *
 * Three conditions, and all three have to hold:
 *
 *   Not on Vercel. `VERCEL` is set on every deployment there, preview builds
 *   included — and a preview is internet-reachable, so `NODE_ENV` would be the
 *   wrong test: Vercel builds previews with NODE_ENV=production, but a
 *   `next dev` on a tunnel would look local to it either way.
 *
 *   The host really is loopback. Not "not production" but the actual Host
 *   header, so putting a dev server behind a tunnel to view it from a phone
 *   asks for a session, exactly as the old password did.
 *
 *   PRESS_REQUIRE_SIGN_IN is not set. The escape hatch, for checking the
 *   signed-in path from a laptop that would otherwise skip it.
 */
export async function runningLocally(): Promise<boolean> {
  if (onVercel()) return false
  // Bracket access, not `process.env.PRESS_REQUIRE_SIGN_IN`. Next replaces the
  // dotted form with its build-time value in server chunks as well as client
  // ones, so the dotted form compiles to `undefined === '1'` and the flag
  // silently does nothing when set at start-up — which is exactly when you
  // want to set it. This form survives to runtime.
  if (env('PRESS_REQUIRE_SIGN_IN') === '1') return false
  return isLoopback((await headers()).get('host'))
}

/** Read at runtime, past Next's build-time inlining of `process.env.X`. */
function env(name: string): string | undefined {
  return process.env[name]
}

/**
 * Any Vercel deployment, preview builds included.
 *
 * `VERCEL` is set during the build there as well as at runtime, so the
 * inlining works in this one's favour either way — but read the same way as
 * everything else, so there is one rule in this file rather than two.
 */
function onVercel(): boolean {
  return Boolean(env('VERCEL'))
}

/** Shared with the middleware, which has a request rather than `headers()`. */
export function isLoopback(host: string | null): boolean {
  if (!host) return false
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host.trim())
}
