/**
 * press — reading the local pipeline state for the review UI.
 *
 * `scripts/press-run.ts` keeps everything in `.press/` on disk: a JSON state
 * file, extracted articles, and one directory per composed issue. This module
 * is the read side of that, for the page at /press.
 *
 * Server-only. `.press/` is gitignored and holds V's reading history, so
 * nothing here may ever run in the browser or be served from a public deploy —
 * see `pressUiEnabled()`.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { TocEntry } from './types'

export const PRESS_ROOT = path.join(process.cwd(), '.press')

export type LocalItemState = 'queued' | 'laid_out' | 'printed' | 'failed' | 'skipped'

export interface LocalItem {
  id: string
  url: string
  raindropId: string
  title: string | null
  state: LocalItemState
  pageCount?: number
  reason?: string
  savedAt: string
}

export interface LocalPrintedIssue {
  number: number
  name: string
  orderedAt: string
  itemIds: string[]
}

export interface LocalState {
  issueNumber: number
  items: LocalItem[]
  seen: string[]
  printed: LocalPrintedIssue[]
}

/** What `scripts/press-run.ts` records alongside a composed issue. */
export interface IssueMeta {
  number: number
  name: string
  pageCount: number
  builtAt: string
  preflight: { code: string; detail: string }[]
  articles: { id: string; title: string | null; url: string; pageCount?: number }[]
}

export interface LocalIssue {
  number: number
  /** Named at compose time; falls back to the directory when the TOC is absent. */
  name: string
  toc: TocEntry[]
  pageCount: number
  hasInterior: boolean
  hasCover: boolean
  interiorBytes: number | null
  builtAt: string | null
  /** Source links for each article, so the issue can be reviewed against them. */
  articles: IssueMeta['articles']
  /** True once its raindrops have been archived (i.e. it was actually ordered). */
  printed: boolean
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

export async function readState(): Promise<LocalState | null> {
  const file = path.join(PRESS_ROOT, 'state.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(await readFile(file, 'utf8')) as LocalState
  } catch {
    return null
  }
}

/** Composed issues, newest first. */
export async function listIssues(state: LocalState | null): Promise<LocalIssue[]> {
  if (!existsSync(PRESS_ROOT)) return []

  const dirs = (await readdir(PRESS_ROOT, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && /^issue-\d+$/.test(d.name))
    .map((d) => d.name)

  const issues: LocalIssue[] = []
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
    const cover = path.join(base, 'cover.pdf')
    const hasInterior = existsSync(interior)

    let interiorBytes: number | null = null
    let builtAt: string | null = null
    if (hasInterior) {
      const info = await stat(interior)
      interiorBytes = info.size
      builtAt = info.mtime.toISOString()
    }

    const printedRecord = state?.printed.find((p) => p.number === number)

    issues.push({
      number,
      name: meta?.name ?? printedRecord?.name ?? `Issue ${number}`,
      toc,
      pageCount: meta?.pageCount ?? toc.reduce((n, e) => n + e.pageCount, 0),
      articles: meta?.articles ?? [],
      hasInterior,
      hasCover: existsSync(cover),
      interiorBytes,
      builtAt,
      printed: Boolean(printedRecord),
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

/** Waiting in `hw`: extracted and measured, not yet in a printed issue. */
export function pendingItems(state: LocalState | null): LocalItem[] {
  return (state?.items ?? [])
    .filter((i) => i.state === 'laid_out')
    .sort((a, b) => a.savedAt.localeCompare(b.savedAt))
}

export function itemsInState(state: LocalState | null, want: LocalItemState): LocalItem[] {
  return (state?.items ?? []).filter((i) => i.state === want)
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}
