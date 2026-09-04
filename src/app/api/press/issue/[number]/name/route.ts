/**
 * press — rename a draft by hand.
 *
 *   POST { name: string }  →  { name: string | null }
 *
 * The build names an issue with one Haiku call, and plan question 3 settled
 * what that means for a person who disagrees with the answer: a draft may be
 * renamed freely, by the model or by hand, and the name stops moving at lock.
 * So this refuses anything that is not `open` — unlock first, which is also
 * what puts the new name on the cover, since the compose at lock reads
 * `issue.name` and keeps it.
 *
 * An empty name clears the column rather than storing "": the next rebuild
 * then names the issue again, which is the way to ask for a second opinion.
 *
 * Same trim as the model's answers get (`sanitizeIssueName`), because the name
 * ends up on a cover and in a Raindrop collection path either way.
 */

import { NextResponse } from 'next/server'
import { sanitizeIssueName } from '@/lib/press/naming'
import { issueByNumber, renameIssue } from '@/lib/press/workbench'
import { NOT_FOUND, asResponse, issueNumber, ownerDb, pressUiEnabled } from '../../../_lib/guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request, context: { params: Promise<{ number: string }> }) {
  if (!pressUiEnabled()) return NOT_FOUND()

  const { number: raw } = await context.params
  const number = issueNumber(raw)
  if (number === null) return NextResponse.json({ error: 'bad issue' }, { status: 400 })

  const body = (await request.json().catch(() => null)) as { name?: unknown } | null
  if (typeof body?.name !== 'string') {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }
  const name = sanitizeIssueName(body.name) || null

  try {
    const db = await ownerDb()
    const issue = await issueByNumber(number, db)
    if (!issue) return NextResponse.json({ error: 'no such issue' }, { status: 404 })

    if (issue.state !== 'open') {
      return NextResponse.json(
        { error: `Issue ${number} is ${issue.state === 'closed' ? 'locked' : issue.state}; its name is fixed. Unlock it to rename it.` },
        { status: 409 },
      )
    }

    await renameIssue(issue.id, name, db)
    return NextResponse.json({ name })
  } catch (err) {
    return asResponse(err)
  }
}
