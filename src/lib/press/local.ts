/**
 * press — reading the local pipeline state for the review UI.
 *
 * `scripts/press-run.ts` keeps everything in `.press/` on disk: a JSON state
 * file, extracted articles, and one directory per composed issue. This module
 * is the read side of that, for the page at /press. The state file's shape and
 * every write to it live in `issues.ts`.
 *
 * Since the editor landed there are two answers to "what is in this issue":
 * the draft in `state.json`, which is what the next build will contain, and
 * `meta.json`, which is what the PDF on disk actually does contain. They
 * disagree between an edit and a rebuild, and the UI has to say so — hence
 * `dirty` and the nullable `startPage` below.
 *
 * Server-only. `.press/` is gitignored and holds V's reading history, so
 * nothing here may ever run in the browser or be served from a public deploy —
 * see `pressUiEnabled()`.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { TocEntry } from './types'
import type { IssueMeta } from './build'
import {
  PRESS_ROOT,
  claimedItemIds,
  findDraft,
  readState,
  readyItems,
  selectForIssue,
  type IssueDraft,
  type ItemState,
  type PressState,
  type StateItem,
} from './issues'

export { PRESS_ROOT, readState }
export type { IssueMeta }

/** Names kept from before `issues.ts` existed; the shapes are the same. */
export type LocalItemState = ItemState
export type LocalItem = StateItem
export type LocalState = PressState

/** One line of an issue's contents, resolved from the draft. */
export interface IssueEntry {
  itemId: string
  title: string
  byline: string | null
  sourceName: string | null
  url: string | null
  /** Measured at ingest; the number the running total is built from. */
  pageCount: number
  /** Where it starts in the built PDF, or null if the draft has moved on. */
  startPage: number | null
  /** This article is a linkpost; the entries under it are what it named. */
  isLinkpost?: boolean
  /** Title of the linkpost that brought it in, when one did. */
  linkpostOf?: string | null
}

export interface LocalIssue {
  number: number
  /** Named at build time; falls back to the directory when the TOC is absent. */
  name: string
  /** The draft's contents — what a rebuild would produce. */
  contents: IssueEntry[]
  /** Sum of the measured article pages in `contents`. */
  draftPages: number
  /** True once its raindrops have been archived (i.e. it was actually ordered). */
  printed: boolean
  /** True while the draft and the PDFs on disk disagree. */
  dirty: boolean
  /** False for the open issue before it has ever been composed. */
  built: boolean
  /** Page count of the interior on disk, front matter and padding included. */
  pageCount: number
  hasInterior: boolean
  hasCover: boolean
  interiorBytes: number | null
  builtAt: string | null
}

/**
 * The review UI lists what V has been reading and links straight to it. That
 * is fine on her own machine and not fine on a public Vercel deploy, so it is
 * off in production unless deliberately switched on.
 */
export function pressUiEnabled(): boolean {
  if (process.env.PRESS_UI_ENABLED === '1') return true
  return process.env.NODE_ENV !== 'production'
}

interface BuiltIssue {
  number: number
  toc: TocEntry[]
  meta: IssueMeta | null
  hasInterior: boolean
  hasCover: boolean
  interiorBytes: number | null
  builtAt: string | null
}

/** Whatever `.press/issue-N/` holds, for every N that has one. */
async function readBuiltIssues(): Promise<BuiltIssue[]> {
  if (!existsSync(PRESS_ROOT)) return []

  const dirs = (await readdir(PRESS_ROOT, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && /^issue-\d+$/.test(d.name))
    .map((d) => d.name)

  const out: BuiltIssue[] = []
  for (const dir of dirs) {
    const number = Number.parseInt(dir.replace('issue-', ''), 10)
    const base = path.join(PRESS_ROOT, dir)

    let toc: TocEntry[] = []
    try {
      toc = JSON.parse(await readFile(path.join(base, 'toc.json'), 'utf8')) as TocEntry[]
    } catch {
      // A directory without a TOC is a half-finished compose; still list it.
    }

    let meta: IssueMeta | null = null
    try {
      meta = JSON.parse(await readFile(path.join(base, 'meta.json'), 'utf8')) as IssueMeta
    } catch {
      // Written since the UI was added; older issues fall back to "Issue N".
    }

    const interior = path.join(base, 'interior.pdf')
    const hasInterior = existsSync(interior)
    let interiorBytes: number | null = null
    let builtAt: string | null = null
    if (hasInterior) {
      const info = await stat(interior)
      interiorBytes = info.size
      builtAt = info.mtime.toISOString()
    }

    out.push({
      number,
      toc,
      meta,
      hasInterior,
      hasCover: existsSync(path.join(base, 'cover.pdf')),
      interiorBytes,
      builtAt,
    })
  }
  return out
}

/**
 * The contents a draft describes, dressed with everything known about each
 * article. Titles and bylines come from the built TOC where the article was in
 * the last build, and from `state.json` where it was added since.
 */
function resolveContents(
  state: PressState | null,
  itemIds: string[],
  built: BuiltIssue | undefined,
  dirty: boolean,
): IssueEntry[] {
  const byId = new Map((state?.items ?? []).map((i) => [i.id, i]))

  return itemIds.map((itemId) => {
    const toc = built?.toc.find((t) => t.itemId === itemId)
    const article = built?.meta?.articles.find((a) => a.id === itemId)
    const item = byId.get(itemId)

    return {
      itemId,
      title: item?.title ?? toc?.title ?? article?.title ?? itemId,
      byline: toc?.byline ?? null,
      sourceName: toc?.sourceName ?? null,
      url: item?.url ?? article?.url ?? null,
      pageCount: item?.pageCount ?? toc?.pageCount ?? article?.pageCount ?? 0,
      // Page numbers from the last build are only true if nothing has moved
      // since; showing them against an edited order would be a lie.
      startPage: dirty ? null : (toc?.startPage ?? null),
      isLinkpost: item?.isLinkpost ?? toc?.isLinkpost ?? false,
      linkpostOf: item?.linkpostParentId
        ? (byId.get(item.linkpostParentId)?.title ?? null)
        : (toc?.linkpostOf ?? null),
    }
  })
}

const sameOrder = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i])

