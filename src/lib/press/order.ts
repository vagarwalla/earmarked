/**
 * press — placing the order (U6, plan §6 and §7).
 *
 * Split out of the route so the idempotency behaviour can be tested without
 * standing up Next.js, and so the worker can reuse it when re-driving a
 * half-finished approval.
 *
 * The claim used to live on the issue (`press_claim_order` setting
 * `lulu_job_id`), which made "ordered exactly once, forever" a property of the
 * schema. It is now a row in `press_orders`, so a shipped issue can be printed
 * again while a locked one still cannot be printed twice by a double-tap.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getIssue, itemsForIssue, recordEvent, signedUrl, updateIssue } from './db'
import { loadEffectiveSettings } from './settings-db'
import { createLuluClient, lineFor, LuluError, type LineItem, type LuluClient } from './lulu'
import { idempotencyKeyFor, placeOrder, updateOrder, type PressOrder } from './orders'
import { allocateQuote, LULU_PACKAGE_ID, type PressIssue, type PrintQuote } from './types'

export interface ApprovalOutcome {
  ok: boolean
  action: 'approve'
  status: 'ordered' | 'already-ordered' | 'rejected' | 'not-composed' | 'not-configured'
  jobId?: string
  orderId?: string
  detail?: string
  /** Set when this issue was one of several in a single job. */
  issueNumber?: number
}

/**
 * The result of ordering several issues as one job: the job, and what happened
 * to each issue in it.
 *
 * Not a single status, because a bundle does not have one. Lulu validates each
 * interior separately, so "issue 3 is printing and issue 4 was refused" is a
 * real and expected outcome, and flattening it to a pass or a fail would lose
 * the half that needs acting on.
 */
export interface BundleOutcome {
  ok: boolean
  jobId?: string
  bundleKey: string
  issues: ApprovalOutcome[]
}

/**
 * The key for the JOB, as against the key for each issue's row.
 *
 * One issue keeps exactly the key it has today, so nothing about existing
 * orders — or the retry that finds them — changes. Several derive one from the
 * issues themselves, so a bundle re-driven after a timeout carries the same
 * key to Lulu and is collapsed rather than bought twice.
 */
export function bundleKeyFor(issues: PressIssue[], reorder: boolean, now = new Date()): string {
  if (issues.length === 1) return idempotencyKeyFor(issues[0], reorder, now)
  const ids = issues.map((i) => i.id).sort().join('+')
  return reorder ? `press-bundle-${ids}-copy-${now.getTime()}` : `press-bundle-${ids}`
}

/** The key for one issue's ROW within a job. Unchanged where the job is one issue. */
export function rowKeyFor(bundleKey: string, issue: PressIssue, bundled: boolean): string {
  return bundled ? `${bundleKey}#${issue.id}` : bundleKey
}

export interface OrderDeps {
  db?: SupabaseClient
  lulu?: LuluClient
  now?: Date
  /** A second copy of something already printed, rather than the print run. */
  reorder?: boolean
  /** Overrides the settings quantity; the dialog passes what it quoted. */
  quantity?: number
}

export { idempotencyKeyFor }
/**
 * Approve one issue and create exactly one Lulu print job for it.
 *
 * `press_place_order` is idempotent on the key, so a timeout followed by a
 * retry — or two taps on the same link — finds the first attempt's row rather
 * than producing a second order. A row that already carries a `lulu_job_id`
 * reports what the winner did instead of trying again.
 *
 * One issue is a bundle of one, and goes down exactly the same path — there is
 * no separate single-issue code to drift out of step with the bundled one.
 */
export async function performApproval(
  issue: PressIssue,
  deps: OrderDeps = {},
): Promise<ApprovalOutcome> {
  const bundle = await performBundledApproval([issue], deps)
  return bundle.issues[0]
}

/**
 * Approve several issues and buy them as ONE Lulu job.
 *
 * The saving is the parcel. Lulu charges shipping per job, not per book, so
 * two issues sent as two jobs pay for two deliveries of the same weight to the
 * same door — $27.91 against $22.72 at live prices for issues 1 and 2.
 *
 * The job is all-or-nothing on the way out and per-issue on the way back:
 *
 *   out    Every issue must be composed and claimable before anything is sent.
 *          A job cannot be placed half-way, so a bundle containing one issue
 *          that is not ready is refused entire rather than quietly ordering
 *          the rest — the caller asked for these issues in one parcel.
 *
 *   back   Lulu validates each interior separately. Issue 3 printing while
 *          issue 4's PDF is refused is an ordinary outcome, and each issue's
 *          own row and state follow its own line of the job.
 */
