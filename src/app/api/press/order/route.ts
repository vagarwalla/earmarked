/**
 * press — the Order button, for one issue or several.
 *
 *   GET  ?issues=3,4    the bundled quote, the saving, and every reason the
 *                       button is disabled
 *   POST { issues: [3,4] }
 *                       send ONE approval email covering all of them
 *
 * The two halves are the same two halves as the per-issue route, and the split
 * is still where the safety is: the dialog is where you catch a wrong address
 * or a stale email, and it spends nothing. The emailed link is the thing that
 * creates a Lulu job — a second, deliberate act, in a different place, after
 * seeing the price. So this route never orders anything either.
 *
 * It takes one issue as readily as several, and the workbench sends every
 * order through it. That is deliberate: `performBundledApproval` already
 * treats a single issue as a bundle of one precisely so there is no separate
 * single-issue path to drift out of step, and the same argument applies to the
 * screen in front of it. `issue/[number]/order` remains as the per-issue
 * endpoint for anything that addresses an issue by number.
 *
 * See docs/plans/2026-08-31-003-feat-press-workbench-plan.md §6.
 */

import { NextResponse } from 'next/server'
import { itemsForIssue, signedUrl } from '@/lib/press/db'
import {
  bundleBlockers,
  isReorder,
  issueByNumber,
  orderBlockers,
  reorderBlockers,
} from '@/lib/press/workbench'
import { loadEffectiveSettings } from '@/lib/press/settings-db'
import { createLuluClient } from '@/lib/press/lulu'
import { quoteBundle } from '@/lib/press/bundle'
import { isFinished, ordersForIssue } from '@/lib/press/orders'
import { issueBundleTokens, sendBundleApprovalEmail } from '@/lib/press/approval'
import { LULU_PACKAGE_ID, PRINT_SPEC, type PressIssue, type PressItem } from '@/lib/press/types'
import { NOT_FOUND, asResponse, ownerDb, pressUiEnabled } from '../_lib/guard'
import type { SupabaseClient } from '@supabase/supabase-js'

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

/**
 * How many issues one parcel may carry.
 *
 * Not a Lulu limit — it is a limit on this screen. Pricing a bundle costs one
 * quote for the job plus one per issue to show what it saved, and a bundle
 * nobody would actually ask for should not be able to turn a dialog into a
 * dozen round trips. Anything larger is two orders.
 */
const MAX_BUNDLE = 6

/**
 * Read the selection. `?issues=3,4` on the GET, `{ issues: [3, 4] }` on the
 * POST — the same list either way.
 *
 * Duplicates are dropped rather than accepted: two lines of the same issue in
 * one job is a plausible fat-finger and an expensive one, and "two copies" is
 * what the quantity setting is for. Sorted, so the order rows' line numbers do
 * not depend on the order the checkboxes were ticked in.
 */
function parseIssueNumbers(raw: unknown): { numbers: number[] } | { error: string } {
  const parts =
    typeof raw === 'string'
      ? raw.split(',').map((p) => p.trim())
      : Array.isArray(raw)
        ? raw.map((p) => String(p).trim())
        : []

  if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) {
    return { error: 'bad issue list' }
  }
  const numbers = [...new Set(parts.map((p) => Number.parseInt(p, 10)))].sort((a, b) => a - b)
  if (numbers.length > MAX_BUNDLE) {
    return { error: `A single parcel takes at most ${MAX_BUNDLE} issues.` }
  }
  return { numbers }
}

interface Resolved {
  issue: PressIssue
  items: PressItem[]
  reorder: boolean
  pages: number
  blockers: string[]
}

/**
 * Everything the decision needs, per issue, plus the settings they all share.
 *
 * One issue that does not exist fails the whole request rather than being
 * quietly dropped from the selection — a bundle is the issues that were asked
 * for, and silently ordering a subset of them is the failure mode this route
 * is written against.
 */
