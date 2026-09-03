/**
 * press — the three things you can do to one article from the pool.
 *
 *   POST   { action: 'retry' }   a failed extraction goes round again
 *   POST   { action: 'unskip' }  a reference page comes back to the pool
 *   DELETE                       permanent, and the only one in the product
 *
 * Delete is refused by Postgres for anything an issue is holding: remove it
 * from the issue first, and the pool row it lands in is deletable. That refusal
 * is not repeated here, because a check in the route and a check in the
 * database is a check that can disagree with itself.
 *
 * See docs/plans/2026-08-31-003-feat-press-workbench-plan.md §4.
 */

import { NextResponse } from 'next/server'
import { getItem, recordEvent } from '@/lib/press/db'
import { dropItem, retryItem, unskipItem } from '@/lib/press/workbench'
import { archiveRaindropElsewhere } from '@/lib/press/archive'
import { NOT_FOUND, asResponse, pressUiEnabled } from '../../_lib/guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!pressUiEnabled()) return NOT_FOUND()

  const { id } = await context.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'bad item' }, { status: 400 })

  const body = (await request.json().catch(() => null)) as { action?: string } | null
  try {
    if (body?.action === 'retry') await retryItem(id)
    else if (body?.action === 'unskip') await unskipItem(id)
    else return NextResponse.json({ error: 'bad request' }, { status: 400 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return asResponse(err)
  }
}

/**
 * Delete an article from the pool for good.
 *
 * Two steps that must not be one: the raindrop moves to a `Not printing`
 * collection, and the row becomes a `dropped` tombstone whose `url_key` keeps
 * its unique index — so re-saving the same link dedupes against it rather than
 * resurrecting it. Deletion has to stick to mean anything.
 *
 * The raindrop move is attempted first but is not allowed to block the delete:
 * Raindrop being down should not mean you cannot clear your own pool, and the
 * row records whether the move happened.
 */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!pressUiEnabled()) return NOT_FOUND()

  const { id } = await context.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'bad item' }, { status: 400 })

  try {
    const item = await getItem(id)
    if (!item) return NextResponse.json({ error: 'No such article.' }, { status: 404 })

    // Refuse BEFORE touching Raindrop. press_drop_item enforces this too, and
    // that remains the real guard — but it enforces it in Postgres, after the
    // bookmark has already been moved out of `hw`, and there is no rollback for
    // an API call to a third party. Checking here first means a delete that is
    // going to be refused refuses without side effects.
    //
    // This deliberately duplicates the database's check rather than trusting
    // it: the two can only disagree by one being newer, and the cost of them
    // disagreeing is a moved bookmark rather than a wrong answer.
    if (item.issue_id !== null || item.state === 'in_issue') {
      return NextResponse.json(
        { error: 'That article is in an issue. Take it out of the issue first.' },
        { status: 409 },
      )
    }
    if (item.state === 'printed') {
      return NextResponse.json({ error: 'That article has been printed.' }, { status: 409 })
    }
    if (item.state === 'dropped') {
      return NextResponse.json({ error: 'That article is already deleted.' }, { status: 409 })
    }

    // Order matters the other way round too: drop the row first, then move the
    // bookmark. A dropped row whose raindrop is still in `hw` is a re-save away
    // from being noticed and is reported below; a moved raindrop whose row was
    // never dropped is an article that has silently left your reading with
    // nothing recording why.
    await dropItem(id, null)

    let warning: string | null = null
    if (item.raindrop_id) {
      try {
        const collectionId = await archiveRaindropElsewhere(item.raindrop_id)
        await recordEvent(
          { item_id: id, kind: 'item_archived_elsewhere', detail: { collectionId } },
          undefined,
        )
      } catch (err) {
        warning = `Deleted, but the raindrop stayed in hw: ${(err as Error).message}`
      }
    }

    return NextResponse.json({ ok: true, warning })
  } catch (err) {
    return asResponse(err)
  }
}
