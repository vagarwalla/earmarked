/**
 * press — bringing every draft issue inside a page range.
 *
 * A magazine that is 24 pages is not a magazine, and Lulu will not perfect-bind
 * one under 32. At the other end an issue over ~150 pages is a brick. So each
 * draft should sit in a band — and after the plate-sizing change every issue
 * moved, some out of the bottom and some over the top.
 *
 * The CLI is `scripts/press-balance.ts`; the decisions are here, so they can be
 * tested without a state file on disk.
 */

import {
  applyIssueAction,
  claimedItemIds,
  readyItems,
  type IssueDraft,
  type PressState,
  type StateItem,
} from './issues'

export const DEFAULT_MIN = 100
export const DEFAULT_MAX = 150

/**
 * Pages a finished interior carries beyond the articles in it: the contents
 * page, plus up to one more from padding to an even leaf.
 *
 * The range a reader cares about is the printed magazine's, not the sum of its
 * articles, and the two are not the same number — balancing to exactly 150
 * articles produced a 152-page issue. So the ceiling the fill and shed passes
 * work to is this much lower than the one asked for.
 */
export const FRONT_MATTER_PT = 2

export function pagesOf(state: PressState, draft: IssueDraft): number {
  const byId = new Map(state.items.map((i) => [i.id, i]))
  return draft.itemIds.reduce((n, id) => n + (byId.get(id)?.pageCount ?? 0), 0)
}

/**
 * Free articles this issue could take, longest first.
 *
 * Longest first, unlike `selectForIssue`'s oldest-first: filling a 76-page
 * hole one 8-page piece at a time overshoots by whatever the last one happens
 * to be, and picking the big ones first leaves the small ones as the change.
 */
export function availableFor(state: PressState, draft: IssueDraft): StateItem[] {
  const claimed = claimedItemIds(state, draft.number)
  return readyItems(state)
    .filter((i) => !claimed.has(i.id) && !draft.itemIds.includes(i.id))
    .sort((a, b) => (b.pageCount ?? 0) - (a.pageCount ?? 0))
}

export interface Move {
  issue: number
  action: 'add' | 'remove'
  id: string
  title: string
  pages: number
}

export function balance(
  state: PressState,
  drafts: IssueDraft[],
  min: number,
  max: number,
): Move[] {
  const moves: Move[] = []
  const byId = new Map(state.items.map((i) => [i.id, i]))
  const label = (id: string) => (byId.get(id)?.title ?? id).slice(0, 46)

  // 1. Shed, so what comes off an over-long issue is in the pool for pass 2.
  for (const draft of drafts) {
    while (pagesOf(state, draft) > max && draft.itemIds.length > 1) {
      // From the end: the running order is the editor's, and the last article
      // is the one it costs least to move.
      const id = draft.itemIds[draft.itemIds.length - 1]
      const before = pagesOf(state, draft)
      const had = [...draft.itemIds]
      applyIssueAction(state, draft, { action: 'remove', itemId: id })
      // Removing a linkpost takes its children too, which can overshoot. Put
      // the exact list back rather than re-adding: a linkpost and the pieces
      // it named have to keep their order, and `add` appends.
      if (pagesOf(state, draft) < min) {
        draft.itemIds = had
        break
      }

      // Back to the pool, not into limbo. An article's `state` is what says
      // whether it is available, and `applyIssueAction` refuses to add one
      // that is still `in_issue` — so without this the pieces shed here would
      // belong to no issue and could never be put in one. `in_issue ->
      // laid_out` is the transition ITEM_TRANSITIONS already allows for a
      // skipped issue putting its contents back.
      for (const gone of had) {
        if (draft.itemIds.includes(gone)) continue
        const it = byId.get(gone)
        if (it && it.state === 'in_issue') it.state = 'laid_out'
      }

      moves.push({ issue: draft.number, action: 'remove', id, title: label(id), pages: before - pagesOf(state, draft) })
    }
  }

  // 2. Fill.
  for (const draft of drafts) {
    let guard = 0
    while (pagesOf(state, draft) < min && guard++ < 200) {
      const room = max - pagesOf(state, draft)
      const free = availableFor(state, draft)
      if (!free.length) break
      // The largest that still fits, else the smallest there is — an issue
      // 8 pages short takes an 8-page piece, not a 24-page one.
      const pick = free.find((i) => (i.pageCount ?? 0) <= room) ?? free[free.length - 1]
      const before = pagesOf(state, draft)
      try {
        applyIssueAction(state, draft, { action: 'add', itemId: pick.id })
      } catch {
        // A linkpost whose family is not free for this issue. Skip it: it will
        // be offered to the next issue, where its children may be available.
        draft.itemIds = draft.itemIds.filter((id) => id !== pick.id)
        break
      }
      const added = pagesOf(state, draft) - before
      if (added <= 0) break
      moves.push({ issue: draft.number, action: 'add', id: pick.id, title: label(pick.id), pages: added })
    }
  }

  return moves
}

