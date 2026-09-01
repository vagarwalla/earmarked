/**
 * press — quote and order a printed copy.
 *
 * This is the one step the pipeline could never take. Lulu does not accept an
 * upload: it fetches the interior and the cover from URLs, so an API order
 * needed the PDFs hosted somewhere public, and on a laptop they were not. The
 * runner printed the quote and told you to upload them by hand.
 *
 * They are hosted now — the same Supabase Storage objects the website serves —
 * so this signs a pair of URLs, hands them to Lulu, and places the order.
 *
 *   npm run press:order -- 1               # quote only; changes nothing
 *   npm run press:order -- 1 --confirm     # actually order it
 *
 * Sandbox unless LULU_SANDBOX=false. A sandbox order is free, returns a real
 * job id, and prints nothing — which is the right place to find out that a
 * file fails Lulu's validation.
 *
 * `--confirm` spends real money when LULU_SANDBOX=false. It is deliberately
 * not the default, and the quote is always printed first.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createLuluClient, formatQuote, type ShippingAddress } from '../src/lib/press/lulu'
import { loadSettings } from '../src/lib/press/settings'
import { PRINT_SPEC } from '../src/lib/press/types'

/**
 * Long enough for Lulu to fetch the files during job creation and any retry it
 * makes, short enough that the link is not a standing public copy of V's
 * reading. Lulu pulls them within minutes.
 */
const FILE_URL_TTL_SECONDS = 24 * 60 * 60

function db(): SupabaseClient {
  const { supabaseUrl, supabaseServiceKey } = loadSettings()
  if (!supabaseUrl || !supabaseServiceKey) throw new Error('Supabase is not configured')
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const number = Number.parseInt(args.find((a) => /^\d+$/.test(a)) ?? '', 10)
  const confirm = args.includes('--confirm')
  if (!Number.isFinite(number)) throw new Error('usage: press-order.ts <issue number> [--confirm]')

  const settings = loadSettings()
  if (!settings.luluClientKey || !settings.luluClientSecret) {
    throw new Error('LULU_CLIENT_KEY / LULU_CLIENT_SECRET are unset')
  }
  if (!settings.shipping) {
    throw new Error(
      'no shipping address — set PRESS_SHIP_NAME, PRESS_SHIP_STREET1, PRESS_SHIP_CITY, ' +
        'PRESS_SHIP_STATE, PRESS_SHIP_POSTCODE, PRESS_SHIP_COUNTRY and PRESS_SHIP_PHONE',
    )
  }
  const address: ShippingAddress = settings.shipping

  const supabase = db()
  const { data, error } = await supabase
    .from('press_issues')
    .select('id,number,name,page_total,interior_path,cover_path,lulu_job_id,state')
    .eq('number', number)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error(`no issue ${number} in Supabase — run press:sync first`)

  const issue = data as {
    id: string
    name: string | null
    page_total: number
    interior_path: string | null
    cover_path: string | null
    lulu_job_id: string | null
    state: string
  }

  if (issue.lulu_job_id) {
    throw new Error(`issue ${number} already has Lulu job ${issue.lulu_job_id} — nothing to re-order`)
  }
  if (!issue.interior_path || !issue.cover_path) {
    throw new Error(`issue ${number} has no PDFs in Storage — run press:sync first`)
  }
  if (issue.page_total < PRINT_SPEC.minPages) {
    throw new Error(`${issue.page_total} pages — Lulu needs ${PRINT_SPEC.minPages} to perfect-bind`)
  }
  if (issue.page_total % 2 !== 0) {
    throw new Error(`${issue.page_total} pages is odd; the interior must pad to an even count`)
  }

  const title = issue.name ?? `Issue ${number}`
  const sandbox = settings.luluSandbox
  console.log(`"${title}" — issue ${number}, ${issue.page_total} pages`)
  console.log(`   ${sandbox ? 'SANDBOX (nothing will be printed)' : 'PRODUCTION — this spends real money'}`)

  const lulu = createLuluClient({ settings })

  const quote = await lulu.quote(
    { title, packageId: settings.luluPackageId, pageCount: issue.page_total, quantity: 1 },
    address,
  )
  console.log(`   ${formatQuote(quote)}`)

  if (!confirm) {
    console.log('\n   quote only. Re-run with --confirm to order.')
    return
  }

  // Signed now rather than earlier: the clock starts when Lulu is told, and
  // there is no point burning the window on a run that only quotes.
  const [interiorUrl, coverUrl] = await Promise.all(
    [issue.interior_path, issue.cover_path].map(async (path) => {
      const { data: signed, error: signError } = await supabase.storage
        .from(settings.storageBucket)
        .createSignedUrl(path, FILE_URL_TTL_SECONDS)
      if (signError || !signed) throw new Error(`signing ${path}: ${signError?.message}`)
      return signed.signedUrl
    }),
  )

  console.log('\n   placing the order…')
  const job = await lulu.createPrintJob({
    item: {
      title,
      packageId: settings.luluPackageId,
      pageCount: issue.page_total,
      interiorUrl,
      coverUrl,
      quantity: 1,
    },
    address,
    externalId: `press-issue-${number}`,
    // Stable per issue, so a retry after a timeout joins the existing job
    // rather than printing a second copy.
    idempotencyKey: `press-issue-${issue.id}`,
  })

  console.log(`   job ${job.id} — ${job.status}${job.lineItemStatus ? ` / ${job.lineItemStatus}` : ''}`)
  if (job.message) console.log(`   ${job.message}`)

  await supabase
    .from('press_issues')
    .update({
      lulu_job_id: job.id,
      lulu_status: job.status,
      state: 'ordered',
      ordered_at: new Date().toISOString(),
      quote_cents: quote.totalCents ?? null,
      quote_currency: quote.currency ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', issue.id)

  console.log(`\n   recorded on issue ${number}. Track it with press:order-status.`)
  if (sandbox) console.log('   (sandbox — no copy is actually being printed)')
}

main().catch((err) => {
  console.error(`press-order: ${(err as Error).message}`)
  process.exit(1)
})