export async function performBundledApproval(
  issues: PressIssue[],
  deps: OrderDeps = {},
): Promise<BundleOutcome> {
  const db = deps.db
  const settings = await loadEffectiveSettings(db)
  const now = deps.now ?? new Date()
  const bundled = issues.length > 1

  const fail = (
    status: ApprovalOutcome['status'],
    detail: string | undefined,
    bundleKey: string,
  ): BundleOutcome => ({
    ok: false,
    bundleKey,
    issues: issues.map((i) => ({
      ok: false,
      action: 'approve' as const,
      status,
      detail,
      issueNumber: i.number,
    })),
  })

  if (issues.length === 0) throw new Error('press/order: a bundle needs at least one issue')

  const reorder = deps.reorder ?? false
  const bundleKey = bundleKeyFor(issues, reorder, now)

  const uncomposed = issues.find((i) => !i.interior_path || !i.cover_path)
  if (uncomposed) {
    return fail(
      'not-composed',
      bundled ? `issue ${uncomposed.number} has not been composed` : undefined,
      bundleKey,
    )
  }
  if (!settings.shipping) {
    return fail('not-configured', 'no shipping address configured', bundleKey)
  }

  // Claim every row before sending anything. A row held with no job id is
  // safe — the worker reconciles it — but a job placed for issues that could
  // not all be claimed is not.
  const orders: PressOrder[] = []
  for (const [index, issue] of issues.entries()) {
    try {
      orders.push(
        await placeOrder(
          {
            issueId: issue.id,
            idempotencyKey: rowKeyFor(bundleKey, issue, bundled),
            quantity: deps.quantity ?? settings.copies,
            shipTo: settings.shipping,
            orderedBy: settings.mailTo || null,
            bundleKey,
            lineIndex: index,
          },
          db,
        ),
      )
    } catch (err) {
      return fail('not-configured', (err as Error).message, bundleKey)
    }
  }

  // Someone (or some retry) got here first and Lulu already has the job. Any
  // one row carrying a real job id settles it for the whole bundle: they were
  // all sent together, under one idempotency key that Lulu itself collapses.
  const placed = orders.find((o) => o.lulu_job_id && o.lulu_job_id !== 'pending')
  if (placed) {
    return {
      ok: true,
      jobId: placed.lulu_job_id as string,
      bundleKey,
      issues: issues.map((issue, i) => ({
        ok: true,
        action: 'approve',
        status: 'already-ordered',
        jobId: placed.lulu_job_id as string,
        orderId: orders[i].id,
        issueNumber: issue.number,
      })),
    }
  }

  const lulu = deps.lulu ?? createLuluClient({ settings })
  const packageId = settings.luluPackageId || LULU_PACKAGE_ID
  const title = (issue: PressIssue) => issue.name ?? `Issue ${issue.number}`

  // Price it and keep the number. The whole design of this flow is "see what
  // it costs before you spend it", and the cost has to be recorded per issue:
  // the parcel is shared, so each row's share of it cannot be recovered from
  // the total afterwards. A quote that fails is not a reason to refuse the
  // order; it is a reason for the column to stay empty.
  let quote: PrintQuote | null = null
  try {
    quote = await lulu.quote(
      issues.map((issue, i) => ({
        title: title(issue),
        packageId,
        pageCount: issue.page_total,
        quantity: orders[i].quantity,
      })),
      settings.shipping,
    )
  } catch {
    // Recorded as absent rather than as zero, which would read as free.
  }
  const costs = quote ? allocateQuote(quote, issues.length) : null

  // Signed for longer than Lulu's async fetch window; revoked once the job
  // passes validation (the worker re-signs if it ever needs to).
  const items: LineItem[] = []
  for (const [i, issue] of issues.entries()) {
    items.push({
      title: title(issue),
      packageId,
      pageCount: issue.page_total,
      interiorUrl: await signedUrl(issue.interior_path as string, 24 * 60 * 60, db),
      coverUrl: await signedUrl(issue.cover_path as string, 24 * 60 * 60, db),
      quantity: orders[i].quantity,
      // The row's own key, so Lulu's per-line verdict finds its way back to
      // the right issue however the API orders the array.
      externalId: orders[i].idempotency_key,
    })
  }

  try {
    const job = await lulu.createPrintJob({
      items,
      address: settings.shipping,
      externalId: bundleKey,
      idempotencyKey: bundleKey,
      // Guaranteed by `orderBlockers`, which refuses an order with no address
      // to send the approval to. Lulu wants the person who placed the job, and
      // that is the same person.
      contactEmail: settings.mailTo,
    })

    const outcomes: ApprovalOutcome[] = []

    for (const [i, issue] of issues.entries()) {
      const order = orders[i]
      const line = lineFor(job, order.idempotency_key, i)
      // A job-level rejection is a rejection of every line in it; a line-level
      // one is this issue's alone.
      const rejected = job.status === 'REJECTED' || line?.status === 'REJECTED'
      const message = line?.message ?? job.message

      await updateOrder(
        order.id,
        {
          lulu_job_id: job.id,
          status: job.status,
          line_item_status: line?.status ?? job.lineItemStatus,
          message,
          ...(rejected ? {} : { cost_cents: costs?.[i] ?? null, currency: quote?.currency ?? null }),
        },
        db,
      )

      // Only the print run drags the issue into `rejected`; a refused extra
      // copy of a shipped issue says nothing about the issue itself.
      if (rejected) {
        if (!reorder) {
          await updateIssue(
            issue.id,
            { state: 'rejected', lulu_job_id: job.id, lulu_status: job.status, rejection_reason: message },
            db,
          )
        }
        await recordEvent({ issue_id: issue.id, kind: 'order_rejected', detail: { message } }, db)
        outcomes.push({
          ok: false,
          action: 'approve',
          status: 'rejected',
          jobId: job.id,
          orderId: order.id,
          detail: message ?? undefined,
          issueNumber: issue.number,
        })
        continue
      }

      if (!reorder) {
        await updateIssue(
          issue.id,
          {
            state: 'ordered',
            lulu_job_id: job.id,
            lulu_status: job.status,
            ordered_at: now.toISOString(),
          },
          db,
        )
      }
      const items = await itemsForIssue(issue.id, db)
      await recordEvent(
        {
          issue_id: issue.id,
          kind: 'order_placed',
          detail: {
            jobId: job.id,
            orderId: order.id,
            items: items.length,
            reorder,
            ...(bundled ? { bundleKey, bundledWith: issues.length - 1 } : {}),
          },
        },
        db,
      )
      outcomes.push({
        ok: true,
        action: 'approve',
        status: 'ordered',
        jobId: job.id,
        orderId: order.id,
        issueNumber: issue.number,
      })
    }

    return { ok: outcomes.every((o) => o.ok), jobId: job.id, bundleKey, issues: outcomes }
  } catch (err) {
    // The rows are held with no job id, so nothing else will claim these keys.
    // They are never deleted — that is the only way to risk a double order.
    //
    // But a 4xx from Lulu means the job was refused outright: no job exists,
    // and none ever will for this payload. Leaving the row `pending` made
    // `openOrder` true for ever, so the issue reported "an order is already in
    // progress" and could not be retried after the thing that upset Lulu was
    // fixed. A rejection is terminal, so the row is marked terminal and the
    // issue is orderable again.
    const status = err instanceof LuluError && err.status >= 400 && err.status < 500 ? 'REJECTED' : null

    for (const [i, issue] of issues.entries()) {
      if (status) {
        await updateOrder(orders[i].id, { status, message: (err as Error).message }, db)
      }
      await recordEvent(
        {
          issue_id: issue.id,
          kind: 'order_failed',
          detail: { orderId: orders[i].id, reason: (err as Error).message, bundleKey },
        },
        db,
      )
    }
    throw err
  }
}

