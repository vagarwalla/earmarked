/**
 * press — the crossing between the website and the machine that renders.
 *
 * Press has two homes and neither is wrong. The workbench reads Postgres,
 * because that is where an issue gets made up; rendering one is minutes of
 * headless Chromium and happens here, against `.press/`. `press-sync` crosses
 * between them on a timer — pull the running order down, build, push the PDFs
 * back — and a Rebuild pressed in the browser has to make the same crossing,
 * or it is not rebuilding the issue anyone is looking at.
 *
 * It did not, and the two drifted in the way that is hardest to see: the button
 * worked, streamed its progress, and rendered the articles `.press/state.json`
 * happened to hold — the order from before the last edit, or the seven articles
 * of an issue Postgres says is empty. Lock had the other half of the same bug:
 * it handed Postgres UUIDs to a renderer that reads `.press/items/<id>/`, where
 * the id is the raindrop id, so every lock failed on the first article.
 *
 * Three functions, one for each part of the crossing:
 *
 *   localItems      what Postgres holds, named the way this disk names it
 *   mirrorOrder     the website's order written into `.press/state.json`
 *   publishBuild    the finished PDFs and page count handed back
 *
 * `raindrop_id` is the bridge in all three, exactly as in `press-import`: the
 * local item id *is* the drop id, so no second identity map is needed.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pressDb, putObject, storagePath, updateIssue } from './db'
import { withStateLock } from './issues'
import type { PressItem } from './types'
import type { SupabaseClient } from '@supabase/supabase-js'

const PRESS_ROOT = path.join(process.cwd(), '.press')

/** One article, as `buildIssue` wants it. */
export interface BuildItem {
  id: string
  title: string
  url: string
  pageCount: number
}

export interface LocalItems {
  /** Renderable here, in the issue's running order. */
  build: BuildItem[]
  /** Titles of the articles this machine has no extracted text for. */
  missing: string[]
}

/**
 * The issue's contents, named the way this machine names them.
 *
 * An article Postgres knows about but that was never extracted here cannot be
 * rendered, and the renderer's own error for it arrives one article into a
 * build. Better to know before Chromium starts: they are returned separately
 * so the caller can refuse the whole build and say which ones to sync.
 */
/**
 * The id this disk knows an article by.
 *
 * `content_path` is `items/<local id>/article.json`, and `press-import` writes
 * it from the id the local pipeline used — which is the raindrop id only when
 * the article came from Raindrop. A piece fetched from a linkpost is minted as
 * `lp-…` with no raindrop id at all (scripts/press-run.ts), and an article that
 * arrived by email has none either. Keying on `raindrop_id` alone would refuse
 * to build any issue containing one, permanently, with a message telling you to
 * run a sync that cannot fix it.
 */
function localIdOf(item: PressItem): string | null {
  const fromPath = item.content_path?.match(/^items\/([^/]+)\/article\.json$/)
  return fromPath ? fromPath[1] : item.raindrop_id || null
}

export function localItems(items: PressItem[]): LocalItems {
  const build: BuildItem[] = []
  const missing: string[] = []

  for (const item of items) {
    const localId = localIdOf(item)
    const name = item.title ?? item.url ?? item.id
    if (!localId || !existsSync(path.join(PRESS_ROOT, 'items', localId, 'article.json'))) {
      missing.push(name)
      continue
    }
    build.push({
      id: localId,
      title: item.title ?? '',
      url: item.url ?? '',
      pageCount: item.page_count ?? 0,
    })
  }

  return { build, missing }
}

/**
 * Write the website's running order into `.press/state.json`.
 *
 * The same step as `press-sync`'s pull, and for the same reason: the website is
 * authoritative for order, because it is the only place anyone changes it by
 * hand. Doing it here as well means the disk agrees with what was just built,
 * so the next `press-sync` sees a current issue instead of rebuilding it again
 * from the order it replaced.
 *
 * Never called with an empty order — pull skips those too, so that an issue
 * emptied on the website cannot quietly orphan the articles on disk.
 */
export async function mirrorOrder(number: number, localIds: string[]): Promise<void> {
  if (localIds.length === 0) return
  await withStateLock((state) => {
    state.issues ??= []
    const draft = state.issues.find((d) => d.number === number)
    if (draft) draft.itemIds = [...localIds]
    else state.issues.push({ number, itemIds: [...localIds], state: 'draft' })
  })
}

/**
 * Hand a finished build back to the website.
 *
 * The PDFs into Storage under the issue's UUID, then the row: what it is now
 * called, how thick it is, where the files are, and — the part staleness turns
 * on — which articles, in Postgres's own ids, the PDFs were rendered from.
 * Without that last one the workbench keeps saying "edited since the last
 * build" about a build that just finished.
 */
export async function publishBuild(
  issue: { id: string; number: number },
  result: { name: string; pageCount: number; itemIds: string[] },
  db: SupabaseClient = pressDb(),
): Promise<void> {
  const dir = path.join(PRESS_ROOT, `issue-${issue.number}`)
  // `built_order` travels in the same statement as the paths it describes, and
  // not in a second call: an update that set `interior_path` and then failed
  // before recording the order would leave the issue reading "out of date"
  // about PDFs that are exactly current, with another full render as the only
  // way out.
  const patch: Record<string, unknown> = {
    name: result.name,
    page_total: result.pageCount,
    built_order: result.itemIds,
  }

  for (const [file, key, at] of [
    ['interior.pdf', 'interior_path', storagePath.interior(issue.id)],
    ['cover.pdf', 'cover_path', storagePath.cover(issue.id)],
  ] as const) {
    const local = path.join(dir, file)
    if (!existsSync(local)) continue
    await putObject(at, new Uint8Array(await readFile(local)), 'application/pdf', db)
    patch[key] = at
  }

  await updateIssue(issue.id, patch, db)
}
