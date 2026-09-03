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
 * Whose press the caller is looking at.
 *
 * The seam. Today there is one account and this returns it; when sign-in lands
 * this reads the session and returns the account attached to it, and every
 * caller is already written to expect an answer that varies.
 *
 * Throws rather than returning null when the account is missing, because the
 * only way that happens is migration 018 not having been applied — and a
 * workbench that silently shows an empty pool in that case is a worse bug than
 * one that says what is wrong.
 */
export async function currentAccount(
  db: SupabaseClient = pressDbAsService(),
): Promise<PressAccount> {
  const account = await accountById(OWNER_ACCOUNT_ID, db)
  if (!account) {
    throw new Error(
      'press: no owner account — run `npm run db:apply -- 018_press_ownership.sql`',
    )
  }
  return account
}

/** The id alone, for the many callers that only need it to scope a client. */
export async function currentOwnerId(db?: SupabaseClient): Promise<string> {
  return (await currentAccount(db)).id
}
