/**
 * press — the durable issue selection.
 *
 * Until now an issue's contents were decided at compose time and recorded
 * nowhere: `press-run --compose` took the oldest saves up to the page
 * threshold and the only trace of that decision was the PDF it produced.
 * Editing needs the *selection* to outlive the compose, so it lives here — in
 * `.press/state.json`, as an explicit ordered list of item ids per issue.
 *
 * This mirrors `press_items.issue_id` in the deployed Supabase schema, so the
 * local editor and the eventual hosted one share one model, and `compose.ts`
 * needs no changes at all.
 *
 * Server-only, and written by two processes that can run at the same time:
 * `scripts/press-run.ts` polls and extracts while the dev server serves the
 * editor. Every write therefore goes through `withStateLock`.
 */

import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { orderWithLinkposts, withLinkpostChildren } from './linkpost'

export const PRESS_ROOT = path.join(process.cwd(), '.press')

const STATE_FILE = path.join(PRESS_ROOT, 'state.json')
const LOCK_FILE = path.join(PRESS_ROOT, 'state.lock')

// -- State shape -------------------------------------------------------------

/**
 * What a state.json item can be.
 *
 * Named apart from `ItemState` in types.ts, which is the *Postgres* item
 * lifecycle and has members this one does not (`extracted`, `in_issue`,
 * `dropped`). Two same-named types with different members, one imported here
 * and one there, is exactly the confusion that makes a state machine hard to
 * reason about; the disk and the database are genuinely different machines, so
 * they get different names rather than one merged type.
 */
export type LocalItemState = 'queued' | 'laid_out' | 'printed' | 'failed' | 'skipped'

export interface StateItem {
  id: string
  url: string
  raindropId: string
  title: string | null
  state: LocalItemState
  pageCount?: number
  reason?: string
  savedAt: string
  /**
   * This item is a linkpost: it exists to point at the items whose
   * `linkpostParentId` is its id. All four fields are optional so state files
   * written before linkposts existed still parse — `readState` is a bare
   * JSON.parse with no validation.
   */
  isLinkpost?: boolean
  /** The id of the linkpost that named this item. */
  linkpostParentId?: string
  /** The words that linkpost pointed with, kept for the printed opener. */
  linkpostAnchor?: string
  /** When it was last examined. Absent means never asked, which is what the backfill walks. */
  linkpostScannedAt?: string
}

/**
 * An issue's contents, as chosen rather than as computed.
 *
 * `itemIds` is the running order: position in the array is position in the
 * magazine. `ordered` means the copy has been bought and the raindrops
 * archived — kept rather than dropped so a past issue can still be inspected,
 * and so its items are visibly spoken for.
 */
export interface IssueDraft {
  number: number
  itemIds: string[]
  state: 'draft' | 'ordered'
  /**
   * A name chosen by hand, which the build must keep. Absent means "let the
   * model name it from the contents", which is what every issue did before an
   * issue could be assembled around a theme decided in advance — and a theme
   * decided in advance is exactly the name worth keeping.
   */
  name?: string
}

export interface PrintedIssue {
  number: number
  name: string
  orderedAt: string
  itemIds: string[]
}

export interface PressState {
  issueNumber: number
  items: StateItem[]
  /** Raindrop ids already seen, so a poll never re-ingests. */
  seen: string[]
  printed: PrintedIssue[]
  /** Absent in state files written before the editor existed. */
  issues?: IssueDraft[]
}

// -- Reading and writing -----------------------------------------------------

export async function readState(): Promise<PressState | null> {
  if (!existsSync(STATE_FILE)) return null
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8')) as PressState
  } catch {
    return null
  }
}

async function writeState(state: PressState): Promise<void> {
  await mkdir(PRESS_ROOT, { recursive: true })
  // Write beside and rename: a crash mid-write must not leave a truncated
  // state.json, which is the only record of what has already been ingested.
  const tmp = `${STATE_FILE}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`)
  await rename(tmp, STATE_FILE)
}

/** How long a lock may sit before it is assumed to belong to a dead process. */
const LOCK_STALE_MS = 30_000
/** How long to wait for someone else's lock before giving up. */
const LOCK_TIMEOUT_MS = 10_000

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function lockAgeMs(): Promise<number | null> {
  try {
    return Date.now() - (await stat(LOCK_FILE)).mtimeMs
  } catch {
    return null
  }
}

/**
 * Exclusive access to `state.json` for the duration of `fn`.
 *
 * `open(..., 'wx')` is the atomic bit: it either creates the lock or fails,
 * with no window between the two. The staleness sweep exists because a runner
 * killed with ^C mid-compose would otherwise wedge the editor permanently.
 */
