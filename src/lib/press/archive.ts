/**
 * press — Raindrop archival (U9).
 *
 * When an issue is ordered, its articles leave `hw` and land in a collection
 * named for the issue. Raindrop then mirrors the shelf: `hw` is what is coming,
 * and each dated collection is an issue that exists on paper.
 *
 * Idempotent and resumable throughout. The Raindrop API is a third party in
 * the middle of a multi-step move, so every step is written to survive being
 * interrupted and re-run on the next tick: the collection is only created once
 * (its id is recorded on the issue), and the move only ever names raindrops
 * that are still outside the archive.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getIssue, itemsForIssue, recordEvent, updateIssue, updateItem } from './db'
import { createRaindropClient, type RaindropClient } from './raindrop'
import { archiveCollectionName } from './naming'
import { loadSettings, type PressSettings } from './settings'
import type { PressIssue, PressItem } from './types'

export interface ArchiveResult {
  collectionId: string
  collectionName: string
  /** Raindrops moved out of `hw` by this run. */
  moved: number
  /** Items marked printed by this run, including those with no raindrop. */
  printed: number
  /** True when there was nothing left to do. */
  alreadyDone: boolean
}

export interface ArchiveDeps {
  db?: SupabaseClient
  settings?: PressSettings
  raindrop?: RaindropClient
  now?: Date
}

/** Items that carry a raindrop and so need moving. */
export function movableItems(items: PressItem[]): PressItem[] {
  return items.filter((i) => i.raindrop_id && i.state === 'in_issue')
}

/**
 * Archive an ordered issue.
 *
 * Only `ordered` and `shipped` issues archive: a dropped article is `failed`
 * and a skipped issue's items went back to the open issue, so neither should
 * ever appear in a printed collection.
 */
export async function archiveIssue(
  issue: PressIssue,
  deps: ArchiveDeps = {},
): Promise<ArchiveResult> {
  const settings = deps.settings ?? loadSettings()
  const db = deps.db
  const now = deps.now ?? new Date()

  if (issue.state !== 'ordered' && issue.state !== 'shipped') {
    throw new Error(`press/archive: issue ${issue.number} is ${issue.state}, not ordered`)
  }

  const raindrop =
    deps.raindrop ?? createRaindropClient({ token: settings.raindropToken })

  const collectionName = archiveCollectionName(
    issue.ordered_at ? new Date(issue.ordered_at) : now,
    issue.name ?? `Issue ${issue.number}`,
  )

  // Re-read rather than trusting the caller's copy: a previous run may have
  // created the collection before failing, and creating a second one would
  // split a printed issue across two shelves.
  const current = (await getIssue(issue.id, db)) ?? issue
  let collectionId = current.archive_collection_id

  if (!collectionId) {
    const collection = await raindrop.createCollection(collectionName)
    collectionId = String(collection._id)
    await updateIssue(issue.id, { archive_collection_id: collectionId }, db)
    await recordEvent(
      { issue_id: issue.id, kind: 'archive_collection_created', detail: { collectionId, collectionName } },
      db,
    )
  }

  const items = await itemsForIssue(issue.id, db)
  const toMove = movableItems(items)
  const pending = items.filter((i) => i.state === 'in_issue')

  if (pending.length === 0) {
    return { collectionId, collectionName, moved: 0, printed: 0, alreadyDone: true }
  }

  let moved = 0
  if (toMove.length > 0) {
    moved = await raindrop.moveRaindrops(
      toMove.map((i) => i.raindrop_id as string),
      collectionId,
    )
  }

  // Newsletters and PDFs have no raindrop; they simply become printed.
  for (const item of pending) {
    await updateItem(item.id, { state: 'printed' }, db)
  }

  await recordEvent(
    {
      issue_id: issue.id,
      kind: 'issue_archived',
      detail: { collectionId, collectionName, moved, printed: pending.length },
    },
    db,
  )

  return { collectionId, collectionName, moved, printed: pending.length, alreadyDone: false }
}

/**
 * The other archive: where a deleted article's raindrop goes.
 *
 * Deleting from the pool is permanent in the database — the row becomes a
 * `dropped` tombstone so `url_key`'s unique index stops a re-save resurrecting
 * it — which is exactly why the raindrop itself must not be destroyed. It moves
 * to a `Not printing` collection instead, and that collection is the undo:
 * everything you have ever declined, still in Raindrop, still findable.
 *
 * Distinct from `archiveIssue`, which files what was *printed* under a dated
 * collection per issue. This is one flat collection for what was not.
 *
 * Idempotent: the collection is found before it is created, and moving a
 * raindrop that is already there is a no-op Raindrop accepts happily.
 */
export const NOT_PRINTING_COLLECTION = 'Not printing'

export async function archiveRaindropElsewhere(
  raindropId: string,
  deps: { raindrop?: RaindropClient; settings?: PressSettings } = {},
): Promise<string> {
  const settings = deps.settings ?? loadSettings()
  const raindrop = deps.raindrop ?? createRaindropClient({ token: settings.raindropToken })

  const existing = (await raindrop.listCollections()).find(
    (c) => c.title.trim().toLowerCase() === NOT_PRINTING_COLLECTION.toLowerCase(),
  )
  const collection = existing ?? (await raindrop.createCollection(NOT_PRINTING_COLLECTION))
  const collectionId = String(collection._id)

  await raindrop.moveRaindrops([raindropId], collectionId)
  return collectionId
}
