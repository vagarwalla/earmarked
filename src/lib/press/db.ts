/**
 * press — database and storage access.
 *
 * press tables have RLS on with no policies, so the anon key used elsewhere in
 * this app cannot read or write them. Everything here goes through the
 * service-role key and therefore must only ever run server-side.
 *
 * Functions take an explicit client so tests can pass a fake one.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { loadSettings } from './settings'
import type {
  ActionKind,
  ActionToken,
  ItemState,
  NewPressItem,
  PressIssue,
  PressItem,
} from './types'

let _client: SupabaseClient | null = null

export function pressDb(): SupabaseClient {
  if (!_client) {
    const { supabaseUrl, supabaseServiceKey } = loadSettings()
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error(
        'press: missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — press tables are service-role only',
      )
    }
    _client = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return _client
}

/** Test hook: swap the client, or reset with null. */
export function __setPressClient(client: SupabaseClient | null): void {
  _client = client
}

// ── URL normalization (dedupe key) ───────────────────────────────────────────

/** Query params that identify a campaign, not a document. */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^ref$/i,
  /^ref_src$/i,
  /^source$/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
  /^igshid$/i,
  /^s$/i, // twitter share token
  /^t$/i,
]

/**
 * Stable key for "the same article". Scheme, `www.`, trailing slash, fragment
 * and tracking params are all noise: the same piece saved from a phone and
 * from a newsletter should collide.
 *
 * Returns null for anything that is not an http(s) URL.
 */
export function normalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null

  const host = u.hostname.toLowerCase().replace(/^www\./, '')

  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.some((re) => re.test(k)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const query = params.map(([k, v]) => `${k}=${v}`).join('&')

  const path = u.pathname.replace(/\/+$/, '')

  return `${host}${path}${query ? `?${query}` : ''}`
}

// ── Storage paths ────────────────────────────────────────────────────────────

export const storagePath = {
  articleJson: (itemId: string) => `items/${itemId}/article.json`,
  image: (itemId: string, name: string) => `items/${itemId}/images/${name}`,
  fragment: (itemId: string) => `items/${itemId}/fragment.pdf`,
  rawEmail: (id: string) => `raw-email/${id}.eml`,
  interior: (issueId: string) => `issues/${issueId}/interior.pdf`,
  cover: (issueId: string) => `issues/${issueId}/cover.pdf`,
}

// ── Issues ───────────────────────────────────────────────────────────────────

function unwrap<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`press/db: ${what}: ${res.error.message}`)
  if (res.data === null || res.data === undefined) throw new Error(`press/db: ${what}: no data returned`)
  return res.data
}

// bootstrapIssue lived here. press_bootstrap_issue returned "the open issue,
// creating one if there is none", which is ambiguous the moment more than one
// can be open — and since items land in the pool rather than being swept into
// whichever issue is open, several drafts at once is the point. Opening an
// issue is now something you ask for: see newIssue() in workbench.ts.

export async function getIssue(issueId: string, db: SupabaseClient = pressDb()): Promise<PressIssue | null> {
  const { data, error } = await db.from('press_issues').select('*').eq('id', issueId).maybeSingle()
  if (error) throw new Error(`press/db: getIssue: ${error.message}`)
  return (data as PressIssue) ?? null
}

export async function getOpenIssue(db: SupabaseClient = pressDb()): Promise<PressIssue | null> {
  const { data, error } = await db.from('press_issues').select('*').eq('state', 'open').maybeSingle()
  if (error) throw new Error(`press/db: getOpenIssue: ${error.message}`)
  return (data as PressIssue) ?? null
}

export async function issuesInState(
  states: readonly string[],
  db: SupabaseClient = pressDb(),
): Promise<PressIssue[]> {
  const { data, error } = await db.from('press_issues').select('*').in('state', states)
  if (error) throw new Error(`press/db: issuesInState: ${error.message}`)
  return (data as PressIssue[]) ?? []
}

/** Close the open issue and open its successor atomically. */
export async function closeIssue(
  issueId: string,
  pageTotal: number,
  db: SupabaseClient = pressDb(),
): Promise<PressIssue> {
  const res = await db.rpc('press_close_issue', { p_issue_id: issueId, p_page_total: pageTotal })
  return unwrap(res as { data: PressIssue | null; error: { message: string } | null }, 'close_issue')
}

/** V declined: items go back to the open issue. Returns how many moved. */
export async function skipIssue(issueId: string, db: SupabaseClient = pressDb()): Promise<number> {
  const res = await db.rpc('press_skip_issue', { p_issue_id: issueId })
  if (res.error) throw new Error(`press/db: skip_issue: ${res.error.message}`)
  return (res.data as number) ?? 0
}

// claimOrder lived here, wrapping press_claim_order. Both are gone (013).
// The claim kept `lulu_job_id` on the issue, which made "ordered exactly once,
// forever" a property of the schema rather than a policy — so a second copy of
// a shipped issue was not an unbuilt feature, it was an inexpressible one. It
// is a row in press_orders now; see src/lib/press/orders.ts.

