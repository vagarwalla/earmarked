/**
 * press — the Order button.
 *
 *   GET    the quote and every reason the button is disabled
 *   POST   send the approval email
 *
 * Two halves on purpose, and the split is where the safety is. The dialog is
 * where you catch a wrong address or a stale email, and it spends nothing. The
 * emailed link is the thing that actually creates a Lulu job — a second,
 * deliberate act, in a different place, after seeing the price.
 *
 * So this route never orders anything. `performApproval` runs behind
 * `/api/press/action/[token]`, which the email links to.
 *
 * See docs/plans/2026-08-31-003-feat-press-workbench-plan.md §6.
 */

import { NextResponse } from 'next/server'
import { itemsForIssue, signedUrl } from '@/lib/press/db'
import { isReorder, issueByNumber, orderBlockers, reorderBlockers } from '@/lib/press/workbench'
import { loadEffectiveSettings } from '@/lib/press/settings-db'
import { createLuluClient } from '@/lib/press/lulu'
import { isFinished, ordersForIssue } from '@/lib/press/orders'
import { issueActionTokens, sendApprovalEmail } from '@/lib/press/approval'
import { LULU_PACKAGE_ID, PRINT_SPEC } from '@/lib/press/types'
import { NOT_FOUND, asResponse, issueNumber, pressUiEnabled } from '../../../_lib/guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The switch that actually stands between this app and a charge.
 *
 * Deliberately an environment variable and not a settings column: it must not
 * be flippable from the same screen that presses the button, and a form is
 * exactly the wrong place for the last guard against spending money.
 */
const ORDERING_ENABLED = process.env.PRESS_ORDER_ENABLED === '1'

export async function GET(_request: Request, context: { params: Promise<{ number: string }> }) {
  if (!pressUiEnabled()) return NOT_FOUND()

  const { number: raw } = await context.params
  const number = issueNumber(raw)
  if (number === null) return NextResponse.json({ error: 'bad issue' }, { status: 400 })

  try {
    const issue = await issueByNumber(number)
    if (!issue) return NextResponse.json({ error: 'no such issue' }, { status: 404 })

    const [items, settings, orders] = await Promise.all([
      itemsForIssue(issue.id),
      loadEffectiveSettings(),
      ordersForIssue(issue.id),
    ])

    const reorder = isReorder(issue.state)
    const { blockers, pages } = orderBlockers(issue, items, {
      minPages: PRINT_SPEC.minPages,
      hasAddress: Boolean(settings.shipping),
      hasEmail: Boolean(settings.mailTo),
      openOrder: orders.some((o) => !isFinished(o)),
      orderingEnabled: ORDERING_ENABLED,
    })

    const effectiveBlockers = reorder ? reorderBlockers(blockers) : blockers

    // Only quote when it could actually be bought. A quote needs a real
    // address, and asking Lulu to price an issue you cannot order is a round
    // trip spent to render a number nobody may act on.
    let quote = null
    let quoteError: string | null = null
    if (effectiveBlockers.length === 0 && settings.shipping) {
      try {
        quote = await createLuluClient({ settings }).quote(
          {
            title: issue.name ?? `Issue ${issue.number}`,
            packageId: settings.luluPackageId || LULU_PACKAGE_ID,
            pageCount: issue.page_total || pages,
            quantity: settings.copies,
          },
          settings.shipping,
        )
      } catch (err) {
        // A quote that fails is worth showing as a warning rather than a
        // blocker: Lulu being briefly unreachable is not a reason the issue
        // cannot be printed, and the approval email quotes it again anyway.
        quoteError = (err as Error).message
      }
    }

    return NextResponse.json({
      issue: {
        number: issue.number,
        name: issue.name,
        state: issue.state,
        pages: issue.page_total || pages,
      },
      reorder,
      blockers: effectiveBlockers,
      quote,
      quoteError,
      quantity: settings.copies,
      sandbox: settings.luluSandbox,
      shipTo: settings.shipping,
      approveAt: settings.mailTo || null,
      orders: orders.map((o) => ({
        id: o.id,
        status: o.status,
        placed_at: o.placed_at,
        lulu_job_id: o.lulu_job_id,
      })),
    })
  } catch (err) {
    return asResponse(err)
  }
}

