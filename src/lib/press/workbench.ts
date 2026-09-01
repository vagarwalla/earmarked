/**
 * press — the workbench's operations on issues, the pool, and single articles.
 *
 * Everything here talks to Postgres and only to Postgres. The workbench is not
 * one of the two paths `review.ts` chooses between: settings and orders have
 * no representation on disk at all, so a pool you can delete from and an issue
 * you can order needs the database whether or not `.press/` also exists.
 * `press-run` and `press-sync` keep the disk in step for the renderer, which
 * is the one job that cannot move.
 *
 * See docs/plans/2026-08-31-003-feat-press-workbench-plan.md §2, §3, §4.
 *
 * Server-only: the service-role key, which the press tables require.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getIssue, itemsForIssue, pressDb, recordEvent, updateItem } from './db'
import type { PressIssue, PressItem } from './types'

/** A refusal the workbench should show the reader, not a bug. */
export class WorkbenchError extends Error {}

/**
 * Postgres raises the interesting refusals (an article claimed by another
 * draft, an issue that is not a draft, a delete of something in an issue).
 * They arrive as opaque RPC errors, so unwrap them into something the panel
 * can print verbatim rather than leaking `press_set_issue_order: ...` at a
 * reader.
 */
function rpcError(message: string, what: string): never {
  const stripped = message.replace(/^press_[a-z_]+:\s*/, '')
  throw new WorkbenchError(stripped || `${what} failed`)
}

// ── Issues ───────────────────────────────────────────────────────────────────

export async function listIssueRows(db: SupabaseClient = pressDb()): Promise<PressIssue[]> {
  const { data, error } = await db
    .from('press_issues')
    .select('*')
    .order('number', { ascending: false })
  if (error) throw new Error(`press/workbench: listIssueRows: ${error.message}`)
  return (data as PressIssue[]) ?? []
}

export async function issueByNumber(
  number: number,
  db: SupabaseClient = pressDb(),
): Promise<PressIssue | null> {
  const { data, error } = await db
    .from('press_issues')
    .select('*')
    .eq('number', number)
    .maybeSingle()
  if (error) throw new Error(`press/workbench: issueByNumber: ${error.message}`)
  return (data as PressIssue) ?? null
}

/** Allocate the next number and open a draft. Several may be open at once. */
export async function newIssue(db: SupabaseClient = pressDb()): Promise<PressIssue> {
  const { data, error } = await db.rpc('press_new_issue')
  if (error) rpcError(error.message, 'Creating an issue')
  return data as PressIssue
}

/** Freeze a draft's contents. Only a `closed` issue can be printed. */
export async function lockIssue(
  issueId: string,
  pageTotal: number,
  db: SupabaseClient = pressDb(),
): Promise<PressIssue> {
  const { data, error } = await db.rpc('press_close_issue', {
    p_issue_id: issueId,
    p_page_total: pageTotal,
  })
  if (error) rpcError(error.message, 'Locking')
  return data as PressIssue
}

/** Back to a draft, while no Lulu job has claimed it. */
export async function unlockIssue(
  issueId: string,
  db: SupabaseClient = pressDb(),
): Promise<PressIssue> {
  const { data, error } = await db.rpc('press_reopen_issue', { p_issue_id: issueId })
  if (error) rpcError(error.message, 'Unlocking')
  return data as PressIssue
}

/** Rename by hand. Free until the issue locks; see plan question 3. */
export async function renameIssue(
  issueId: string,
  name: string,
  db: SupabaseClient = pressDb(),
): Promise<void> {
  const { error } = await db
    .from('press_issues')
    .update({ name, updated_at: new Date().toISOString() })
    .eq('id', issueId)
  if (error) throw new Error(`press/workbench: renameIssue: ${error.message}`)
  await recordEvent({ issue_id: issueId, kind: 'issue_renamed', detail: { name } }, db)
}

/**
 * Write a whole running order in one transaction.
 *
 * Not `setIssueOrder`'s loop of UPDATEs: positions are unique per issue, and a
 * permutation necessarily passes through a state where two rows share a slot.
 * `press_set_issue_order` defers the constraint to COMMIT so the intermediate
 * state is allowed and only the destination is judged. Articles the new order
 * does not name are returned to the pool, which is what dragging one out means.
 */
