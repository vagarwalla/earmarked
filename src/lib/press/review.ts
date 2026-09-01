/**
 * press — one reader for the review page, over two very different sources.
 *
 * On V's machine press is a filesystem application: `.press/state.json`, a
 * directory per article, and PDFs on disk. Deployed there is no disk, so the
 * same information comes from Postgres and the `press` Storage bucket.
 *
 * The page should not know which. It asks for `loadReview()` and gets issues,
 * the waiting pool, and what was left out — assembled by `local.ts` or by
 * `remote.ts` depending on where it is running.
 *
 * The default needs no configuration: if `.press/state.json` is there, that is
 * the live copy and it wins; if it is not — a Vercel function, say — Supabase
 * is the only thing there is. `PRESS_SOURCE` forces either, which is mostly
 * useful for checking the deployed path from a laptop that also has a `.press`.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  itemsInState,
  listIssues,
  pendingItems,
  readState,
  type LocalIssue,
} from './local'
import { remoteItemsInState, remoteListIssues, remotePendingItems } from './remote'

export type ReviewSource = 'local' | 'supabase'

/** One row of the waiting pool or the "not included" lists. */
export interface ReviewItem {
  id: string
  title: string | null
  url: string
  pageCount: number
  reason?: string
}

export interface Review {
  source: ReviewSource
  issues: LocalIssue[]
  waiting: ReviewItem[]
  skipped: ReviewItem[]
  failed: ReviewItem[]
}

export function reviewSource(): ReviewSource {
  const forced = process.env.PRESS_SOURCE
  if (forced === 'supabase' || forced === 'local') return forced
  // The disk is the live copy wherever it exists; a deployed function has none.
  return existsSync(path.join(process.cwd(), '.press', 'state.json')) ? 'local' : 'supabase'
}

export async function loadReview(threshold: number): Promise<Review> {
  const source = reviewSource()

  if (source === 'local') {
    const state = await readState()
    const toItem = (i: {
      id: string
      title: string | null
      url: string
      pageCount?: number
      reason?: string
    }): ReviewItem => ({
      id: i.id,
      title: i.title,
      url: i.url,
      pageCount: i.pageCount ?? 0,
      reason: i.reason,
    })

    return {
      source,
      issues: await listIssues(state, threshold),
      waiting: pendingItems(state).map(toItem),
      skipped: itemsInState(state, 'skipped').map(toItem),
      failed: itemsInState(state, 'failed').map(toItem),
    }
  }

  const toItem = (i: {
    id: string
    title: string | null
    url: string | null
    page_count: number | null
    failure_reason: string | null
  }): ReviewItem => ({
    id: i.id,
    title: i.title,
    url: i.url ?? '',
    pageCount: i.page_count ?? 0,
    reason: i.failure_reason ?? undefined,
  })

  const [issues, waiting, skipped, failed] = await Promise.all([
    remoteListIssues(),
    remotePendingItems(),
    remoteItemsInState('skipped'),
    remoteItemsInState('failed'),
  ])

  return {
    source,
    issues,
    waiting: waiting.map(toItem),
    skipped: skipped.map(toItem),
    failed: failed.map(toItem),
  }
}