export async function updateIssue(
  issueId: string,
  patch: Partial<PressIssue>,
  db: SupabaseClient = pressDb(),
): Promise<void> {
  const { error } = await db
    .from('press_issues')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', issueId)
  if (error) throw new Error(`press/db: updateIssue: ${error.message}`)
}

// ── Items ────────────────────────────────────────────────────────────────────

/**
 * Insert an item, ignoring a re-drop of a URL already in the pipeline.
 * Returns the item, or null when it was a duplicate.
 */
export async function insertItem(
  item: NewPressItem,
  db: SupabaseClient = pressDb(),
): Promise<PressItem | null> {
  const url_key = item.url_key ?? normalizeUrl(item.url)
  const { data, error } = await db
    .from('press_items')
    .upsert({ ...item, url_key }, { onConflict: 'url_key', ignoreDuplicates: true })
    .select()
  if (error) throw new Error(`press/db: insertItem: ${error.message}`)
  const rows = (data as PressItem[]) ?? []
  return rows[0] ?? null
}

export async function getItem(itemId: string, db: SupabaseClient = pressDb()): Promise<PressItem | null> {
  const { data, error } = await db.from('press_items').select('*').eq('id', itemId).maybeSingle()
  if (error) throw new Error(`press/db: getItem: ${error.message}`)
  return (data as PressItem) ?? null
}

export async function itemsInState(
  states: readonly ItemState[],
  db: SupabaseClient = pressDb(),
  limit = 200,
): Promise<PressItem[]> {
  const { data, error } = await db
    .from('press_items')
    .select('*')
    .in('state', states)
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error(`press/db: itemsInState: ${error.message}`)
  return (data as PressItem[]) ?? []
}

/**
 * An issue's articles in the order they will be printed.
 *
 * `position` (010) is what the editor writes; it is NULL for any issue nobody
 * has reordered, so the chronological sort stays the default and an un-edited
 * issue reads exactly as it did before.
 */