export async function placeIssueOrder(
  issueId: string,
  itemIds: string[],
  db: SupabaseClient = pressDb(),
): Promise<void> {
  const { error } = await db.rpc('press_set_issue_order', {
    p_issue_id: issueId,
    p_item_ids: itemIds,
  })
  if (error) rpcError(error.message, 'Reordering')
}

// ── The pool ─────────────────────────────────────────────────────────────────

/**
 * The pool: extracted, measured, and claimed by no issue.
 *
 * This is the definition the whole plan turns on. An article is in the pool
 * because nothing has placed it, not because a sweep has not reached it yet.
 */
export async function poolItems(db: SupabaseClient = pressDb()): Promise<PressItem[]> {
  const { data, error } = await db
    .from('press_items')
    .select('*')
    .eq('state', 'laid_out')
    .is('issue_id', null)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`press/workbench: poolItems: ${error.message}`)
  return (data as PressItem[]) ?? []
}

/** The piles that are not waiting: `failed`, `skipped`, `dropped`. */
export async function itemsInState(
  state: PressItem['state'],
  db: SupabaseClient = pressDb(),
): Promise<PressItem[]> {
  const { data, error } = await db
    .from('press_items')
    .select('*')
    .eq('state', state)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`press/workbench: itemsInState: ${error.message}`)
  return (data as PressItem[]) ?? []
}

/**
 * Send a failed extraction back to the top of the pipeline.
 *
 * The reason is cleared with the state: a stale "403 from the publisher" shown
 * against an article that is now queued for another go reads as a live fault.
 */
export async function retryItem(itemId: string, db: SupabaseClient = pressDb()): Promise<void> {
  const item = await requireItem(itemId, db)
  if (item.state !== 'failed') {
    throw new WorkbenchError(`That article is ${item.state}, not failed.`)
  }
  await updateItem(itemId, { state: 'queued', failure_reason: null }, db)
  await recordEvent({ item_id: itemId, kind: 'item_retried' }, db)
}

/** Return a reference page to the pool. The call was always yours. */
export async function unskipItem(itemId: string, db: SupabaseClient = pressDb()): Promise<void> {
  const item = await requireItem(itemId, db)
  if (item.state !== 'skipped') {
    throw new WorkbenchError(`That article is ${item.state}, not skipped.`)
  }
  if (item.page_count === null) {
    // Never measured, so it cannot be laid out yet — send it round again
    // rather than into the pool, where the page total would read as 0.
    await updateItem(itemId, { state: 'queued', failure_reason: null }, db)
  } else {
    await updateItem(itemId, { state: 'laid_out', failure_reason: null }, db)
  }
  await recordEvent({ item_id: itemId, kind: 'item_unskipped' }, db)
}

/**
 * The only permanent delete in the product.
 *
 * Postgres refuses anything an issue is holding — remove it from the issue
 * first, and the pool row it lands in is deletable. The raindrop is moved out
 * of `hw` by the caller, which is where it can be recovered from; the row
 * stays as a tombstone so `url_key`'s unique index makes a re-save dedupe
 * against it rather than resurrect it.
 */
export async function dropItem(
  itemId: string,
  archiveCollectionId: string | null,
  db: SupabaseClient = pressDb(),
): Promise<PressItem> {
  const { data, error } = await db.rpc('press_drop_item', {
    p_item_id: itemId,
    p_archive_collection_id: archiveCollectionId,
  })
  if (error) rpcError(error.message, 'Deleting')
  return data as PressItem
}

async function requireItem(itemId: string, db: SupabaseClient): Promise<PressItem> {
  const { data, error } = await db.from('press_items').select('*').eq('id', itemId).maybeSingle()
  if (error) throw new Error(`press/workbench: requireItem: ${error.message}`)
  if (!data) throw new WorkbenchError('No such article.')
  return data as PressItem
}

// ── Auto-fill ────────────────────────────────────────────────────────────────

/**
 * The old `selectForIssue` rule, as a button rather than a trigger.
 *
 * Oldest first until the issue crosses the threshold — which is how every
 * issue was assembled when the pipeline decided for itself. It survives as a
 * guide rail because a backlog that all arrived at once would otherwise become
 * one 300-page brick, and because "fill this and let me edit it" is a faster
 * start than an empty issue.
 */
