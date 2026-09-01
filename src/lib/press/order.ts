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
import { createLuluClient, isRejected, type LuluClient } from './lulu'
import { idempotencyKeyFor, placeOrder, updateOrder, type PressOrder } from './orders'
import { LULU_PACKAGE_ID, type PressIssue } from './types'

export interface ApprovalOutcome {
  ok: boolean
  action: 'approve'
  status: 'ordered' | 'already-ordered' | 'rejected' | 'not-composed' | 'not-configured'
  jobId?: string
  orderId?: string
  detail?: string
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
 * Approve an issue and create exactly one Lulu print job for one order row.
 *
 * `press_place_order` is idempotent on the key, so a timeout followed by a
 * retry — or two taps on the same link — finds the first attempt's row rather
 * than producing a second order. A row that already carries a `lulu_job_id`
 * reports what the winner did instead of trying again.
 */
export async function performApproval(
  issue: PressIssue,
  deps: OrderDeps = {},
): Promise<ApprovalOutcome> {
  const db = deps.db
  const settings = await loadEffectiveSettings(db)

  if (!issue.interior_path || !issue.cover_path) {
    return { ok: false, action: 'approve', status: 'not-composed' }
  }
  if (!settings.shipping) {
    return {
      ok: false,
      action: 'approve',
      status: 'not-configured',
      detail: 'no shipping address configured',
    }
  }

  const reorder = deps.reorder ?? false
  const key = idempotencyKeyFor(issue, reorder, deps.now ?? new Date())

  let order: PressOrder
  try {
    order = await placeOrder(
      {
        issueId: issue.id,
        idempotencyKey: key,
        quantity: deps.quantity ?? settings.copies,
        shipTo: settings.shipping,
        orderedBy: settings.mailTo || null,
      },
      db,
    )
  } catch (err) {
    return { ok: false, action: 'approve', status: 'not-configured', detail: (err as Error).message }
  }

  // Someone (or some retry) got here first and Lulu already has the job.
  if (order.lulu_job_id && order.lulu_job_id !== 'pending') {
    return {
      ok: true,
      action: 'approve',
      status: 'already-ordered',
      jobId: order.lulu_job_id,
      orderId: order.id,
    }
  }

  const lulu = deps.lulu ?? createLuluClient({ settings })
  const items = await itemsForIssue(issue.id, db)

  // Price it and keep the number. The whole design of this flow is "see what
  // it costs before you spend it", and until now the one thing never persisted
  // was the cost — the orders panel rendered an em dash forever and there was
  // no record of what any issue had actually been charged at. A quote that
  // fails is not a reason to refuse the order; it is a reason for the column
  // to stay empty.
  let quote = null
  try {
    quote = await lulu.quote(
      {
        title: issue.name ?? `Issue ${issue.number}`,
        packageId: settings.luluPackageId || LULU_PACKAGE_ID,
        pageCount: issue.page_total,
        quantity: order.quantity,
      },
      settings.shipping,
    )
  } catch {
    // Recorded as absent rather than as zero, which would read as free.
  }

  // Signed for longer than Lulu's async fetch window; revoked once the job
  // passes validation (the worker re-signs if it ever needs to).
  const interiorUrl = await signedUrl(issue.interior_path, 24 * 60 * 60, db)
  const coverUrl = await signedUrl(issue.cover_path, 24 * 60 * 60, db)

  try {
    const job = await lulu.createPrintJob({
      item: {
        title: issue.name ?? `Issue ${issue.number}`,
        packageId: settings.luluPackageId || LULU_PACKAGE_ID,
        pageCount: issue.page_total,
        interiorUrl,
        coverUrl,
        quantity: order.quantity,
      },
      address: settings.shipping,
      externalId: key,
      idempotencyKey: key,
    })

    if (isRejected(job)) {
      await updateOrder(
        order.id,
        { lulu_job_id: job.id, status: job.status, line_item_status: job.lineItemStatus, message: job.message },
        db,
      )
      // Only the print run drags the issue into `rejected`; a refused extra
      // copy of a shipped issue says nothing about the issue itself.
      if (!reorder) {
        await updateIssue(
          issue.id,
          { state: 'rejected', lulu_job_id: job.id, lulu_status: job.status, rejection_reason: job.message },
          db,
        )
      }
      await recordEvent({ issue_id: issue.id, kind: 'order_rejected', detail: { message: job.message } }, db)
      return {
        ok: false,
        action: 'approve',
        status: 'rejected',
        jobId: job.id,
        orderId: order.id,
        detail: job.message ?? undefined,
      }
    }

    await updateOrder(
      order.id,
      {
        lulu_job_id: job.id,
        status: job.status,
        line_item_status: job.lineItemStatus,
        message: job.message,
        cost_cents: quote?.totalCents ?? null,
        currency: quote?.currency ?? null,
      },
      db,
    )
    if (!reorder) {
      await updateIssue(
        issue.id,
        {
          state: 'ordered',
          lulu_job_id: job.id,
          lulu_status: job.status,
          ordered_at: (deps.now ?? new Date()).toISOString(),
        },
        db,
      )
    }
    await recordEvent(
      {
        issue_id: issue.id,
        kind: 'order_placed',
        detail: { jobId: job.id, orderId: order.id, items: items.length, reorder },
      },
      db,
    )
    return { ok: true, action: 'approve', status: 'ordered', jobId: job.id, orderId: order.id }
  } catch (err) {
    // The order row is held with no job id, so nothing else will claim this
    // key. Leave it for the worker to reconcile rather than deleting it, which
    // is the only way to risk a double order.
    await recordEvent(
      { issue_id: issue.id, kind: 'order_failed', detail: { orderId: order.id, reason: (err as Error).message } },
      db,
    )
    throw err
  }
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
