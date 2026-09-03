/**
 * press — open a new draft.
 *
 * `POST /api/press/issue` allocates the next issue number and opens it. There
 * may be several drafts at once now: 009 enforced exactly one open issue
 * because arriving items were swept into whichever it was, and with the pool
 * holding them instead that ambiguity is gone.
 *
 * See docs/plans/2026-08-31-003-feat-press-workbench-plan.md §3.
 */

import { NextResponse } from 'next/server'
import { currentOwnerId } from '@/lib/press/accounts'
import { pressDb } from '@/lib/press/db'
import { newIssue } from '@/lib/press/workbench'
import { NOT_FOUND, asResponse, pressUiEnabled } from '../_lib/guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  if (!pressUiEnabled()) return NOT_FOUND()
  try {
    const owner = await currentOwnerId()
    const issue = await newIssue(owner, pressDb(owner))
    return NextResponse.json({ number: issue.number, id: issue.id })
  } catch (err) {
    return asResponse(err)
  }
}