export async function itemsForIssue(issueId: string, db: SupabaseClient = pressDb()): Promise<PressItem[]> {
  const { data, error } = await db
    .from('press_items')
    .select('*')
    .eq('issue_id', issueId)
    .order('position', { ascending: true, nullsFirst: false })
    .order('published_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
  if (error) throw new Error(`press/db: itemsForIssue: ${error.message}`)
  return (data as PressItem[]) ?? []
}

/**
 * Set an issue's running order to exactly `itemIds`.
 *
 * Every position is rewritten rather than just the moved one: positions are
 * unique per issue (010), so patching a single row would collide with whatever
 * already sits in that slot. Membership is the caller's to validate.
 */
export async function setIssueOrder(
  issueId: string,
  itemIds: string[],
  db: SupabaseClient = pressDb(),
): Promise<void> {
  const now = new Date().toISOString()
  // Clear first: moving an article past another would otherwise trip the
  // uniqueness index halfway through the rewrite.
  const { error: clearError } = await db
    .from('press_items')
    .update({ position: null, updated_at: now })
    .eq('issue_id', issueId)
  if (clearError) throw new Error(`press/db: setIssueOrder: ${clearError.message}`)

  for (const [position, id] of itemIds.entries()) {
    const { error } = await db
      .from('press_items')
      .update({ position, updated_at: now })
      .eq('id', id)
      .eq('issue_id', issueId)
    if (error) throw new Error(`press/db: setIssueOrder: ${error.message}`)
  }
}

/** Pull a waiting article into an issue, at the end of the running order. */
export async function addItemToIssue(
  itemId: string,
  issueId: string,
  db: SupabaseClient = pressDb(),
): Promise<void> {
  const existing = await itemsForIssue(issueId, db)
  await updateItem(itemId, { state: 'in_issue', issue_id: issueId, position: existing.length }, db)
  await recordEvent({ item_id: itemId, issue_id: issueId, kind: 'item_added' }, db)
}

/**
 * Drop an article back to the waiting list, closing the gap behind it so the
 * order stays dense and the next add lands at the end rather than in a hole.
 */
export async function removeItemFromIssue(
  itemId: string,
  issueId: string,
  db: SupabaseClient = pressDb(),
): Promise<void> {
  await updateItem(itemId, { state: 'laid_out', issue_id: null, position: null }, db)
  const remaining = await itemsForIssue(issueId, db)
  await setIssueOrder(issueId, remaining.map((i) => i.id), db)
  await recordEvent({ item_id: itemId, issue_id: issueId, kind: 'item_removed' }, db)
}

export async function updateItem(
  itemId: string,
  patch: Partial<PressItem>,
  db: SupabaseClient = pressDb(),
): Promise<void> {
  const { error } = await db
    .from('press_items')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', itemId)
  if (error) throw new Error(`press/db: updateItem: ${error.message}`)
}

/** Mark an item failed with a reason. Reasons surface in the weekly digest (U7). */
export async function failItem(
  itemId: string,
  reason: string,
  db: SupabaseClient = pressDb(),
): Promise<void> {
  await updateItem(itemId, { state: 'failed', failure_reason: reason }, db)
  await recordEvent({ item_id: itemId, kind: 'item_failed', detail: { reason } }, db)
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface NewEvent {
  issue_id?: string | null
  item_id?: string | null
  kind: string
  detail?: Record<string, unknown>
}

export async function recordEvent(event: NewEvent, db: SupabaseClient = pressDb()): Promise<void> {
  const { error } = await db.from('press_events').insert({
    issue_id: event.issue_id ?? null,
    item_id: event.item_id ?? null,
    kind: event.kind,
    detail: event.detail ?? {},
  })
  // The audit log must never take the pipeline down with it.
  if (error) console.error(`press/db: recordEvent(${event.kind}) failed: ${error.message}`)
}

// ── Action tokens (U6) ───────────────────────────────────────────────────────

export async function storeActionToken(
  token: { token_hash: string; issue_id: string; action: ActionKind; item_id?: string | null; expires_at: string },
  db: SupabaseClient = pressDb(),
): Promise<void> {
  const { error } = await db.from('press_action_tokens').insert({
    token_hash: token.token_hash,
    issue_id: token.issue_id,
    action: token.action,
    item_id: token.item_id ?? null,
    expires_at: token.expires_at,
  })
  if (error) throw new Error(`press/db: storeActionToken: ${error.message}`)
}

/** Look a token up without spending it — used by the GET confirmation page. */
export async function peekActionToken(
  tokenHash: string,
  db: SupabaseClient = pressDb(),
): Promise<ActionToken | null> {
  const { data, error } = await db
    .from('press_action_tokens')
    .select('*')
    .eq('token_hash', tokenHash)
    .maybeSingle()
  if (error) throw new Error(`press/db: peekActionToken: ${error.message}`)
  return (data as ActionToken) ?? null
}

/** Spend a token. Returns null if it was already used or has expired. */
export async function consumeActionToken(
  tokenHash: string,
  db: SupabaseClient = pressDb(),
): Promise<ActionToken | null> {
  const res = await db.rpc('press_consume_token', { p_token_hash: tokenHash })
  if (res.error) throw new Error(`press/db: consume_token: ${res.error.message}`)
  return (res.data as ActionToken) ?? null
}

/** Invalidate every outstanding token for an issue (after a recompose). */
export async function expireIssueTokens(issueId: string, db: SupabaseClient = pressDb()): Promise<void> {
  const { error } = await db
    .from('press_action_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('issue_id', issueId)
    .is('used_at', null)
  if (error) throw new Error(`press/db: expireIssueTokens: ${error.message}`)
}

// ── Cursors (U2) ─────────────────────────────────────────────────────────────

export async function getCursor(source: string, db: SupabaseClient = pressDb()): Promise<string | null> {
  const { data, error } = await db.from('press_cursors').select('cursor').eq('source', source).maybeSingle()
  if (error) throw new Error(`press/db: getCursor: ${error.message}`)
  return (data as { cursor: string | null } | null)?.cursor ?? null
}

export async function setCursor(
  source: string,
  cursor: string,
  db: SupabaseClient = pressDb(),
): Promise<void> {
  const { error } = await db
    .from('press_cursors')
    .upsert({ source, cursor, updated_at: new Date().toISOString() }, { onConflict: 'source' })
  if (error) throw new Error(`press/db: setCursor: ${error.message}`)
}

// ── Storage ──────────────────────────────────────────────────────────────────

function bucket(db: SupabaseClient) {
  return db.storage.from(loadSettings().storageBucket)
}

export async function putObject(
  path: string,
  body: Uint8Array | string,
  contentType: string,
  db: SupabaseClient = pressDb(),
): Promise<string> {
  const { error } = await bucket(db).upload(path, body as Uint8Array, { contentType, upsert: true })
  if (error) throw new Error(`press/db: putObject(${path}): ${error.message}`)
  return path
}

export async function getObject(path: string, db: SupabaseClient = pressDb()): Promise<Uint8Array> {
  const { data, error } = await bucket(db).download(path)
  if (error || !data) throw new Error(`press/db: getObject(${path}): ${error?.message ?? 'missing'}`)
  return new Uint8Array(await (data as Blob).arrayBuffer())
}

export async function getJson<T>(path: string, db: SupabaseClient = pressDb()): Promise<T> {
  const bytes = await getObject(path, db)
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

/**
 * Signed URL for Lulu to fetch a PDF. TTL defaults to 24h — comfortably longer
 * than Lulu's async fetch window; revoked once the job passes validation (U6).
 */
export async function signedUrl(
  path: string,
  expiresInSeconds = 24 * 60 * 60,
  db: SupabaseClient = pressDb(),
): Promise<string> {
  const { data, error } = await bucket(db).createSignedUrl(path, expiresInSeconds)
  if (error || !data) throw new Error(`press/db: signedUrl(${path}): ${error?.message ?? 'missing'}`)
  return (data as { signedUrl: string }).signedUrl
}
