/**
 * press — placing the order (U6).
 *
 * Split out of the route so the idempotency behaviour can be tested without
 * standing up Next.js, and so the worker can reuse it when re-driving a
 * half-finished approval.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { claimOrder, getIssue, itemsForIssue, recordEvent, signedUrl, updateIssue } from './db'
import { loadSettings, type PressSettings } from './settings'
import { createLuluClient, isRejected, type LuluClient } from './lulu'
import { LULU_PACKAGE_ID, type PressIssue } from './types'

export interface ApprovalOutcome {
  ok: boolean
  action: 'approve'
  status: 'ordered' | 'already-ordered' | 'rejected' | 'not-composed' | 'not-configured'
  jobId?: string
  detail?: string
}

export interface OrderDeps {
  db?: SupabaseClient
  settings?: PressSettings
  lulu?: LuluClient
  now?: Date
}

/** A stable key for this issue's one and only print job. */
export function idempotencyKeyFor(issue: PressIssue): string {
  return `press-issue-${issue.id}`
}

/**
 * Approve an issue and create exactly one Lulu print job.
 *
 * The check and the set are one statement in Postgres (`press_claim_order`),
 * so a timeout followed by a retry — or two taps on the same link — cannot
 * produce two orders. The loser of that race reports what the winner did
 * rather than trying again.
 */
export async function performApproval(
  issue: PressIssue,
  deps: OrderDeps = {},
): Promise<ApprovalOutcome> {
  const settings = deps.settings ?? loadSettings()
  const db = deps.db

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

  const key = idempotencyKeyFor(issue)
  const claim = await claimOrder(issue.id, key, db)
  if (!claim.claimed) {
    // Someone (or some retry) got here first.
    const current = await getIssue(issue.id, db)
    return {
      ok: true,
      action: 'approve',
      status: 'already-ordered',
      jobId: current?.lulu_job_id ?? claim.lulu_job_id ?? undefined,
    }
  }

  const lulu = deps.lulu ?? createLuluClient({ settings })
  const items = await itemsForIssue(issue.id, db)

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
        quantity: 1,
      },
      address: settings.shipping,
      externalId: key,
      idempotencyKey: claim.idempotency_key ?? key,
    })

    if (isRejected(job)) {
      await updateIssue(
        issue.id,
        { state: 'rejected', lulu_job_id: job.id, lulu_status: job.status, rejection_reason: job.message },
        db,
      )
      await recordEvent({ issue_id: issue.id, kind: 'order_rejected', detail: { message: job.message } }, db)
      return { ok: false, action: 'approve', status: 'rejected', jobId: job.id, detail: job.message ?? undefined }
    }

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
    await recordEvent(
      { issue_id: issue.id, kind: 'order_placed', detail: { jobId: job.id, items: items.length } },
      db,
    )
    return { ok: true, action: 'approve', status: 'ordered', jobId: job.id }
  } catch (err) {
    // The claim is held with lulu_job_id = 'pending', so nothing else will try
    // to order this issue. Leave it for the worker to reconcile rather than
    // releasing the claim, which is the only way to risk a double order.
    await recordEvent(
      { issue_id: issue.id, kind: 'order_failed', detail: { reason: (err as Error).message } },
      db,
    )
    throw err
  }
}