/**
 * Re-read the issues and drive one bundled approval. Used by the confirm link.
 *
 * `reorder` is one flag for the whole job, and it is true only when EVERY
 * issue has already been printed. A mixed bundle — a fresh issue alongside
 * another copy of a shipped one — is not a reorder: the fresh issue's state
 * machine has to advance, and `press_place_order` already decides that per
 * issue from the issue's own state. Setting it on the strength of one member
 * would give the fresh issue a `-copy-` key, so a re-drive would order it
 * twice instead of collapsing onto the first attempt.
 *
 * A member that no longer exists refuses the bundle rather than ordering the
 * rest of it: the reader approved a parcel, not whatever is left of one.
 */
export async function approveBundleByIds(
  issueIds: string[],
  deps: OrderDeps = {},
): Promise<BundleOutcome> {
  const issues: PressIssue[] = []
  for (const id of issueIds) {
    const issue = await getIssue(id, deps.db)
    if (!issue) {
      return {
        ok: false,
        bundleKey: '',
        issues: issueIds.map(() => ({
          ok: false,
          action: 'approve' as const,
          status: 'not-composed' as const,
          detail: 'one of these issues no longer exists',
        })),
      }
    }
    issues.push(issue)
  }

  const reorder =
    deps.reorder ?? issues.every((i) => i.state === 'shipped' || i.state === 'ordered')
  return performBundledApproval(issues, { ...deps, reorder })
}

/** Re-read the issue and drive its approval. Used by the confirm link. */
export async function approveIssueById(
  issueId: string,
  deps: OrderDeps = {},
): Promise<ApprovalOutcome> {
  const issue = await getIssue(issueId, deps.db)
  if (!issue) return { ok: false, action: 'approve', status: 'not-composed', detail: 'no such issue' }
  const reorder = deps.reorder ?? (issue.state === 'shipped' || issue.state === 'ordered')
  return performApproval(issue, { ...deps, reorder })
}