export async function withStateLock<T>(fn: (state: PressState) => Promise<T> | T): Promise<T> {
  await mkdir(PRESS_ROOT, { recursive: true })

  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const handle = await open(LOCK_FILE, 'wx')
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`)
      await handle.close()
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const age = await lockAgeMs()
      if (age !== null && age > LOCK_STALE_MS) {
        await rm(LOCK_FILE, { force: true })
        continue
      }
      if (Date.now() > deadline) {
        throw new Error('press: .press/state.lock is held — is press-run still going?')
      }
      await delay(50)
    }
  }

  try {
    const state = (await readState()) ?? { issueNumber: 1, items: [], seen: [], printed: [] }
    const result = await fn(state)
    await writeState(state)
    return result
  } finally {
    await rm(LOCK_FILE, { force: true })
  }
}

// -- Selection ---------------------------------------------------------------

/** Waiting in `hw`: extracted and measured, not yet spoken for. Oldest first. */
export function readyItems(state: PressState | null): StateItem[] {
  return (state?.items ?? [])
    .filter((i) => i.state === 'laid_out')
    .sort((a, b) => a.savedAt.localeCompare(b.savedAt))
}

/**
 * The default contents of the next issue: oldest saves first, accumulating
 * until the issue crosses the threshold. The deployed pipeline gets this for
 * free because saves trickle in over weeks; run against a backlog that all
 * arrived at once, the whole pile would otherwise become one 300-page brick.
 * The remainder rolls into the following issue.
 *
 * This is only a *starting point* now — once a draft exists it is the draft
 * that decides, and this is never consulted for that issue again.
 */
export function selectForIssue(state: PressState | null, threshold: number): StateItem[] {
  const ready = readyItems(state)
  const chosen: StateItem[] = []
  let total = 0
  for (const item of ready) {
    chosen.push(item)
    total += item.pageCount ?? 0
    if (total >= threshold) break
  }

  // Half a roundup is worse than none of it: taking a linkpost takes the pieces
  // it pointed at, even when that overshoots the threshold. The overshoot is
  // the same kind the loop above already accepts.
  const withChildren = withLinkpostChildren(chosen, ready, (i) => i.linkpostParentId)
  return sortForPrint(withChildren)
}

/**
 * Record what a build actually measured, so the running total in the editor,
 * the length printed against each article, and `selectForIssue`'s threshold
 * all stop quoting a number from the previous stylesheet.
 *
 * `pageCount` is written at ingest, against whatever layout was current then,
 * and is never revised — so a layout change silently makes every count on
 * disk wrong, and by ~30% in the case of the plate-sizing change. `buildIssue`
 * re-measures on every build; this is where those numbers land.
 */
export async function recordMeasuredPages(measured: Map<string, number>): Promise<void> {
  if (measured.size === 0) return
  await withStateLock((state) => {
    for (const item of state.items) {
      const pages = measured.get(item.id)
      if (pages !== undefined) item.pageCount = pages
    }
  })
}

/** The order an issue prints in: whatever it is, with every linkpost's children behind it. */
export function sortForPrint(items: readonly StateItem[]): StateItem[] {
  const byId = new Map(items.map((i) => [i.id, i]))
  const order = orderWithLinkposts(
    items.map((i) => i.id),
    (id) => byId.get(id)?.linkpostParentId,
  )
  return order.map((id) => byId.get(id)!).filter(Boolean)
}

export function findDraft(state: PressState | null, number: number): IssueDraft | undefined {
  return state?.issues?.find((i) => i.number === number)
}

/** Every item id already claimed by some issue, drafted or ordered. */
export function claimedItemIds(state: PressState | null, exceptIssue?: number): Set<string> {
  const ids = new Set<string>()
  for (const draft of state?.issues ?? []) {
    if (draft.number === exceptIssue) continue
    for (const id of draft.itemIds) ids.add(id)
  }
  for (const past of state?.printed ?? []) {
    if (past.number === exceptIssue) continue
    for (const id of past.itemIds) ids.add(id)
  }
  return ids
}

/**
 * The draft for `number`, creating it from `fallbackItemIds` if this issue
 * predates the editor. Mutates `state`; call inside `withStateLock`.
 */
export function ensureDraft(
  state: PressState,
  number: number,
  fallbackItemIds: string[],
  draftState: IssueDraft['state'] = 'draft',
): IssueDraft {
  state.issues ??= []
  const existing = state.issues.find((i) => i.number === number)
  if (existing) return existing
  const created: IssueDraft = { number, itemIds: [...fallbackItemIds], state: draftState }
  state.issues.push(created)
  state.issues.sort((a, b) => a.number - b.number)
  return created
}

// -- Editing -----------------------------------------------------------------

export type IssueAction =
  | { action: 'reorder'; itemIds: string[] }
  | { action: 'remove'; itemId: string }
  | { action: 'add'; itemId: string }

/** A refusal the editor should show the reader, not a bug. */
export class IssueEditError extends Error {}

const sameMembers = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ')

/**
 * Apply one edit to a draft. Mutates `state`; call inside `withStateLock`.
 *
 * Every action is validated against the state the server has just read rather
 * than trusted from the request, because the page may have been open since
 * before a `press-run` added, printed or failed something.
 */
export function applyIssueAction(
  state: PressState,
  draft: IssueDraft,
  edit: IssueAction,
): IssueDraft {
  if (draft.state === 'ordered') {
    throw new IssueEditError(`Issue ${draft.number} has been printed; its contents are fixed.`)
  }

  switch (edit.action) {
    case 'reorder': {
      // A reorder may only permute. Anything else means the page was working
      // from a stale list, and applying it would silently drop an article.
      if (!sameMembers(edit.itemIds, draft.itemIds)) {
        throw new IssueEditError('The issue changed underneath you — reload and try again.')
      }
      draft.itemIds = normaliseOrder(state, edit.itemIds)
      return draft
    }
    case 'remove': {
      if (!draft.itemIds.includes(edit.itemId)) {
        throw new IssueEditError('That article is not in this issue.')
      }
      // Removing a linkpost removes what it brought in: the pieces are only
      // here because it named them, and orphaning them under whatever article
      // happens to precede them would print a lie.
      const orphans = new Set(
        state.items.filter((i) => i.linkpostParentId === edit.itemId).map((i) => i.id),
      )
      draft.itemIds = draft.itemIds.filter((id) => id !== edit.itemId && !orphans.has(id))
      return draft
    }
    case 'add': {
      const item = state.items.find((i) => i.id === edit.itemId)
      if (!item) throw new IssueEditError('No such article.')
      if (draft.itemIds.includes(edit.itemId)) return draft
      // `skipped` and `failed` are deliberate exclusions, not a waiting list:
      // a reference page or a broken extraction has no business in print.
      if (item.state !== 'laid_out') {
        throw new IssueEditError(
          `"${item.title ?? item.url}" is ${item.state}, not waiting to be printed.`,
        )
      }
      const claimed = claimedItemIds(state, draft.number)
      if (claimed.has(edit.itemId)) {
        throw new IssueEditError('That article already belongs to another issue.')
      }
      draft.itemIds.push(edit.itemId)

      // A piece brings the linkpost that named it, because its opener says
      // "Linkpost of X" and X has to be in the issue for that to be true.
      const parentId = item.linkpostParentId
      if (parentId && !draft.itemIds.includes(parentId)) {
        const parent = state.items.find((i) => i.id === parentId)
        if (!parent || parent.state !== 'laid_out' || claimed.has(parentId)) {
          throw new IssueEditError(
            `"${item.title ?? item.url}" is here because a linkpost pointed at it, and that linkpost is not available for this issue.`,
          )
        }
        draft.itemIds.push(parentId)
      }

      // And a linkpost brings the pieces it named, as long as they are free.
      for (const child of state.items) {
        if (child.linkpostParentId !== edit.itemId) continue
        if (child.state !== 'laid_out') continue
        if (draft.itemIds.includes(child.id) || claimed.has(child.id)) continue
        draft.itemIds.push(child.id)
      }
      draft.itemIds = normaliseOrder(state, draft.itemIds)
      return draft
    }
  }
}

/**
 * The invariant, imposed on write: a linkpost's children sit directly behind
 * it. Done here rather than defended in the editor so it holds however the
 * order arrived — a drag, a stale page, or a script.
 */
function normaliseOrder(state: PressState, itemIds: string[]): string[] {
  const byId = new Map(state.items.map((i) => [i.id, i]))
  return orderWithLinkposts(itemIds, (id) => byId.get(id)?.linkpostParentId)
}

/**
 * Pages of articles in a set of items — the number the page threshold is
 * measured against, so the editor's running total and `press-run`'s agree.
 * Front matter and the pad-to-even are only known once it is actually built.
 */
export function estimatePages(state: PressState | null, itemIds: string[]): number {
  const byId = new Map((state?.items ?? []).map((i) => [i.id, i]))
  return itemIds.reduce((n, id) => n + (byId.get(id)?.pageCount ?? 0), 0)
}
