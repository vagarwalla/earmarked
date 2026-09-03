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
 * Open: anybody who can read mail at an address can have a press. Signing in
 * with an address nobody has used creates the account, and it starts empty —
 * their own pool, their own issue numbers, nothing of anybody else's.
 *
 * That is a deliberate loosening, and worth being clear about what it costs.
 * An account is somebody who can make the one Fly machine render a hundred
 * pages and make this app fetch arbitrary URLs on their behalf. The controls
 * on that are the per-account paste caps in `paste.ts` (fifty a paste, two
 * hundred a day) and the fact that `can_order` is false for everybody but the
 * owner, so nobody else can spend money. `PRESS_INVITE_ONLY=1` closes it back
 * to the `press_accounts` list if it ever needs closing.
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

/** Closed back to the `press_accounts` list. Read at runtime; see `env`. */
export function inviteOnly(): boolean {
  return env('PRESS_INVITE_ONLY') === '1'
}

/**
 * The public half of somebody's name, from their address.
 *
 * `alex.whitby+reading@example.com` becomes `alex-whitby`. It ends up in a URL
 * anyone can open, so the domain is dropped — a handle is not an email address
 * and should not read like one — and so is everything after a `+`, which is a
 * routing detail rather than part of who they are.
 */
export function handleFrom(email: string): string {
  const local = email.split('@')[0]?.split('+')[0] ?? ''
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  // Something is always a handle. An address that is entirely punctuation
  // before the @ is unlikely and should still get a press.
  return /^[a-z0-9]/.test(cleaned) ? cleaned : `reader-${cleaned}` || 'reader'
}

/**
 * Attach a Supabase user to their press, making one if they have none.
 *
 * Idempotent, and matched on email rather than on anything the user controls:
 * an address is what a magic link proves you can read.
 *
 * Three cases, in order of how often they happen:
 *
 *   Already attached — one query, the common path on every request.
 *   Invited by name — a row V wrote with `press:invite`, waiting for them.
 *     Claimed rather than duplicated, so the handle she chose is the one they
 *     get.
 *   Nobody has heard of them — a new press, unless `PRESS_INVITE_ONLY=1`, in
 *     which case null and the caller refuses them.
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

  if (invited) {
    const { data: attached, error } = await db
      .from('press_accounts')
      .update({ auth_user_id: user.id, updated_at: new Date().toISOString() })
      .eq('id', (invited as PressAccount).id)
      // Only if nobody beat us to it — two tabs finishing the same magic link
      // is two of these running at once.
      .is('auth_user_id', null)
      .select()
      .maybeSingle()
    if (error) throw new Error(`press/auth: attachAccount: ${error.message}`)
    return (attached as PressAccount) ?? (invited as PressAccount)
  }

  if (inviteOnly()) return null
  return createAccount(user.id, email, db)
}

/** How many `-2`, `-3` suffixes to try before giving up on a nice handle. */
const HANDLE_ATTEMPTS = 20

/**
 * A new, empty press.
 *
 * `can_order` is false and is not a parameter: ordering bills the one Lulu
 * account on file, and no sign-in should ever be able to reach it.
 *
 * The handle races — two people called alex signing in at once — so the
 * uniqueness is settled by the index and the retry rather than by a check
 * beforehand, which would be the same race with extra steps.
 */
async function createAccount(
  authUserId: string,
  email: string,
  db: SupabaseClient,
): Promise<PressAccount> {
  const base = handleFrom(email)

  for (let attempt = 0; attempt < HANDLE_ATTEMPTS; attempt++) {
    const handle = attempt === 0 ? base : `${base}-${attempt + 1}`
    const { data, error } = await db
      .from('press_accounts')
      .insert({ auth_user_id: authUserId, email, handle, can_order: false })
      .select()
      .single()

    if (!error) return data as PressAccount
    // 23505 is unique_violation. On `handle` it means try the next suffix; on
    // `auth_user_id` it means two tabs finished the same link and the other
    // one won, so go and read what it wrote.
    if (error.code !== '23505') {
      throw new Error(`press/auth: createAccount: ${error.message}`)
    }
    const { data: theirs } = await db
      .from('press_accounts')
      .select('*')
      .eq('auth_user_id', authUserId)
      .maybeSingle()
    if (theirs) return theirs as PressAccount
  }

  throw new Error(
    `press/auth: could not find a free handle near "${base}" — try signing in with a different address`,
  )
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
