/**
 * press — settings that can be changed without a deploy.
 *
 * `loadSettings()` reads the environment and is synchronous, and about twenty
 * call sites depend on both facts — including module-level initialisation in
 * `db.ts`, which runs before any await is possible. So it does not "grow a
 * database read". This goes beside it instead: the same shape, async, with the
 * single `press_settings` row layered on top of the environment.
 *
 * Env stays the floor. A column that is NULL means "not set here", and the
 * environment's answer stands — so a database that has never been filled in
 * behaves exactly as today, and a form that is half-completed cannot take away
 * a value that was working.
 *
 * Secrets are deliberately absent. LULU_CLIENT_SECRET, RAINDROP_TOKEN and
 * SUPABASE_SERVICE_ROLE_KEY are env-only and stay that way: a settings form is
 * not a place to keep a secret, and the card itself never comes near this app
 * at all — Lulu bills the account on file.
 *
 * See docs/plans/2026-08-31-003-feat-press-workbench-plan.md §5.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { pressDb, recordEvent } from './db'
import { loadSettings, type PressSettings } from './settings'

/** The `press_settings` row, exactly as the form edits it. */
export interface PressSettingsRow {
  ship_name: string | null
  ship_street1: string | null
  ship_street2: string | null
  ship_city: string | null
  ship_state: string | null
  ship_postcode: string | null
  ship_country: string
  ship_phone: string | null
  contact_email: string | null
  page_threshold: number
  copies: number
  lulu_package_id: string | null
  lulu_sandbox: boolean
  updated_at?: string
}

export const SETTINGS_DEFAULTS: PressSettingsRow = {
  ship_name: null,
  ship_street1: null,
  ship_street2: null,
  ship_city: null,
  ship_state: null,
  ship_postcode: null,
  ship_country: 'US',
  ship_phone: null,
  contact_email: null,
  page_threshold: 100,
  copies: 1,
  lulu_package_id: null,
  // Production is opt-in here exactly as it is in the environment.
  lulu_sandbox: true,
}

export async function readSettingsRow(
  db: SupabaseClient = pressDb(),
): Promise<PressSettingsRow | null> {
  const { data, error } = await db.from('press_settings').select('*').eq('id', true).maybeSingle()
  if (error) throw new Error(`press/settings: read: ${error.message}`)
  return (data as PressSettingsRow) ?? null
}

export async function writeSettingsRow(
  patch: Partial<PressSettingsRow>,
  db: SupabaseClient = pressDb(),
): Promise<PressSettingsRow> {
  const { data, error } = await db
    .from('press_settings')
    .upsert({ id: true, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'id' })
    .select()
    .single()
  if (error) throw new Error(`press/settings: write: ${error.message}`)
  // The address is not logged, here or anywhere: only which fields moved.
  await recordEvent({ kind: 'settings_changed', detail: { fields: Object.keys(patch) } }, db)
  return data as PressSettingsRow
}

/**
 * A shipping address is all-or-nothing.
 *
 * `shippingFromEnv()` already treats a partial address as no address, because
 * a half-filled one fails Lulu's validation late — after the approval link has
 * been followed and the reader believes the thing is bought. The form is
 * honest about the same rule rather than accepting five of seven fields.
 */
export function shippingFromRow(row: PressSettingsRow | null): PressSettings['shipping'] {
  if (!row) return null
  const { ship_street1: street1, ship_city: city, ship_postcode: postcode } = row
  if (!street1 || !city || !postcode) return null
  return {
    name: row.ship_name ?? '',
    street1,
    street2: row.ship_street2 || null,
    city,
    stateCode: row.ship_state ?? '',
    postcode,
    countryCode: row.ship_country || 'US',
    phone: row.ship_phone ?? '',
  }
}

/**
 * The environment, with the database row layered over it.
 *
 * Use this anywhere that can await — the order flow, the settings form, the
 * worker's tick. Everything else keeps `loadSettings()` and the env values,
 * which is what it has today.
 */
export async function loadEffectiveSettings(
  db: SupabaseClient = pressDb(),
): Promise<PressSettings & { row: PressSettingsRow | null; copies: number }> {
  const base = loadSettings()

  let row: PressSettingsRow | null = null
  try {
    row = await readSettingsRow(db)
  } catch (err) {
    // Narrow on purpose. A missing table means 013 has not been applied yet,
    // and falling back to the environment is exactly right — it answered every
    // one of these questions exclusively until this table existed.
    //
    // Anything else is not. A transient failure here would silently ship an
    // order to whatever PRESS_SHIP_* says instead of the address in the row,
    // and snapshot that wrong address into press_orders.ship_to as though it
    // had been chosen. Better to fail than to post a book to the wrong house.
    if (!/relation .*press_settings.* does not exist|schema cache/i.test((err as Error).message)) {
      throw err
    }
    row = null
  }

  return {
    ...base,
    row,
    // Non-null wins; NULL means "not set here" and the env answer stands.
    shipping: shippingFromRow(row) ?? base.shipping,
    mailTo: row?.contact_email || base.mailTo,
    pageThreshold: row?.page_threshold ?? base.pageThreshold,
    luluPackageId: row?.lulu_package_id || base.luluPackageId,
    // A boolean column has no "unset", so an existing row is authoritative for
    // sandbox. That is the safe direction: the row defaults to TRUE.
    luluSandbox: row ? row.lulu_sandbox : base.luluSandbox,
    copies: row?.copies ?? 1,
  }
}
