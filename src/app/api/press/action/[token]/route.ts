/**
 * press — the action endpoint (U6).
 *
 * POST only. Every link in the approval email points at the confirmation page,
 * which posts here; a GET on this route is a 405 by omission, so a mail
 * scanner following links can neither place an order nor spend a token.
 */

import { NextResponse } from 'next/server'
import { claimToken } from '@/lib/press/approval'
import { getIssue, skipIssue, updateItem, recordEvent } from '@/lib/press/db'
import { approveIssueById } from '@/lib/press/order'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params

  const lookup = await claimToken(token)
  if (!lookup.ok) {
    const status = lookup.reason === 'unknown' ? 404 : 410
    return NextResponse.json({ error: lookup.reason }, { status })
  }

  const action = lookup.token
  const issue = await getIssue(action.issue_id)
  if (!issue) return NextResponse.json({ error: 'unknown issue' }, { status: 404 })

  switch (action.action) {
    case 'approve': {
      // approveIssueById, not performApproval: it derives `reorder` from the
      // issue's own state. performApproval defaults it to false, which makes
      // idempotencyKeyFor return the *first* order's key — so an extra copy of
      // a shipped issue found that order, reported 'already-ordered', and
      // returned HTTP 200 having bought nothing.
      const result = await approveIssueById(issue.id)
      return NextResponse.json(result, { status: result.ok ? 200 : 409 })
    }

    case 'skip': {
      const moved = await skipIssue(issue.id)
      return NextResponse.json({ ok: true, action: 'skip', itemsReturned: moved })
    }

    case 'drop': {
      if (!action.item_id) return NextResponse.json({ error: 'no item on token' }, { status: 400 })
      await updateItem(action.item_id, { state: 'failed', failure_reason: 'reader-dropped', issue_id: null })
      await recordEvent({
        issue_id: issue.id,
        item_id: action.item_id,
        kind: 'item_dropped',
        detail: { by: 'reader' },
      })
      // The worker re-composes and sends a fresh approval on the next tick;
      // doing it inline would hold the request open for a full render.
      return NextResponse.json({ ok: true, action: 'drop', itemId: action.item_id })
    }

    default:
      return NextResponse.json({ error: `unsupported action ${action.action}` }, { status: 400 })
  }
}
