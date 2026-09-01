/**
 * press — edit an issue's contents.
 *
 * `POST /api/press/issue/3` with `{ action: 'reorder' | 'remove' | 'add' }`.
 * Every action is re-validated against the state file as it is on disk right
 * now, under the lock, because `scripts/press-run.ts` may have been polling
 * and extracting since the page was rendered.
 *
 * Nothing here rebuilds anything: the PDFs on disk stay as they were until
 * `/rebuild` is called. Disabled in production unless PRESS_UI_ENABLED=1,
 * because these are V's saved articles.
 */

import { NextResponse } from 'next/server'
import {
  IssueEditError,
  applyIssueAction,
  ensureDraft,
  estimatePages,
  withStateLock,
  type IssueAction,
} from '@/lib/press/issues'
import { listIssues, pendingItems, pressUiEnabled, readState } from '@/lib/press/local'
import {
  addItemToIssue,
  itemsForIssue,
  pressDb,
  removeItemFromIssue,
  setIssueOrder,
} from '@/lib/press/db'
import { remoteListIssues, remotePendingItems } from '@/lib/press/remote'
import { reviewSource } from '@/lib/press/review'
import { loadSettings } from '@/lib/press/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Narrow the request body before it is anywhere near the state file. */
function parseAction(body: unknown): IssueAction | null {
  if (typeof body !== 'object' || body === null) return null
  const { action, itemIds, itemId } = body as Record<string, unknown>

  if (action === 'reorder') {
    if (!Array.isArray(itemIds) || !itemIds.every((id) => typeof id === 'string')) return null
    return { action, itemIds: itemIds as string[] }
  }
  if ((action === 'remove' || action === 'add') && typeof itemId === 'string') {
    return { action, itemId }
  }
  return null
}

/**
 * The same three edits against Postgres.
 *
 * Validation is deliberately the same shape as `applyIssueAction`: a reorder
 * may only permute what the issue currently holds, an add must come from the
 * waiting pool, and a printed issue is fixed. The page may have been open
 * since before someone else changed any of that.
 */
async function applyRemote(number: number, edit: IssueAction, threshold: number) {
  const db = pressDb()
  const { data } = await db
    .from('press_issues')
    .select('id,state')
    .eq('number', number)
    .maybeSingle()
  if (!data) return NextResponse.json({ error: 'no such issue' }, { status: 404 })

  const issueRow = data as { id: string; state: string }
  if (issueRow.state === 'ordered' || issueRow.state === 'shipped') {
    return NextResponse.json(
      { error: `Issue ${number} has been printed; its contents are fixed.` },
      { status: 409 },
    )
  }

  const current = (await itemsForIssue(issueRow.id, db)).map((i) => i.id)

  try {
    if (edit.action === 'reorder') {
      const same =
        edit.itemIds.length === current.length &&
        [...edit.itemIds].sort().join(' ') === [...current].sort().join(' ')
      if (!same) throw new IssueEditError('The issue changed underneath you — reload and try again.')
      await setIssueOrder(issueRow.id, edit.itemIds, db)
    } else if (edit.action === 'remove') {
      if (!current.includes(edit.itemId)) throw new IssueEditError('That article is not in this issue.')
      await removeItemFromIssue(edit.itemId, issueRow.id, db)
    } else {
      const { data: item } = await db
        .from('press_items')
        .select('id,state,issue_id,title,url')
        .eq('id', edit.itemId)
        .maybeSingle()
      const row = item as { state: string; issue_id: string | null; title: string | null; url: string | null } | null
      if (!row) throw new IssueEditError('No such article.')
      if (row.issue_id && row.issue_id !== issueRow.id) {
        throw new IssueEditError('That article already belongs to another issue.')
      }
      if (row.issue_id !== issueRow.id && row.state !== 'laid_out') {
        throw new IssueEditError(
          `"${row.title ?? row.url}" is ${row.state}, not waiting to be printed.`,
        )
      }
      if (!current.includes(edit.itemId)) await addItemToIssue(edit.itemId, issueRow.id, db)
    }
  } catch (err) {
    if (err instanceof IssueEditError) {
      return NextResponse.json({ error: err.message }, { status: 409 })
    }
    throw err
  }

  const issue = (await remoteListIssues(db)).find((i) => i.number === number)
  const waiting = await remotePendingItems(db)
  return NextResponse.json({
    itemIds: issue?.contents.map((e) => e.itemId) ?? [],
    contents: issue?.contents ?? [],
    waiting: waiting.map((i) => ({
      id: i.id,
      title: i.title,
      url: i.url ?? '',
      pageCount: i.page_count ?? 0,
    })),
    dirty: issue?.dirty ?? true,
    draftPages: issue?.draftPages ?? 0,
    threshold,
  })
}

export async function POST(
  request: Request,
  context: { params: Promise<{ number: string }> },
) {
  if (!pressUiEnabled()) return new NextResponse('not found', { status: 404 })

  const { number: raw } = await context.params
  if (!/^\d+$/.test(raw)) return NextResponse.json({ error: 'bad issue' }, { status: 400 })
  const number = Number.parseInt(raw, 10)

  const edit = parseAction(await request.json().catch(() => null))
  if (!edit) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  const threshold = loadSettings().pageThreshold

  // Deployed, membership and order are columns rather than a JSON file, so the
  // edit is a handful of UPDATEs under Postgres' own guarantees instead of a
  // read-modify-write under a lock file.
  if (reviewSource() === 'supabase') return applyRemote(number, edit, threshold)

  // An issue built before the editor existed has no draft yet. Seed it from
  // the same resolution the page itself renders, so the first edit starts from
  // exactly the list the reader was looking at.
  const seeded = await listIssues(await readState(), threshold)
  const seed = seeded.find((i) => i.number === number)
  if (!seed) return NextResponse.json({ error: 'no such issue' }, { status: 404 })

  try {
    const itemIds = await withStateLock((state) => {
      const draft = ensureDraft(
        state,
        number,
        seed.contents.map((e) => e.itemId),
        seed.printed ? 'ordered' : 'draft',
      )
      return applyIssueAction(state, draft, edit).itemIds
    })

    // Both lists come back: an article removed here reappears in the waiting
    // list, and the editor would otherwise have to guess where it went.
    const state = await readState()
    const issue = (await listIssues(state, threshold)).find((i) => i.number === number)
    return NextResponse.json({
      itemIds,
      contents: issue?.contents ?? [],
      waiting: pendingItems(state).map((i) => ({
        id: i.id,
        title: i.title,
        url: i.url,
        pageCount: i.pageCount ?? 0,
      })),
      dirty: issue?.dirty ?? true,
      draftPages: estimatePages(state, itemIds),
      threshold,
    })
  } catch (err) {
    // A refusal is the editor's business to display; anything else is a bug.
    if (err instanceof IssueEditError) {
      return NextResponse.json({ error: err.message }, { status: 409 })
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