async function resolve(
  numbers: number[],
  db: SupabaseClient,
): Promise<
  | { ok: false; status: number; error: string }
  | { ok: true; issues: Resolved[]; settings: Awaited<ReturnType<typeof loadEffectiveSettings>> }
> {
  const settings = await loadEffectiveSettings(db)
  const issues: Resolved[] = []

  for (const number of numbers) {
    const issue = await issueByNumber(number, db)
    if (!issue) return { ok: false, status: 404, error: `No issue ${number}.` }

    const [items, orders] = await Promise.all([itemsForIssue(issue.id, db), ordersForIssue(issue.id, db)])
    const reorder = isReorder(issue.state)
    const { blockers, pages } = orderBlockers(issue, items, {
      minPages: PRINT_SPEC.minPages,
      hasAddress: Boolean(settings.shipping),
      hasEmail: Boolean(settings.mailTo),
      openOrder: orders.some((o) => !isFinished(o)),
      orderingEnabled: ORDERING_ENABLED,
    })
    issues.push({
      issue,
      items,
      reorder,
      pages,
      blockers: reorder ? reorderBlockers(blockers) : blockers,
    })
  }

  return { ok: true, issues, settings }
}

/** Start pages are cumulative within an issue; see the per-issue route. */
function tocOf(items: PressItem[]) {
  let page = 1
  return items.map((item) => {
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
}

export async function GET(request: Request) {
  if (!pressUiEnabled()) return NOT_FOUND()

  const parsed = parseIssueNumbers(new URL(request.url).searchParams.get('issues'))
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  try {
    const db = await ownerDb()
    const resolved = await resolve(parsed.numbers, db)
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status })
    }
    const { issues, settings } = resolved
    const blockers = bundleBlockers(
      issues.map((r) => ({ number: r.issue.number, blockers: r.blockers })),
    )

    // Only quote when it could actually be bought. A quote needs a real
    // address, and asking Lulu to price a parcel you cannot order is N+1
    // round trips spent to render a number nobody may act on.
    const priced =
      blockers.length === 0 && settings.shipping
        ? await quoteBundle(
            issues.map((r) => ({
              title: r.issue.name ?? `Issue ${r.issue.number}`,
              packageId: settings.luluPackageId || LULU_PACKAGE_ID,
              pageCount: r.issue.page_total || r.pages,
              quantity: settings.copies,
            })),
            settings.shipping,
            createLuluClient({ settings }),
          )
        : null

    return NextResponse.json({
      issues: issues.map((r) => ({
        number: r.issue.number,
        name: r.issue.name,
        state: r.issue.state,
        pages: r.issue.page_total || r.pages,
        reorder: r.reorder,
        blockers: r.blockers,
      })),
      // The bundle is a reorder only if every issue in it has already printed;
      // one fresh issue makes this a print run that happens to be shipped
      // alongside a second copy of something else.
      reorder: issues.every((r) => r.reorder),
      blockers,
      quote: priced?.quote ?? null,
      quoteError: priced?.quoteError ?? null,
      perIssueCents: priced?.perIssueCents ?? null,
      separateTotalCents: priced?.separateTotalCents ?? null,
      savingCents: priced?.savingCents ?? null,
      quantity: settings.copies,
      sandbox: settings.luluSandbox,
      shipTo: settings.shipping,
      approveAt: settings.mailTo || null,
      canEmail: Boolean(settings.resendApiKey && settings.mailFrom && settings.mailTo),
    })
  } catch (err) {
    return asResponse(err)
  }
}

/**
 * Send the approval email. Spends nothing.
 *
 * One email, one link, however many issues — the parcel is one decision. The
 * token is single-use and expiring, and `/api/press/action/` is deliberately
 * outside the password: an approval link has to be followable from a phone,
 * and the token is the credential.
 */
