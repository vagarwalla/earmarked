/**
 * press — reading somebody else's issues.
 *
 * The two public pages, and the only place in press that reads an account
 * other than the caller's. Everything here is a query and a read: nothing in
 * this file writes, and nothing it returns is reachable from an editing route.
 *
 * Read-only is not enforced by hiding buttons. It falls out of the ownership
 * scoping (018): every editing route resolves its issue through the caller's
 * own client, so a stranger POSTing to /api/press/issue/3/lock gets a 404 for
 * an issue that plainly exists. This module decides only what a reader is
 * shown, and the guarantee is somewhere else.
 *
 * Service-role, necessarily — a reader has no session and, if they have one,
 * it is scoped to their own press rather than to the one they are reading. The
 * `visibility = 'shared'` filter is doing the work every query here, and it is
 * repeated in each rather than left to a helper, because a shelf that
 * accidentally lists a private issue is the one failure this file can have.
 *
 * Server-only.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { pressDbAsService, signedUrl, storagePath } from './db'
import { accountByHandle, type PressAccount } from './accounts'
import type { PressIssue, PressItem } from './types'

/** How long a shared PDF link stays good. Long enough to read on the train. */
const SHARED_PDF_TTL_SECONDS = 60 * 60

/** One issue, as a stranger sees it: what it is, not what could be done to it. */
export interface SharedIssue {
  number: number
  name: string
  pageCount: number
  /** When it was frozen — the closest thing an issue has to a publication date. */
  madeAt: string | null
  hasCover: boolean
}

export interface SharedShelf {
  handle: string
  displayName: string | null
  issues: SharedIssue[]
}

function toShared(row: PressIssue): SharedIssue {
  return {
    number: row.number,
    name: row.name ?? `Issue ${row.number}`,
    pageCount: row.page_total,
    madeAt: row.closed_at ?? row.updated_at,
    hasCover: Boolean(row.cover_path),
  }
}

/**
 * Somebody's shared issues, newest first.
 *
 * Returns null for a handle nobody has, which the page turns into a 404 —
 * rather than an empty shelf, which would say "this person shares nothing"
 * about a person who does not exist.
 */
export async function sharedShelf(
  handle: string,
  db: SupabaseClient = pressDbAsService(),
): Promise<SharedShelf | null> {
  const account = await accountByHandle(handle, db)
  if (!account) return null

  const { data, error } = await db
    .from('press_issues')
    .select('*')
    .eq('owner_id', account.id)
    .eq('visibility', 'shared')
    // Nothing to read until it has been made. A shared draft would be a page
    // offering a PDF that does not exist yet.
    .not('interior_path', 'is', null)
    .order('number', { ascending: false })
  if (error) throw new Error(`press/shared: sharedShelf: ${error.message}`)

  return {
    handle: account.handle,
    displayName: account.display_name,
    issues: ((data as PressIssue[]) ?? []).map(toShared),
  }
}

export interface SharedContents extends SharedIssue {
  owner: Pick<PressAccount, 'handle' | 'display_name'>
  /** In the order they were printed. */
  articles: { title: string; byline: string | null; sourceName: string | null; pages: number }[]
  /** Signed, and short-lived. Null if the file has gone missing from Storage. */
  interiorUrl: string | null
  coverUrl: string | null
}

/**
 * One shared issue and what is in it.
 *
 * The running order comes from `built_order` rather than from the items' own
 * positions: that array is what the PDF was actually rendered from, and if the
 * two ever disagree it is the PDF a reader is holding. An issue whose
 * `built_order` is missing has not been built, and cannot be here.
 */
export async function sharedIssue(
  handle: string,
  number: number,
  db: SupabaseClient = pressDbAsService(),
): Promise<SharedContents | null> {
  const account = await accountByHandle(handle, db)
  if (!account) return null

  const { data, error } = await db
    .from('press_issues')
    .select('*')
    .eq('owner_id', account.id)
    .eq('number', number)
    .eq('visibility', 'shared')
    .not('interior_path', 'is', null)
    .maybeSingle()
  if (error) throw new Error(`press/shared: sharedIssue: ${error.message}`)
  if (!data) return null

  const issue = data as PressIssue

  const { data: rows, error: itemsError } = await db
    .from('press_items')
    .select('id,title,byline,source_name,page_count')
    .eq('issue_id', issue.id)
  if (itemsError) throw new Error(`press/shared: sharedIssue items: ${itemsError.message}`)

  const byId = new Map(((rows as PressItem[]) ?? []).map((i) => [i.id, i]))
  const order = issue.built_order ?? [...byId.keys()]

  return {
    ...toShared(issue),
    owner: { handle: account.handle, display_name: account.display_name },
    articles: order
      .map((id) => byId.get(id))
      .filter((i): i is PressItem => i !== undefined)
      .map((i) => ({
        title: i.title ?? i.url ?? 'Untitled',
        byline: i.byline,
        sourceName: i.source_name,
        pages: i.page_count ?? 0,
      })),
    // A missing object is a null link and a page that still reads, rather than
    // a 500 about Storage on somebody else's magazine.
    interiorUrl: await link(storagePath.interior(issue.id), db),
    coverUrl: issue.cover_path ? await link(storagePath.cover(issue.id), db) : null,
  }
}

async function link(path: string, db: SupabaseClient): Promise<string | null> {
  try {
    return await signedUrl(path, SHARED_PDF_TTL_SECONDS, db)
  } catch {
    return null
  }
}

/**
 * Make an issue readable, or stop.
 *
 * Takes the caller's own scoped client, so this cannot be used to share
 * somebody else's — the update simply matches nothing. Refuses an issue that
 * has never been built, because a shared draft is a page offering a PDF that
 * does not exist.
 */
export async function setVisibility(
  issueId: string,
  visibility: 'private' | 'shared',
  db: SupabaseClient,
): Promise<PressIssue | null> {
  const patch: Record<string, unknown> = { visibility, updated_at: new Date().toISOString() }
  // Kept from the first time it was shared: un-sharing and re-sharing is not a
  // new publication.
  if (visibility === 'shared') patch.shared_at = new Date().toISOString()

  const query = db.from('press_issues').update(patch).eq('id', issueId)
  const { data, error } = await (visibility === 'shared'
    ? query.not('interior_path', 'is', null)
    : query
  )
    .select()
    .maybeSingle()
  if (error) throw new Error(`press/shared: setVisibility: ${error.message}`)
  return (data as PressIssue) ?? null
}
