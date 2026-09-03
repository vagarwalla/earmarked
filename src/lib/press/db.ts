/**
 * press — database and storage access.
 *
 * press tables have RLS on with no policies, so the anon key used elsewhere in
 * this app cannot read or write them. Everything here goes through the
 * service-role key and therefore must only ever run server-side.
 *
 * Which means the service-role key sees every account's reading, and the rule
 * that one person cannot touch another's is a rule the *code* keeps. Two things
 * make that hard to get wrong rather than merely documented:
 *
 *   `pressDb(owner)` returns a client that has the scoping already applied —
 *   every read, update and delete against an owned table carries
 *   `owner_id = <owner>`, and every insert carries the column. Nothing here
 *   has to remember, because there is nowhere to forget it.
 *
 *   Nothing has a default client any more. A function that touches the
 *   database takes one, so getting hold of it means writing either
 *   `pressDb(owner)` or `pressDbAsService()` — and the second is greppable,
 *   which is the point of its name.
 *
 * Functions take an explicit client so tests can pass a fake one, and so the
 * paragraph above holds.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { loadSettings } from './settings'
import { orderWithLinkposts } from './linkpost'
import type {
  ActionKind,
  ActionToken,
  ItemState,
  NewPressItem,
  PressIssue,
  PressItem,
} from './types'

let _client: SupabaseClient | null = null

/**
 * The raw service-role client — every account's everything.
 *
 * Named so it is greppable, and so that reaching for it is a decision rather
 * than a default. There are exactly four reasons to:
 *
 *   the worker, which runs the pipeline for every account;
 *   the approval links, where a signed token is the authority and there is no
 *     session to scope by;
 *   the inbound email webhook, for the same reason;
 *   looking an account up, which is how you find an owner in the first place.
 *
 * Anything driven by somebody looking at a page wants `pressDb(owner)`.
 */
export function pressDbAsService(): SupabaseClient {
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

/**
 * Tables that hold somebody's reading, and are scoped to them.
 *
 * press_action_tokens is deliberately absent: a token is followed from an
 * email by somebody who is not signed in, so the token is the authority and
 * the issue it names carries the owner. Everything else in the schema —
 * carts, editions, cover hashes — is not press and passes through untouched.
 */
const OWNED_TABLES = new Set([
  'press_issues',
  'press_items',
  'press_events',
  'press_orders',
  'press_jobs',
  'press_settings',
  'press_cursors',
])

/** Put the owner on a row, or on each of an array of them. */
function withOwner<T>(rows: T, owner: string): T {
  if (Array.isArray(rows)) {
    return rows.map((r) => ({ ...(r as object), owner_id: owner })) as unknown as T
  }
  return { ...(rows as object), owner_id: owner } as unknown as T
}

/**
 * A client that can only see one account.
 *
 * A proxy over `from()`, not a rewrite of every query: `select`, `update` and
 * `delete` come back with `owner_id = <owner>` already applied, and `insert`
 * and `upsert` carry the column. The filter builders they return chain
 * normally afterwards, because an extra `.eq` is exactly what a caller's own
 * `.eq('id', …)` would have been added to anyway.
 *
 * `rpc` is passed through unchanged. The SQL functions take ids, and an id got
 * here by having been read back through one of these queries — with one
 * exception, `press_set_issue_order`, which takes an array straight from a
 * drag in a browser and does its own owner check for that reason (018).
 */
export function pressDb(owner: string, base: SupabaseClient = pressDbAsService()): SupabaseClient {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver)

      return (table: string) => {
        const builder = target.from(table)
        if (!OWNED_TABLES.has(table)) return builder

        return new Proxy(builder as unknown as Record<string, unknown>, {
          get(qt, p, r) {
            const value = Reflect.get(qt, p, r)
            if (typeof value !== 'function') return value
            const fn = value as (...args: unknown[]) => unknown

            if (p === 'select' || p === 'update' || p === 'delete') {
              return (...args: unknown[]) => {
                const next = fn.apply(qt, args) as { eq: (c: string, v: string) => unknown }
                return next.eq('owner_id', owner)
              }
            }
            if (p === 'insert' || p === 'upsert') {
              return (rows: unknown, ...rest: unknown[]) =>
                fn.apply(qt, [withOwner(rows, owner), ...rest])
            }
            return fn.bind(qt)
          },
        }) as unknown as ReturnType<SupabaseClient['from']>
      }
    },
  })
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
  // Substack's email-share tail. Without these the same essay saved by hand
  // and named by a linkpost normalises to two different keys, and the dedup
  // that is supposed to make it one article prints it twice. The canonical
  // Substack URL is /p/<slug>; everything here is redundant with the slug.
  /^publication_id$/i,
  /^post_id$/i,
  /^isFreemail$/i,
  /^triedRedirect$/i,
  /^showWelcomeOnShare$/i,
  /^r$/i,
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