export function autoFill(pool: PressItem[], threshold: number, alreadyPages = 0): PressItem[] {
  const oldestFirst = [...pool].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const chosen: PressItem[] = []
  let total = alreadyPages
  if (total >= threshold) return chosen
  for (const item of oldestFirst) {
    chosen.push(item)
    total += item.page_count ?? 0
    if (total >= threshold) break
  }
  return chosen
}

// ── Readiness ────────────────────────────────────────────────────────────────

export interface IssueReadiness {
  /** Every reason the issue cannot be ordered, in the order worth fixing them. */
  blockers: string[]
  pages: number
}

/**
 * Why the Order button is disabled, said before it is pressed rather than by
 * Lulu afterwards. Each blocker is a whole sentence because it is rendered as
 * one.
 */
export function orderBlockers(
  issue: PressIssue,
  items: PressItem[],
  opts: {
    minPages: number
    hasAddress: boolean
    hasEmail: boolean
    openOrder: boolean
    /**
     * PRESS_ORDER_ENABLED=1. The switch that actually stands between this app
     * and V's card.
     *
     * Not the sandbox flag, which looks like the safety net and is not one:
     * the Lulu credentials in the environment are production credentials, and
     * Lulu's sandbox host 401s against them — so a "safe" sandbox order does
     * not spend nothing, it fails. Anything that reads `luluSandbox` as
     * protection is reading a flag that has never once refused a charge.
     */
    orderingEnabled: boolean
  },
): IssueReadiness {
  const pages = issue.page_total || items.reduce((n, i) => n + (i.page_count ?? 0), 0)
  const blockers: string[] = []

  if (issue.state === 'open') blockers.push('Lock the issue first — only a locked issue can be printed.')
  if (!issue.interior_path || !issue.cover_path) blockers.push('The issue has not been built.')
  if (pages < opts.minPages) {
    blockers.push(`Lulu will not perfect-bind under ${opts.minPages} pages; this issue is ${pages}.`)
  }
  if (!opts.hasAddress) blockers.push('No complete shipping address — fill one in under Settings.')
  if (!opts.hasEmail) blockers.push('No email on file to send the approval link to.')
  if (opts.openOrder) blockers.push('An order for this issue is already in progress.')
  if (!opts.orderingEnabled) {
    blockers.push('Ordering is off. Set PRESS_ORDER_ENABLED=1 to allow a real order.')
  }

  return { blockers, pages }
}

/**
 * A reorder is a copy of something already printed. It is the one case where
 * an existing order is not a blocker — that is the whole point of it.
 */
export function isReorder(state: string): boolean {
  return state === 'ordered' || state === 'shipped'
}

/**
 * The blockers that still stand for another copy of an already-printed issue.
 *
 * A shipped issue is not "unlocked" or "already ordered" — it is done, and
 * ordering another copy of it is a supported thing to want. Everything else
 * (no address, not built, ordering switched off) applies exactly as before.
 */
export function reorderBlockers(blockers: string[]): string[] {
  return blockers.filter(
    (b) => !b.startsWith('Lock the issue') && !b.startsWith('An order for this issue'),
  )
}

/**
 * Why the bundle cannot be ordered — every issue's reasons, as one list.
 *
 * The all-or-nothing rule is stated here rather than left to the caller: a
 * bundle is one Lulu job, a job cannot be placed half-way, and the reader
 * asked for these issues in one parcel. So *any* issue's blocker blocks the
 * whole bundle, and the answer to "issue 4 is not built" is never to quietly
 * order issue 3 alone.
 *
 * Two presentational rules, both of which exist to keep the list readable
 * rather than merely complete:
 *
 *  - One issue reads exactly as it does today, unprefixed. A bundle of one is
 *    still an order of one issue and should not suddenly say "Issue 3:".
 *  - A reason every issue shares is a fact about the setup, not about any
 *    issue — no address, ordering switched off — and is stated once. Repeating
 *    "Ordering is off" three times says nothing three times.
 */
export function bundleBlockers(issues: { number: number; blockers: string[] }[]): string[] {
  if (issues.length === 0) return ['Select at least one issue to order.']
  if (issues.length === 1) return issues[0].blockers

  const shared = issues[0].blockers.filter((b) => issues.every((i) => i.blockers.includes(b)))
  return [
    ...shared,
    ...issues.flatMap((i) => i.blockers.filter((b) => !shared.includes(b)).map((b) => `Issue ${i.number}: ${b}`)),
  ]
}

export { getIssue, itemsForIssue }
