/**
 * press — the action endpoint (U6).
 *
 * POST only. Every link in the approval email points at the confirmation page,
 * which posts here; a GET on this route is a 405 by omission, so a mail
 * scanner following links can neither place an order nor spend a token.
 *
 * One token, one act — including when that act is a bundle of several issues.
 * The token names every issue it covers, so the single-use property covers the
 * whole parcel rather than each issue in it.
 */

import { NextResponse } from 'next/server'
import { claimToken } from '@/lib/press/approval'
import { getIssue, skipIssue, updateItem, recordEvent } from '@/lib/press/db'
import { approveBundleByIds, approveIssueById } from '@/lib/press/order'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(_request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    return await act(context)
  } catch (err) {
    // This route had no catch at all, so anything that threw inside it — a
    // print job Lulu refused, most of all — reached the confirmation page as
    // a bare Next 500 with no body, and the page could only say "something
    // went wrong (500)". The reason was recorded in `press_events` and shown
    // to nobody. It is the reader's money; the reason is theirs to read.
    return NextResponse.json({ error: (err as Error).message ?? 'Something went wrong.' }, { status: 500 })
  }
}

async function act(context: { params: Promise<{ token: string }> }) {
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
      // One link, several issues: a bundle is one Lulu job bought in one act.
      // Older tokens predate the column and carry only the scalar issue.
      const issueIds = action.issue_ids?.length ? action.issue_ids : [action.issue_id]

      if (issueIds.length > 1) {
        const result = await approveBundleByIds(issueIds)
        // 200 once the job exists, even if a line of it was refused, and the
        // per-issue verdicts are in the body.
        //
        // A bundle has no single verdict. Lulu validates each interior
        // separately, so "issue 3 is printing and issue 4 was refused" is an
        // ordinary outcome — and answering it with 409 would tell the reader
        // nothing happened, when in fact money was spent and a book is on its
        // way. 409 is kept for the case it actually describes: nothing was
        // sent at all.
        return NextResponse.json(result, { status: result.jobId ? 200 : 409 })
      }

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