export async function getIssue(issueId: string, db: SupabaseClient): Promise<PressIssue | null> {
  const { data, error } = await db.from('press_issues').select('*').eq('id', issueId).maybeSingle()
  if (error) throw new Error(`press/db: getIssue: ${error.message}`)
  return (data as PressIssue) ?? null
}

export async function getOpenIssue(db: SupabaseClient): Promise<PressIssue | null> {
  const { data, error } = await db.from('press_issues').select('*').eq('state', 'open').maybeSingle()
  if (error) throw new Error(`press/db: getOpenIssue: ${error.message}`)
  return (data as PressIssue) ?? null
}

export async function issuesInState(
  states: readonly string[],
  db: SupabaseClient,
): Promise<PressIssue[]> {
  const { data, error } = await db.from('press_issues').select('*').in('state', states)
  if (error) throw new Error(`press/db: issuesInState: ${error.message}`)
  return (data as PressIssue[]) ?? []
}

/** Close the open issue and open its successor atomically. */
export async function closeIssue(
  issueId: string,
  pageTotal: number,
  db: SupabaseClient,
): Promise<PressIssue> {
  const res = await db.rpc('press_close_issue', { p_issue_id: issueId, p_page_total: pageTotal })
  return unwrap(res as { data: PressIssue | null; error: { message: string } | null }, 'close_issue')
}

/** V declined: items go back to the open issue. Returns how many moved. */
export async function skipIssue(issueId: string, db: SupabaseClient): Promise<number> {
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
  db: SupabaseClient,
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
  db: SupabaseClient,
): Promise<PressItem | null> {
  const url_key = item.url_key ?? normalizeUrl(item.url)
  const { data, error } = await db
    .from('press_items')
    // Per owner since 018. Globally unique was the bug that made a friend's
    // paste of a link V had already saved vanish without a word.
    .upsert({ ...item, url_key }, { onConflict: 'owner_id,url_key', ignoreDuplicates: true })
    .select()
  if (error) throw new Error(`press/db: insertItem: ${error.message}`)
  const rows = (data as PressItem[]) ?? []
  return rows[0] ?? null
}

export async function getItem(itemId: string, db: SupabaseClient): Promise<PressItem | null> {
  const { data, error } = await db.from('press_items').select('*').eq('id', itemId).maybeSingle()
  if (error) throw new Error(`press/db: getItem: ${error.message}`)
  return (data as PressItem) ?? null
}