/**
 * Every issue worth showing, newest first: each one that has been built, plus
 * the open issue whether or not it has been. `threshold` seeds the open
 * issue's contents the first time, before any draft has been saved.
 */
export async function listIssues(
  state: LocalState | null,
  threshold: number,
): Promise<LocalIssue[]> {
  const builtIssues = await readBuiltIssues()
  const numbers = new Set(builtIssues.map((b) => b.number))
  if (state) numbers.add(state.issueNumber)

  const issues: LocalIssue[] = []
  for (const number of numbers) {
    const built = builtIssues.find((b) => b.number === number)
    const printedRecord = state?.printed.find((p) => p.number === number)
    const draft: IssueDraft | undefined = findDraft(state, number)

    // Three ways an issue's contents are known, in descending authority: an
    // edited draft, the last build, and — for an open issue that has never
    // been composed — the selection `press-run` would make right now.
    const itemIds =
      draft?.itemIds ??
      printedRecord?.itemIds ??
      built?.meta?.articles.map((a) => a.id) ??
      (number === state?.issueNumber ? selectForIssue(state, threshold).map((i) => i.id) : [])

    const dirty = !built?.hasInterior || !sameOrder(itemIds, built.meta?.articles.map((a) => a.id) ?? [])
    const contents = resolveContents(state, itemIds, built, dirty)

    issues.push({
      number,
      name: built?.meta?.name ?? printedRecord?.name ?? `Issue ${number}`,
      contents,
      draftPages: contents.reduce((n, e) => n + e.pageCount, 0),
      printed: Boolean(printedRecord) || draft?.state === 'ordered',
      dirty,
      built: Boolean(built?.hasInterior),
      pageCount: built?.meta?.pageCount ?? built?.toc.reduce((n, e) => n + e.pageCount, 0) ?? 0,
      hasInterior: Boolean(built?.hasInterior),
      hasCover: Boolean(built?.hasCover),
      interiorBytes: built?.interiorBytes ?? null,
      builtAt: built?.builtAt ?? null,
    })
  }

  return issues.sort((a, b) => b.number - a.number)
}

/**
 * Resolve a request for an issue file to a real path, refusing anything that
 * is not one of the two PDFs we generate. The route takes its parameters from
 * the URL, so this is the only thing standing between a crafted request and
 * the rest of the filesystem.
 */
export function resolveIssueFile(issueNumber: string, file: string): string | null {
  if (!/^\d+$/.test(issueNumber)) return null
  if (file !== 'interior.pdf' && file !== 'cover.pdf') return null

  const resolved = path.resolve(PRESS_ROOT, `issue-${issueNumber}`, file)
  // Belt and braces: even with the allowlist above, never escape .press/.
  if (!resolved.startsWith(path.resolve(PRESS_ROOT) + path.sep)) return null
  return existsSync(resolved) ? resolved : null
}

/**
 * Waiting in `hw`: extracted and measured, and not claimed by any issue. The
 * "add" picker in the editor offers exactly this list.
 */
export function pendingItems(state: LocalState | null): LocalItem[] {
  const claimed = claimedItemIds(state)
  return readyItems(state).filter((i) => !claimed.has(i.id))
}

export function itemsInState(state: LocalState | null, want: LocalItemState): LocalItem[] {
  return (state?.items ?? []).filter((i) => i.state === want)
}
