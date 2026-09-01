/**
 * press — the review page's reader, backed by Supabase.
 *
 * `local.ts` reads `.press/` off the disk, which is how press runs on V's
 * machine. Deployed there is no disk: state is Postgres and the PDFs are in
 * the `press` Storage bucket. This is the same shape from that source, so the
 * page and the editor do not care which one they got.
 *
 * The deployed page is deliberately read-and-reorder only. Rendering an issue
 * is minutes of headless Chromium, which does not fit a Vercel function — so
 * edits here change the running order and the PDFs stay as they were until
 * `press-run` rebuilds them on a machine that has a browser. `built_order`
 * (012) is what lets the page tell the truth about that gap.
 *
 * Server-only: it uses the service-role key, which the press tables require —
 * RLS denies the anon key entirely.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { itemsForIssue, pressDb, signedUrl, storagePath } from './db'
import type { IssueEntry, LocalIssue } from './local'
import type { PressIssue, PressItem } from './types'

/** How long a PDF link stays good. Long enough to read, short enough to expire. */
const PDF_URL_TTL_SECONDS = 60 * 60

/** The waiting pool: extracted and measured, not claimed by any issue. */
export async function remotePendingItems(db: SupabaseClient = pressDb()): Promise<PressItem[]> {
  const { data, error } = await db
    .from('press_items')
    .select('*')
    .eq('state', 'laid_out')
    .is('issue_id', null)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`press/remote: pendingItems: ${error.message}`)
  return (data as PressItem[]) ?? []
}

export async function remoteItemsInState(
  state: PressItem['state'],
  db: SupabaseClient = pressDb(),
): Promise<PressItem[]> {
  const { data, error } = await db
    .from('press_items')
    .select('*')
    .eq('state', state)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`press/remote: itemsInState: ${error.message}`)
  return (data as PressItem[]) ?? []
}

const sameOrder = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i])

function toEntry(item: PressItem, linkpostTitles: Map<string, string> = new Map()): IssueEntry {
  return {
    itemId: item.id,
    title: item.title ?? item.url ?? item.id,
    byline: item.byline,
    sourceName: item.source_name,
    url: item.url,
    pageCount: item.page_count ?? 0,
    // The TOC's per-article start pages live in the rendered issue, not in
    // Postgres, so the deployed page shows running order instead. `local.ts`
    // suppresses them the moment an edit lands, for the same reason.
    startPage: null,
    isLinkpost: item.is_linkpost,
    linkpostOf: item.linkpost_parent_id
      ? (linkpostTitles.get(item.linkpost_parent_id) ?? null)
      : null,
  }
}

/**
 * Titles of the linkposts these items came from, in one query.
 *
 * A parent is usually in the same issue, but not always — a piece can outlive
 * the roundup's own placement — so the lookup goes to the table rather than to
 * the list in hand. Failure is not fatal: an unlabelled row is worse than a
 * labelled one and better than a blank page.
 */
export async function remoteLinkpostTitles(
  items: readonly PressItem[],
  db: SupabaseClient = pressDb(),
): Promise<Map<string, string>> {
  const ids = [...new Set(items.map((i) => i.linkpost_parent_id).filter((id): id is string => Boolean(id)))]
  if (ids.length === 0) return new Map()
  const { data, error } = await db.from('press_items').select('id, title, url').in('id', ids)
  if (error) {
    console.warn(`press/remote: linkpostTitles: ${error.message}`)
    return new Map()
  }
  const rows = (data as Array<{ id: string; title: string | null; url: string | null }>) ?? []
  return new Map(rows.map((r) => [r.id, r.title ?? r.url ?? r.id]))
}

/**
 * Every issue, newest first, with its contents in running order.
 *
 * Unlike the local reader this cannot fall back to "the selection press-run
 * would make": membership is a column, so an issue with no items simply has
 * none, and the waiting pool is the rest.
 */
export async function remoteListIssues(db: SupabaseClient = pressDb()): Promise<LocalIssue[]> {
  const { data, error } = await db
    .from('press_issues')
    .select('*')
    .order('number', { ascending: false })
  if (error) throw new Error(`press/remote: listIssues: ${error.message}`)

  const issues: LocalIssue[] = []
  for (const issue of (data as PressIssue[]) ?? []) {
    const items = await itemsForIssue(issue.id, db)
    const linkpostTitles = await remoteLinkpostTitles(items, db)
    const order = items.map((i) => i.id)
    const built = issue.built_order ?? []
    // Never built, or built from a different set or sequence.
    const dirty = !issue.interior_path || !sameOrder(order, built)

    issues.push({
      number: issue.number,
      name: issue.name ?? `Issue ${issue.number}`,
      contents: items.map((i) => toEntry(i, linkpostTitles)),
      draftPages: items.reduce((n, i) => n + (i.page_count ?? 0), 0),
      // Once a copy is bought the contents are a matter of record.
      printed: issue.state === 'ordered' || issue.state === 'shipped',
      dirty,
      built: Boolean(issue.interior_path),
      pageCount: issue.page_total,
      hasInterior: Boolean(issue.interior_path),
      hasCover: Boolean(issue.cover_path),
      // Storage does not report object size cheaply, and the figure is only
      // ever decoration next to the page count.
      interiorBytes: null,
      builtAt: issue.interior_path ? issue.updated_at : null,
    })
  }
  return issues
}

/** A time-limited link to one of an issue's PDFs, or null if it has none. */
export async function remoteIssueFileUrl(
  issueNumber: number,
  file: 'interior.pdf' | 'cover.pdf',
  db: SupabaseClient = pressDb(),
): Promise<string | null> {
  const { data, error } = await db
    .from('press_issues')
    .select('id,interior_path,cover_path')
    .eq('number', issueNumber)
    .maybeSingle()
  if (error) throw new Error(`press/remote: issueFile: ${error.message}`)
  if (!data) return null

  const issue = data as Pick<PressIssue, 'id' | 'interior_path' | 'cover_path'>
  const path = file === 'interior.pdf' ? issue.interior_path : issue.cover_path
  if (!path) return null
  return signedUrl(path, PDF_URL_TTL_SECONDS, db)
}

/** Record what the current PDFs were rendered from, so staleness is knowable. */
export async function recordBuiltOrder(
  issueId: string,
  itemIds: string[],
  db: SupabaseClient = pressDb(),
): Promise<void> {
  const { error } = await db
    .from('press_issues')
    .update({ built_order: itemIds, updated_at: new Date().toISOString() })
    .eq('id', issueId)
  if (error) throw new Error(`press/remote: recordBuiltOrder: ${error.message}`)
}

export { storagePath }
