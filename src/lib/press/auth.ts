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
 * Server-only.
 */

import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { pressDbAsService } from './db'
import type { PressAccount } from './accounts'

/** The public pair. The anon key is meant to be in the browser. */
function publicKeys(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  if (!url || !anonKey) {
    throw new Error(
      'press/auth: missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY — sign-in needs both',
    )
  }
  return { url, anonKey }
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
  const { url, anonKey } = publicKeys()

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

/** The signed-in Supabase user, or null. */
export async function signedInUser(): Promise<User | null> {
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
