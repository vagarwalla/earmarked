/**
 * press — quote, and order, a printed copy.
 *
 * GET  → the quote. Costs nothing, changes nothing.
 * POST → places the order with Lulu.
 *
 * Lulu fetches the interior and cover from URLs rather than accepting an
 * upload, which is why this could never work from a laptop. The PDFs live in
 * Supabase Storage now, so the order hands Lulu a pair of signed URLs.
 *
 * TWO GUARDS, because /press has no password and this spends money:
 *
 *   1. Sandbox unless LULU_SANDBOX=false. A sandbox order is free, returns a
 *      real job id, and prints nothing — so the button is safe to press and
 *      the whole chain is exercised before a single copy exists.
 *   2. PRESS_ORDER_ENABLED=1 is required for a *production* order. Without it
 *      a live order is refused even if the sandbox flag is off, so flipping
 *      one switch by itself cannot start spending.
 *
 * `lulu_job_id` is the idempotency record: an issue that has one is refused
 * rather than ordered twice, and the key handed to Lulu is derived from the
 * issue id so a retried request joins the existing job.
 */

import { NextResponse } from 'next/server'
import { createLuluClient, formatQuote, LuluError } from '@/lib/press/lulu'
import { pressDb } from '@/lib/press/db'
import { pressUiEnabled } from '@/lib/press/local'
import { loadSettings } from '@/lib/press/settings'
import { PRINT_SPEC } from '@/lib/press/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Long enough for Lulu to fetch and retry; short enough not to be a public copy. */
const FILE_URL_TTL_SECONDS = 24 * 60 * 60

interface IssueRow {
  id: string
  number: number
  name: string | null
  page_total: number
  interior_path: string | null
  cover_path: string | null
  lulu_job_id: string | null
  state: string
}

/** Everything that must be true before Lulu is worth calling. */
async function readyIssue(number: number): Promise<IssueRow | { error: string; status: number }> {
  const settings = loadSettings()
  if (!settings.luluClientKey || !settings.luluClientSecret) {
    return { error: 'Lulu is not configured (LULU_CLIENT_KEY / LULU_CLIENT_SECRET).', status: 503 }
  }
  if (!settings.shipping) {
    return { error: 'No shipping address configured (PRESS_SHIP_*).', status: 503 }
  }

  const { data, error } = await pressDb()
    .from('press_issues')
    .select('id,number,name,page_total,interior_path,cover_path,lulu_job_id,state')
    .eq('number', number)
    .maybeSingle()
  if (error) return { error: error.message, status: 500 }
  if (!data) return { error: 'No such issue.', status: 404 }

  const issue = data as IssueRow
  if (issue.lulu_job_id) {
    return { error: `Already ordered — Lulu job ${issue.lulu_job_id}.`, status: 409 }
  }
  if (!issue.interior_path || !issue.cover_path) {
    return { error: 'This issue has no PDFs yet. It needs a rebuild.', status: 409 }
  }
  if (issue.page_total < PRINT_SPEC.minPages) {
    return {
      error: `${issue.page_total} pages — Lulu needs ${PRINT_SPEC.minPages} to perfect-bind.`,
      status: 409,
    }
  }
  if (issue.page_total % 2 !== 0) {
    return { error: `${issue.page_total} pages is odd; the interior must pad to even.`, status: 409 }
  }
  return issue
}

const isProblem = (v: unknown): v is { error: string; status: number } =>
  typeof v === 'object' && v !== null && 'error' in v

export async function GET(
  _request: Request,
  context: { params: Promise<{ number: string }> },
) {
  if (!pressUiEnabled()) return new NextResponse('not found', { status: 404 })
  const { number: raw } = await context.params
  if (!/^\d+$/.test(raw)) return NextResponse.json({ error: 'bad issue' }, { status: 400 })

  const settings = loadSettings()
  const issue = await readyIssue(Number.parseInt(raw, 10))
  if (isProblem(issue)) return NextResponse.json({ error: issue.error }, { status: issue.status })

  try {
    const quote = await createLuluClient({ settings }).quote(
      {
        title: issue.name ?? `Issue ${issue.number}`,
        packageId: settings.luluPackageId,
        pageCount: issue.page_total,
        quantity: 1,
      },
      settings.shipping!,
    )
    return NextResponse.json({
      quote: formatQuote(quote),
      pageCount: issue.page_total,
      sandbox: settings.luluSandbox,
      // The UI says which of these it is; ordering for real needs both.
      liveOrderingEnabled: process.env.PRESS_ORDER_ENABLED === '1' && !settings.luluSandbox,
    })
  } catch (err) {
    const message = err instanceof LuluError ? err.message : (err as Error).message
    return NextResponse.json({ error: `Quote failed: ${message}` }, { status: 502 })
  }
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ number: string }> },
) {
  if (!pressUiEnabled()) return new NextResponse('not found', { status: 404 })
  const { number: raw } = await context.params
  if (!/^\d+$/.test(raw)) return NextResponse.json({ error: 'bad issue' }, { status: 400 })

  const settings = loadSettings()
  const issue = await readyIssue(Number.parseInt(raw, 10))
  if (isProblem(issue)) return NextResponse.json({ error: issue.error }, { status: issue.status })

  // A live order needs the sandbox off *and* ordering explicitly enabled.
  if (!settings.luluSandbox && process.env.PRESS_ORDER_ENABLED !== '1') {
    return NextResponse.json(
      { error: 'Live ordering is off. Set PRESS_ORDER_ENABLED=1 to allow real orders.' },
      { status: 403 },
    )
  }

  const db = pressDb()
  const title = issue.name ?? `Issue ${issue.number}`

  try {
    const lulu = createLuluClient({ settings })
    const quote = await lulu.quote(
      { title, packageId: settings.luluPackageId, pageCount: issue.page_total, quantity: 1 },
      settings.shipping!,
    )

    const [interiorUrl, coverUrl] = await Promise.all(
      [issue.interior_path!, issue.cover_path!].map(async (path) => {
        const { data, error } = await db.storage
          .from(settings.storageBucket)
          .createSignedUrl(path, FILE_URL_TTL_SECONDS)
        if (error || !data) throw new Error(`signing ${path}: ${error?.message}`)
        return data.signedUrl
      }),
    )

    const job = await lulu.createPrintJob({
      item: {
        title,
        packageId: settings.luluPackageId,
        pageCount: issue.page_total,
        interiorUrl,
        coverUrl,
        quantity: 1,
      },
      address: settings.shipping!,
      externalId: `press-issue-${issue.number}`,
      // Derived from the issue, so a retry joins the job rather than printing twice.
      idempotencyKey: `press-issue-${issue.id}`,
    })

    await db
      .from('press_issues')
      .update({
        lulu_job_id: job.id,
        lulu_status: job.status,
        state: 'ordered',
        ordered_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', issue.id)

    return NextResponse.json({
      jobId: job.id,
      status: job.status,
      lineItemStatus: job.lineItemStatus,
      message: job.message,
      quote: formatQuote(quote),
      sandbox: settings.luluSandbox,
    })
  } catch (err) {
    const message = err instanceof LuluError ? err.message : (err as Error).message
    return NextResponse.json({ error: `Order failed: ${message}` }, { status: 502 })
  }
}
