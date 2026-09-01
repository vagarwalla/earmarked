/**
 * press — set an issue's contents, whole.
 *
 * `POST /api/press/issue/3/contents` with `{ itemIds: [...] }`, which is the
 * complete running order after the drag. Not add/remove/reorder as three verbs:
 * in the workbench one gesture can be all three at once — dragging an article
 * out of the pool and into position 2 of an issue adds it, orders it, and
 * pushes everything below it down — and expressing that as a sequence of calls
 * would leave the issue in a state the reader never asked for if the second one
 * failed.
 *
 * So it is one statement in Postgres. `press_set_issue_order` places what is
 * named, returns what is not to the pool, and defers the position uniqueness
 * constraint to COMMIT so a permutation is judged only on where it ends up.
 * It refuses an article that belongs to another draft, which is the check that
 * stops the same piece being printed in two issues.
 *
 * See docs/plans/2026-08-31-003-feat-press-workbench-plan.md §2.
 */

import { NextResponse } from 'next/server'
import { itemsForIssue } from '@/lib/press/db'
import { issueByNumber, placeIssueOrder, poolItems } from '@/lib/press/workbench'
import { NOT_FOUND, asResponse, issueNumber, pressUiEnabled } from '../../../_lib/guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request, context: { params: Promise<{ number: string }> }) {
  if (!pressUiEnabled()) return NOT_FOUND()

  const { number: raw } = await context.params
  const number = issueNumber(raw)
  if (number === null) return NextResponse.json({ error: 'bad issue' }, { status: 400 })

  const body = (await request.json().catch(() => null)) as { itemIds?: unknown } | null
  const itemIds = body?.itemIds
  if (!Array.isArray(itemIds) || !itemIds.every((id) => typeof id === 'string' && UUID.test(id))) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }
  // A duplicate would ask Postgres to put one article in two slots, and the
  // error it raises there would be about a constraint rather than about this.
  if (new Set(itemIds).size !== itemIds.length) {
    return NextResponse.json({ error: 'An article cannot appear twice in one issue.' }, { status: 400 })
  }

  try {
    const issue = await issueByNumber(number)
    if (!issue) return NextResponse.json({ error: 'no such issue' }, { status: 404 })
    if (issue.state !== 'open') {
      return NextResponse.json(
        { error: `Issue ${number} is ${issue.state === 'closed' ? 'locked' : issue.state}; its contents are fixed.` },
        { status: 409 },
      )
    }

    await placeIssueOrder(issue.id, itemIds as string[])

    // Both lists come back. An article dragged out of the issue reappears in
    // the pool, and the panel would otherwise have to guess where it went.
    const [contents, pool] = await Promise.all([itemsForIssue(issue.id), poolItems()])
    return NextResponse.json({
      contents: contents.map(summarise),
      pool: pool.map(summarise),
      pages: contents.reduce((n, i) => n + (i.page_count ?? 0), 0),
    })
  } catch (err) {
    return asResponse(err)
  }
}

function summarise(item: {
  id: string
  title: string | null
  url: string | null
  byline: string | null
  source_name: string | null
  page_count: number | null
}) {
  return {
    id: item.id,
    title: item.title ?? item.url ?? item.id,
    url: item.url,
    byline: item.byline,
    sourceName: item.source_name,
    pageCount: item.page_count ?? 0,
  }
}