export async function POST(request: Request) {
  if (!pressUiEnabled()) return NOT_FOUND()

  const body = (await request.json().catch(() => null)) as { issues?: unknown } | null
  const parsed = parseIssueNumbers(body?.issues)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  try {
    const db = await ownerDb()
    const resolved = await resolve(parsed.numbers, db)
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status })
    }
    const { issues, settings } = resolved

    // Re-checked here rather than trusted from the dialog: the page may have
    // been open since before the address was cleared, an issue unlocked, or
    // one of these issues ordered on its own in another tab.
    const blockers = bundleBlockers(
      issues.map((r) => ({ number: r.issue.number, blockers: r.blockers })),
    )
    if (blockers.length > 0) {
      return NextResponse.json({ error: blockers[0], blockers }, { status: 409 })
    }

    // Priced again rather than taken from the dialog. The email is the
    // document the decision is made from, and a price the client could set is
    // not one worth printing next to a Print button.
    const priced = settings.shipping
      ? await quoteBundle(
          issues.map((r) => ({
            title: r.issue.name ?? `Issue ${r.issue.number}`,
            packageId: settings.luluPackageId || LULU_PACKAGE_ID,
            pageCount: r.issue.page_total || r.pages,
            quantity: settings.copies,
          })),
          settings.shipping,
          createLuluClient({ settings }),
        )
      : null

    // Minted before the email is built, so a failure to issue the token never
    // produces a message with a dead button in it.
    //
    // Skip is offered only where the bundle is one issue. It returns that
    // issue's articles to the one currently filling — a per-issue act with a
    // per-issue consequence — and a single button that declined three issues at
    // once would be the most destructive thing in the message sitting next to
    // the least. Declining a parcel is simply not clicking.
    const tokens = await issueBundleTokens(
      issues.map((r) => r.issue.id),
      issues.length === 1 ? ['approve', 'skip'] : ['approve'],
      { db },
    )
    const approve = tokens.find((t) => t.action === 'approve')
    if (!approve) throw new Error('could not issue an approval token')

    // Resend is optional. Where it is configured the link goes to the inbox,
    // which is the point — approving from a phone, away from the machine that
    // built the issue. Where it is not, the link is returned to the dialog and
    // opened from there. Both end at the same confirm page and neither places
    // an order: that is still a second, deliberate act on a page that names
    // the price. What changes is the postman, not the decision.
    const canEmail = Boolean(settings.resendApiKey && settings.mailFrom && settings.mailTo)

    await sendBundleApprovalEmail(
      issues.map((r) => r.issue.id),
      {
        issues: await Promise.all(
          issues.map(async (r, i) => ({
            number: r.issue.number,
            name: r.issue.name ?? `Issue ${r.issue.number}`,
            pageCount: r.issue.page_total || r.pages,
            costCents: priced?.perIssueCents?.[i] ?? null,
            previewUrl: r.issue.interior_path
              ? await signedUrl(r.issue.interior_path, 30 * 24 * 60 * 60)
              : '',
            toc: tocOf(r.items),
          })),
        ),
        quote: priced?.quote ?? null,
        separateTotalCents: priced?.separateTotalCents ?? null,
        savingCents: priced?.savingCents ?? null,
        quantity: settings.copies,
        approveUrl: approve.url,
        skipUrl: tokens.find((t) => t.action === 'skip')?.url,
      },
      { deliver: canEmail, db },
    )

    return NextResponse.json({
      ok: true,
      emailed: canEmail,
      sentTo: canEmail ? settings.mailTo : null,
      // Only when it could not be emailed. A link that both arrives in the
      // inbox and sits on the screen is a single-use token with two places to
      // spend it, and the second one to be clicked is a dead link.
      approveUrl: canEmail ? null : approve.url,
      // The same token the confirm page would claim. Handed over so the dialog
      // can carry the second act itself rather than sending the reader to
      // another tab to perform it — see OrderDialog.
      approveToken: canEmail ? null : approve.token,
      issues: parsed.numbers,
    })
  } catch (err) {
    return asResponse(err)
  }
}
