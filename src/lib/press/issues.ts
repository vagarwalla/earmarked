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

export const PRESS_ROOT = path.join(process.cwd(), '.press')

const STATE_FILE = path.join(PRESS_ROOT, 'state.json')
const LOCK_FILE = path.join(PRESS_ROOT, 'state.lock')

// -- State shape -------------------------------------------------------------

export type ItemState = 'queued' | 'laid_out' | 'printed' | 'failed' | 'skipped'

export interface StateItem {
  id: string
  url: string
  raindropId: string
  title: string | null
  state: ItemState
  pageCount?: number
  reason?: string
  savedAt: string
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
  const chosen: StateItem[] = []
  let total = 0
  for (const item of readyItems(state)) {
    chosen.push(item)
    total += item.pageCount ?? 0
    if (total >= threshold) break
  }
  return chosen
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
      draft.itemIds = [...edit.itemIds]
      return draft
    }
    case 'remove': {
      if (!draft.itemIds.includes(edit.itemId)) {
        throw new IssueEditError('That article is not in this issue.')
      }
      draft.itemIds = draft.itemIds.filter((id) => id !== edit.itemId)
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
      if (claimedItemIds(state, draft.number).has(edit.itemId)) {
        throw new IssueEditError('That article already belongs to another issue.')
      }
      draft.itemIds.push(edit.itemId)
      return draft
    }
  }
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
