/**
 * press — who this press belongs to.
 *
 * Ownership hangs off `press_accounts` rather than off `auth.users` directly,
 * because an invitation has to be able to precede the person accepting it: V
 * adds a row, they sign in later, and the sign-in attaches `auth_user_id` to
 * the row that was already waiting. It also means the schema could be made
 * multi-tenant (018) before any of the sign-in existed (019).
 *
 * Until sign-in lands, `currentAccount()` is the owner, always. That is the
 * one seam this file exists to hold: everything downstream already asks "whose
 * press is this" and passes the answer along, so switching the answer from a
 * constant to a session is a change to this file and to nothing else.
 *
 * Server-only.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { pressDbAsService } from './db'

/**
 * V's account, seeded by migration 018 with this literal id.
 *
 * A constant rather than a lookup by handle: it is what every row in the
 * database was backfilled to, and a rename of the handle must not silently
 * change whose reading the workbench shows.
 */
export const OWNER_ACCOUNT_ID = '00000000-0000-0000-0000-000000000001'

export interface PressAccount {
  id: string
  auth_user_id: string | null
  email: string | null
  handle: string
  display_name: string | null
  can_order: boolean
  created_at: string
  updated_at: string
}

/**
 * Look an account up by the id everything else carries.
 *
 * Service-role, necessarily: finding out whose a press is cannot itself be
 * scoped to whoever it turns out to belong to.
 */
export async function accountById(
  id: string,
  db: SupabaseClient = pressDbAsService(),
): Promise<PressAccount | null> {
  const { data, error } = await db.from('press_accounts').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(`press/accounts: accountById: ${error.message}`)
  return (data as PressAccount) ?? null
}

/** By the handle in `/press/by/<handle>`. Case-insensitive, as the index is. */
export async function accountByHandle(
  handle: string,
  db: SupabaseClient = pressDbAsService(),
): Promise<PressAccount | null> {
  const { data, error } = await db
    .from('press_accounts')
    .select('*')
    .ilike('handle', handle)
    .maybeSingle()
  if (error) throw new Error(`press/accounts: accountByHandle: ${error.message}`)
  return (data as PressAccount) ?? null
}

/** By the address an invitation was sent to. */
export async function accountByEmail(
  email: string,
  db: SupabaseClient = pressDbAsService(),
): Promise<PressAccount | null> {
  const { data, error } = await db
    .from('press_accounts')
    .select('*')
    .ilike('email', email.trim())
    .maybeSingle()
  if (error) throw new Error(`press/accounts: accountByEmail: ${error.message}`)
  return (data as PressAccount) ?? null
}

/**
 * The owner's account, whoever is looking.
 *
 * For the two paths that act on V's behalf with no session to read: the
 * inbound email webhook, whose allowlist is hers, and the Raindrop poll, which
 * runs on her token. Everything a person drives goes through `currentAccount`.
 *
 * Throws rather than returning null, because the only way it is missing is
 * migration 018 not having been applied — and a workbench that silently shows
 * an empty pool in that case is a worse bug than one that says what is wrong.
 */
export async function ownerAccount(
  db: SupabaseClient = pressDbAsService(),
): Promise<PressAccount> {
  const account = await accountById(OWNER_ACCOUNT_ID, db)
  if (!account) {
    throw new Error('press: no owner account — run `npm run db:apply -- 018_press_ownership.sql`')
  }
  return account
}

/** A sign-in that got as far as a page it has no account for. */
export class NotInvitedError extends Error {
  constructor() {
    super('That address is not on the list for this press.')
  }
}

/** Nobody is signed in. Distinct from being signed in and uninvited. */
export class NotSignedInError extends Error {
  constructor() {
    super('Sign in to use press.')
  }
}

/**
 * Whose press the caller is looking at.
 *
 * The seam every route and page goes through. It throws rather than returning
 * null in both failure cases, and they are different failures: one is answered
 * with a sign-in page and the other with an explanation, and collapsing them
 * would send an invited person who let their session lapse to a page telling
 * them they are not welcome.
 */
export async function currentAccount(): Promise<PressAccount> {
  // Imported here rather than at the top: `auth.ts` reaches for `next/headers`,
  // which does not exist in the worker or in a script, and both of those call
  // `ownerAccount` from this file.
  const { signedInUser, attachAccount, runningLocally } = await import('./auth')

  const user = await signedInUser()
  if (user) {
    const account = await attachAccount(user)
    if (!account) throw new NotInvitedError()
    return account
  }

  // A laptop is the owner's, and asking it to prove that is ceremony: getting
  // this far needed `.env.local`, which holds the service-role key — every
  // account's everything, session or no session. See `runningLocally`.
  if (await runningLocally()) return ownerAccount()

  throw new NotSignedInError()
}

/** The id alone, for the many callers that only need it to scope a client. */
export async function currentOwnerId(): Promise<string> {
  return (await currentAccount()).id
}