export async function itemsInState(
  states: readonly ItemState[],
  db: SupabaseClient,
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
export async function itemsForIssue(issueId: string, db: SupabaseClient): Promise<PressItem[]> {
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
  db: SupabaseClient,
): Promise<void> {
  const now = new Date().toISOString()
  // A linkpost's children print directly behind it, whatever order arrived —
  // the same normalisation the local pipeline applies, so one definition of the
  // invariant serves both. See src/lib/press/linkpost.ts.
  const parents = await linkpostParents(itemIds, db)
  const ordered = orderWithLinkposts(itemIds, (id) => parents.get(id))
  // Clear first: moving an article past another would otherwise trip the
  // uniqueness index halfway through the rewrite.
  const { error: clearError } = await db
    .from('press_items')
    .update({ position: null, updated_at: now })
    .eq('issue_id', issueId)
  if (clearError) throw new Error(`press/db: setIssueOrder: ${clearError.message}`)

  for (const [position, id] of ordered.entries()) {
    const { error } = await db
      .from('press_items')
      .update({ position, updated_at: now })
      .eq('id', id)
      .eq('issue_id', issueId)
    if (error) throw new Error(`press/db: setIssueOrder: ${error.message}`)
  }
}

/**
 * The linkpost each of these items came from, for the rows that came from one.
 * Read from the table rather than from the list in hand: a parent can be in a
 * different issue, or in the pool, and the ordering still has to know.
 */
export async function linkpostParents(
  itemIds: readonly string[],
  db: SupabaseClient,
): Promise<Map<string, string | null>> {
  if (itemIds.length === 0) return new Map()
  const { data, error } = await db
    .from('press_items')
    .select('id, linkpost_parent_id')
    .in('id', [...itemIds])
  if (error) throw new Error(`press/db: linkpostParents: ${error.message}`)
  const rows = (data as Array<{ id: string; linkpost_parent_id: string | null }>) ?? []
  return new Map(rows.map((r) => [r.id, r.linkpost_parent_id]))
}

/** The pieces a linkpost named, whatever state they are in. */
export async function linkpostChildren(
  itemId: string,
  db: SupabaseClient,
): Promise<PressItem[]> {
  const { data, error } = await db
    .from('press_items')
    .select('*')
    .eq('linkpost_parent_id', itemId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`press/db: linkpostChildren: ${error.message}`)
  return (data as PressItem[]) ?? []
}

/**
 * Pull a waiting article into an issue, at the end of the running order.
 *
 * A linkpost brings the pieces it named with it, and a piece brings the
 * linkpost that named it: half a roundup prints an opener that says "Linkpost"
 * above nothing, or one that says "Linkpost of X" where X is not in the issue.
 * Anything already spoken for by another issue is left where it is.
 */
export async function addItemToIssue(
  itemId: string,
  issueId: string,
  db: SupabaseClient,
): Promise<void> {
  const existing = await itemsForIssue(issueId, db)
  const here = new Set(existing.map((i) => i.id))
  const add: string[] = []

  const claim = (item: Pick<PressItem, 'id' | 'state' | 'issue_id'>) => {
    if (here.has(item.id) || add.includes(item.id)) return
    if (item.issue_id && item.issue_id !== issueId) return
    if (item.state !== 'laid_out' && item.issue_id !== issueId) return
    add.push(item.id)
  }

  const item = await getItem(itemId, db)
  add.push(itemId)

  if (item?.linkpost_parent_id) {
    const parent = await getItem(item.linkpost_parent_id, db)
    if (parent) claim(parent)
  }
  if (item?.is_linkpost) {
    for (const child of await linkpostChildren(itemId, db)) claim(child)
  }

  let position = existing.length
  for (const id of add) {
    await updateItem(id, { state: 'in_issue', issue_id: issueId, position: position++ }, db)
    await recordEvent({ item_id: id, issue_id: issueId, kind: 'item_added' }, db)
  }

  // The adds land at the end; the normaliser puts each group back together.
  await setIssueOrder(issueId, [...existing.map((i) => i.id), ...add], db)
}

/**
 * Drop an article back to the waiting list, closing the gap behind it so the
 * order stays dense and the next add lands at the end rather than in a hole.
 */
export async function removeItemFromIssue(
  itemId: string,
  issueId: string,
  db: SupabaseClient,
): Promise<void> {
  // Taking out a linkpost takes out what it brought in: those pieces are here
  // only because it named them, and an opener reading "Linkpost of X" with X
  // gone is a printed mistake. They go back to the pool, not to the bin.
  const item = await getItem(itemId, db)
  const going = [itemId]
  if (item?.is_linkpost) {
    for (const child of await linkpostChildren(itemId, db)) {
      if (child.issue_id === issueId) going.push(child.id)
    }
  }

  for (const id of going) {
    await updateItem(id, { state: 'laid_out', issue_id: null, position: null }, db)
    await recordEvent({ item_id: id, issue_id: issueId, kind: 'item_removed' }, db)
  }

  const remaining = await itemsForIssue(issueId, db)
  await setIssueOrder(issueId, remaining.map((i) => i.id), db)
}

export async function updateItem(
  itemId: string,
  patch: Partial<PressItem>,
  db: SupabaseClient,
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
  db: SupabaseClient,
): Promise<void> {
  await updateItem(itemId, { state: 'failed', failure_reason: reason }, db)
  await recordEvent({ item_id: itemId, kind: 'item_failed', detail: { reason } }, db)
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface NewEvent {
  /**
   * Whose press this happened in.
   *
   * Set automatically by a scoped client and left NULL by the service one,
   * which is right in both directions: an event recorded while acting for
   * somebody belongs to them, and a `worker_error` from a scheduler that threw
   * belongs to nobody. `press_events.owner_id` is nullable, alone among the
   * owned tables, for that second case (018). Pass it explicitly only where
   * neither applies — the approval routes, which act for an owner with no
   * session to read one from.
   */
  owner_id?: string | null
  issue_id?: string | null
  item_id?: string | null
  kind: string
  detail?: Record<string, unknown>
}

export async function recordEvent(event: NewEvent, db: SupabaseClient): Promise<void> {
  const row: Record<string, unknown> = {
    issue_id: event.issue_id ?? null,
    item_id: event.item_id ?? null,
    kind: event.kind,
    detail: event.detail ?? {},
  }
  // Only when given: a scoped client sets it on the way past, and writing
  // `owner_id: undefined` here would have the proxy's value overwritten by it.
  if (event.owner_id) row.owner_id = event.owner_id
  const { error } = await db.from('press_events').insert(row)
  // The audit log must never take the pipeline down with it.
  if (error) console.error(`press/db: recordEvent(${event.kind}) failed: ${error.message}`)
}

// ── Action tokens (U6) ───────────────────────────────────────────────────────

export async function storeActionToken(
  token: {
    token_hash: string
    issue_id: string
    /** Every issue the link acts on. Defaults to the one in `issue_id`. */
    issue_ids?: string[]
    action: ActionKind
    item_id?: string | null
    expires_at: string
  },
  db: SupabaseClient,
): Promise<void> {
  const { error } = await db.from('press_action_tokens').insert({
    token_hash: token.token_hash,
    issue_id: token.issue_id,
    issue_ids: token.issue_ids ?? [token.issue_id],
    action: token.action,
    item_id: token.item_id ?? null,
    expires_at: token.expires_at,
  })
  if (error) throw new Error(`press/db: storeActionToken: ${error.message}`)
}

/** Look a token up without spending it — used by the GET confirmation page. */
export async function peekActionToken(
  tokenHash: string,
  db: SupabaseClient,
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
  db: SupabaseClient,
): Promise<ActionToken | null> {
  const res = await db.rpc('press_consume_token', { p_token_hash: tokenHash })
  if (res.error) throw new Error(`press/db: consume_token: ${res.error.message}`)
  return (res.data as ActionToken) ?? null
}

/**
 * Invalidate every outstanding token for an issue (after a recompose).
 *
 * Matched on `issue_ids`, not `issue_id`: a bundle's link is stored against
 * the first issue in it, and matching the scalar column would leave a link
 * that orders issues 3 and 4 alive after issue 4 was re-composed — or, worse,
 * alongside a fresh link that orders issue 4 on its own. The two carry
 * different idempotency keys, so following both buys issue 4 twice.
 */
export async function expireIssueTokens(issueId: string, db: SupabaseClient): Promise<void> {
  const { error } = await db
    .from('press_action_tokens')
    .update({ used_at: new Date().toISOString() })
    .contains('issue_ids', [issueId])
    .is('used_at', null)
  if (error) throw new Error(`press/db: expireIssueTokens: ${error.message}`)
}

// ── Cursors (U2) ─────────────────────────────────────────────────────────────

export async function getCursor(source: string, db: SupabaseClient): Promise<string | null> {
  const { data, error } = await db.from('press_cursors').select('cursor').eq('source', source).maybeSingle()
  if (error) throw new Error(`press/db: getCursor: ${error.message}`)
  return (data as { cursor: string | null } | null)?.cursor ?? null
}

export async function setCursor(
  source: string,
  cursor: string,
  db: SupabaseClient,
): Promise<void> {
  const { error } = await db
    .from('press_cursors')
    // The primary key is (owner_id, source) since 018, and the scoped client
    // puts the owner half on the row — but `onConflict` names columns, not
    // values, so it has to say both or the upsert looks for a constraint that
    // no longer exists.
    .upsert({ source, cursor, updated_at: new Date().toISOString() }, { onConflict: 'owner_id,source' })
  if (error) throw new Error(`press/db: setCursor: ${error.message}`)
}

// ── Storage ──────────────────────────────────────────────────────────────────
//
// The one place a default client is still right. These take a path and reach
// `db.storage`, which the owner-scoping proxy does not touch and could not
// usefully touch: a Storage object has no `owner_id`, and the path — a UUID
// nobody can guess and that was itself read out of an owner-scoped row — is
// the capability. Passing a scoped client here works identically, and callers
// that have one still do; the default exists so that fetching an image does
// not have to know whose article it belongs to.

function bucket(db: SupabaseClient) {
  return db.storage.from(loadSettings().storageBucket)
}

export async function putObject(
  path: string,
  body: Uint8Array | string,
  contentType: string,
  db: SupabaseClient = pressDbAsService(),
): Promise<string> {
  const { error } = await bucket(db).upload(path, body as Uint8Array, { contentType, upsert: true })
  if (error) throw new Error(`press/db: putObject(${path}): ${error.message}`)
  return path
}

export async function getObject(
  path: string,
  db: SupabaseClient = pressDbAsService(),
): Promise<Uint8Array> {
  const { data, error } = await bucket(db).download(path)
  if (error || !data) throw new Error(`press/db: getObject(${path}): ${error?.message ?? 'missing'}`)
  return new Uint8Array(await (data as Blob).arrayBuffer())
}

export async function getJson<T>(
  path: string,
  db: SupabaseClient = pressDbAsService(),
): Promise<T> {
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
  db: SupabaseClient = pressDbAsService(),
): Promise<string> {
  const { data, error } = await bucket(db).createSignedUrl(path, expiresInSeconds)
  if (error || !data) throw new Error(`press/db: signedUrl(${path}): ${error?.message ?? 'missing'}`)
  return (data as { signedUrl: string }).signedUrl
}
