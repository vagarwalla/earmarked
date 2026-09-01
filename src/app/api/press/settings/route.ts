/**
 * press — the settings form's two verbs.
 *
 *   GET   the row, plus what the environment would answer for anything it
 *         leaves NULL, so the form can show the effective value and say where
 *         it came from
 *   PUT   the row
 *
 * No secret is readable or writable here. LULU_CLIENT_SECRET, RAINDROP_TOKEN
 * and SUPABASE_SERVICE_ROLE_KEY stay in the environment; the card never comes
 * near this app at all, because Lulu bills the account on file. See plan §5.
 */

import { NextResponse } from 'next/server'
import {
  SETTINGS_DEFAULTS,
  loadEffectiveSettings,
  readSettingsRow,
  shippingFromRow,
  writeSettingsRow,
  type PressSettingsRow,
} from '@/lib/press/settings-db'
import { loadSettings } from '@/lib/press/settings'
import { NOT_FOUND, asResponse, pressUiEnabled } from '../_lib/guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  if (!pressUiEnabled()) return NOT_FOUND()
  try {
    const row = (await readSettingsRow()) ?? SETTINGS_DEFAULTS
    const effective = await loadEffectiveSettings()
    const env = loadSettings()

    return NextResponse.json({
      row,
      // What the environment would answer on its own, so the form can say
      // "inherited from PRESS_SHIP_*" rather than showing an empty box beside
      // an address that is quietly working.
      env: {
        hasShipping: Boolean(env.shipping),
        mailTo: env.mailTo || null,
        pageThreshold: env.pageThreshold,
        luluPackageId: env.luluPackageId || null,
        luluSandbox: env.luluSandbox,
      },
      effective: {
        hasShipping: Boolean(effective.shipping),
        shipping: effective.shipping,
        mailTo: effective.mailTo || null,
        luluSandbox: effective.luluSandbox,
        copies: effective.copies,
        pageThreshold: effective.pageThreshold,
      },
    })
  } catch (err) {
    return asResponse(err)
  }
}

/** Only these columns. Anything else in the body is ignored, not rejected. */
const FIELDS: (keyof PressSettingsRow)[] = [
  'ship_name',
  'ship_street1',
  'ship_street2',
  'ship_city',
  'ship_state',
  'ship_postcode',
  'ship_country',
  'ship_phone',
  'contact_email',
  'page_threshold',
  'copies',
  'lulu_package_id',
  'lulu_sandbox',
]

export async function PUT(request: Request) {
  if (!pressUiEnabled()) return NOT_FOUND()

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  const patch: Record<string, unknown> = {}
  for (const field of FIELDS) {
    if (!(field in body)) continue
    const value = body[field]
    if (field === 'page_threshold' || field === 'copies') {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 1) {
        return NextResponse.json({ error: `${field} must be a positive number.` }, { status: 400 })
      }
      patch[field] = Math.floor(n)
    } else if (field === 'lulu_sandbox') {
      patch[field] = Boolean(value)
    } else if (field === 'ship_country') {
      // NOT NULL with a default; an empty box means "the default", not NULL.
      patch[field] = String(value ?? '').trim().toUpperCase() || 'US'
    } else {
      // Empty string is how a form says "unset", which is NULL, which is how
      // the row says "let the environment answer".
      const text = typeof value === 'string' ? value.trim() : ''
      patch[field] = text || null
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'nothing to change' }, { status: 400 })
  }

  try {
    const row = await writeSettingsRow(patch)
    return NextResponse.json({
      row,
      // The form disables Order with a reason when this is null, so it needs
      // to know immediately rather than after a reload.
      hasShipping: Boolean(shippingFromRow(row) ?? loadSettings().shipping),
    })
  } catch (err) {
    return asResponse(err)
  }
}