/**
 * Send the approval email. Spends nothing.
 *
 * The token it carries is single-use and expiring, and `/api/press/action/` is
 * deliberately outside the password — an approval link has to be followable
 * from a phone, and the token is the credential.
 */
export async function POST(_request: Request, context: { params: Promise<{ number: string }> }) {
  if (!pressUiEnabled()) return NOT_FOUND()

  const { number: raw } = await context.params
  const number = issueNumber(raw)
  if (number === null) return NextResponse.json({ error: 'bad issue' }, { status: 400 })

  try {
    const issue = await issueByNumber(number)
    if (!issue) return NextResponse.json({ error: 'no such issue' }, { status: 404 })

    const [items, settings, orders] = await Promise.all([
      itemsForIssue(issue.id),
      loadEffectiveSettings(),
      ordersForIssue(issue.id),
    ])

    const reorder = isReorder(issue.state)
    const { blockers } = orderBlockers(issue, items, {
      minPages: PRINT_SPEC.minPages,
      hasAddress: Boolean(settings.shipping),
      hasEmail: Boolean(settings.mailTo),
      openOrder: orders.some((o) => !isFinished(o)),
      orderingEnabled: ORDERING_ENABLED,
    })
    const effectiveBlockers = reorder ? reorderBlockers(blockers) : blockers

    // Re-checked here rather than trusted from the dialog: the page may have
    // been open since before the address was cleared or the issue unlocked.
    if (effectiveBlockers.length > 0) {
      return NextResponse.json({ error: effectiveBlockers[0], blockers: effectiveBlockers }, { status: 409 })
    }

    // Approve and skip only. The worker's version of this email also carried
    // a "drop this article" link per item, which re-composed the issue — that
    // made sense when the email was the only place an issue could be edited.
    // A locked issue's contents are fixed by definition, and the workbench is
    // where editing happens now, so offering it here would be offering a
    // button that has to refuse.
    const tokens = await issueActionTokens(issue.id, [{ action: 'approve' }, { action: 'skip' }])
    const approve = tokens.find((t) => t.action === 'approve')
    const skip = tokens.find((t) => t.action === 'skip')
    if (!approve || !skip) throw new Error('could not issue approval tokens')

    // Start pages are cumulative rather than read from the PDF: the rendered
    // TOC lives in the interior itself, and this list is orientation in an
    // email, not a page reference anyone navigates by.
    let page = 1
    const toc = items.map((item) => {
      const entry = {
        itemId: item.id,
        title: item.title ?? item.url ?? item.id,
        byline: item.byline,
        sourceName: item.source_name,
        startPage: page,
        pageCount: item.page_count ?? 0,
      }
      page += item.page_count ?? 0
      return entry
    })

    let quote = null
    try {
      if (settings.shipping) {
        quote = await createLuluClient({ settings }).quote(
          {
            title: issue.name ?? `Issue ${issue.number}`,
            packageId: settings.luluPackageId || LULU_PACKAGE_ID,
            pageCount: issue.page_total,
            quantity: settings.copies,
          },
          settings.shipping,
        )
      }
    } catch {
      // A quote is information, not a gate — the dialog already showed one.
    }

    await sendApprovalEmail(issue.id, {
      issueNumber: issue.number,
      issueName: issue.name ?? `Issue ${issue.number}`,
      pageCount: issue.page_total,
      quote,
      toc,
      previewUrl: issue.interior_path
        ? await signedUrl(issue.interior_path, 30 * 24 * 60 * 60)
        : '',
      approveUrl: approve.url,
      skipUrl: skip.url,
      dropUrls: new Map(),
    })

    return NextResponse.json({ ok: true, sentTo: settings.mailTo })
  } catch (err) {
    return asResponse(err)
  }
}
