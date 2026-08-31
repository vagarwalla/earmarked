/**
 * press — Raindrop.io client and poller (U2; U9 uses the archive calls).
 *
 * Raindrop is the system of record: the `hw` / `homework` collection is the
 * single visible "what's in the next issue" list, so links that arrive by any
 * other door are mirrored back into it. The REST API is documented at
 * https://developer.raindrop.io — it takes a bearer test token or an OAuth
 * access token, both of which live in `RAINDROP_TOKEN`.
 *
 * The fetching lives in `createRaindropClient`; everything above it — matching
 * the collection, ordering, cursor arithmetic, shaping an item — is pure and
 * tested directly.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getCursor, insertItem, recordEvent, setCursor } from './db'
import { loadSettings } from './settings'
import type { NewPressItem, PressItem } from './types'

export const RAINDROP_API = 'https://api.raindrop.io/rest/v1'

/** Key in `press_cursors` for the collection poll. */
export const RAINDROP_CURSOR_SOURCE = 'raindrop'

/** Raindrop caps `perpage` at 50. */
const PER_PAGE = 50

/**
 * How much of a cold-start backlog one poll swallows. The cursor advances, so
 * the rest arrives on the next tick rather than in one enormous transaction.
 */
const DEFAULT_MAX_ITEMS = 200

// ── Wire shapes ──────────────────────────────────────────────────────────────
// Only the fields this pipeline reads; Raindrop returns a great deal more.

export interface Raindrop {
  _id: number
  link: string
  title?: string
  excerpt?: string
  domain?: string
  /** ISO 8601, when the raindrop was saved. */
  created: string
  lastUpdate?: string
}

export interface RaindropCollection {
  _id: number
  title: string
  count?: number
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** The inbox collection is called `hw` or `homework` (plan assumption 4). */
const HOMEWORK_NAMES = ['hw', 'homework']

export function isHomeworkCollection(title: string): boolean {
  return HOMEWORK_NAMES.includes(title.trim().toLowerCase())
}

/**
 * Setup step: pick the inbox collection out of a listing. Exported on its own
 * because resolving the id is a one-time chore whose answer goes into
 * `RAINDROP_COLLECTION_ID`.
 */
export function findHomeworkCollection(collections: RaindropCollection[]): RaindropCollection | null {
  return collections.find((c) => isHomeworkCollection(c.title)) ?? null
}

/**
 * Cursor for a raindrop: creation time plus id. Time alone is not a total
 * order — a batch saved in the same second would either be re-ingested or
 * skipped — and the id breaks those ties deterministically.
 */
export function raindropCursor(drop: Raindrop): string {
  return `${drop.created}|${drop._id}`
}

function cursorParts(cursor: string): [string, number] {
  const at = cursor.lastIndexOf('|')
  if (at === -1) return [cursor, 0]
  return [cursor.slice(0, at), Number.parseInt(cursor.slice(at + 1), 10) || 0]
}

/** Strictly after the cursor, comparing (created, id) as a pair. */
export function isAfterCursor(drop: Raindrop, cursor: string | null): boolean {
  if (!cursor) return true
  const [created, id] = cursorParts(cursor)
  if (drop.created !== created) return drop.created > created
  return drop._id > id
}

/** Oldest first, so ingesting in order lets the cursor advance monotonically. */
export function sortRaindrops(drops: Raindrop[]): Raindrop[] {
  return [...drops].sort((a, b) =>
    a.created === b.created ? a._id - b._id : a.created < b.created ? -1 : 1,
  )
}

export function newRaindropsSince(drops: Raindrop[], cursor: string | null): Raindrop[] {
  return sortRaindrops(drops.filter((d) => isAfterCursor(d, cursor)))
}

/**
 * A raindrop as a queued item. `raindrop_id` is what U9 moves into the archive
 * collection once the issue is printed, so it is stored from the first insert.
 * The item joins an issue when it has been laid out, not here.
 */
export function raindropToItem(drop: Raindrop): NewPressItem {
  return {
    source: 'raindrop',
    url: drop.link,
    raindrop_id: String(drop._id),
    title: drop.title?.trim() || null,
    source_name: drop.domain ?? null,
    published_at: drop.created ?? null,
    state: 'queued',
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

export interface RaindropClient {
  listCollections(): Promise<RaindropCollection[]>
  /** Setup helper: resolve `hw`/`homework` to the id that goes in env. */
  resolveHomeworkCollection(): Promise<RaindropCollection | null>
  listRaindrops(collectionId: number | string, opts?: { page?: number; perPage?: number }): Promise<Raindrop[]>
  createRaindrop(link: string, collectionId: number | string, title?: string | null): Promise<Raindrop>
  /** U9: the archive collection for a printed issue. */
  createCollection(title: string): Promise<RaindropCollection>
  /** U9: bulk-move raindrops out of `hw`. Returns how many moved. */
  moveRaindrops(ids: Array<number | string>, toCollectionId: number | string): Promise<number>
}

export interface RaindropClientOptions {
  token?: string
  /** Injected in tests; production uses the platform `fetch`. */
  fetchImpl?: typeof fetch
}

export function createRaindropClient(options: RaindropClientOptions = {}): RaindropClient {
  const token = options.token ?? loadSettings().raindropToken
  const doFetch = options.fetchImpl ?? fetch

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await doFetch(`${RAINDROP_API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) {
      // Raindrop puts the reason in the body; keep a snippet, never the token.
      const body = await res.text().catch(() => '')
      throw new Error(`press/raindrop: ${init?.method ?? 'GET'} ${path} failed (${res.status}): ${body.slice(0, 200)}`)
    }
    return (await res.json()) as T
  }

  return {
    async listCollections() {
      // Nested collections live behind a second endpoint; the inbox is a
      // top-level one, but checking both makes the setup helper forgiving.
      const [root, children] = await Promise.all([
        request<{ items?: RaindropCollection[] }>('/collections'),
        request<{ items?: RaindropCollection[] }>('/collections/childrens'),
      ])
      return [...(root.items ?? []), ...(children.items ?? [])]
    },

    async resolveHomeworkCollection() {
      return findHomeworkCollection(await this.listCollections())
    },

    async listRaindrops(collectionId, opts = {}) {
      const params = new URLSearchParams({
        // Oldest first: the poll walks forward from the cursor.
        sort: 'created',
        perpage: String(opts.perPage ?? PER_PAGE),
        page: String(opts.page ?? 0),
      })
      const res = await request<{ items?: Raindrop[] }>(`/raindrops/${collectionId}?${params}`)
      return res.items ?? []
    },

    async createRaindrop(link, collectionId, title) {
      const res = await request<{ item: Raindrop }>('/raindrop', {
        method: 'POST',
        body: JSON.stringify({
          link,
          collection: { $id: Number(collectionId) },
          ...(title ? { title } : {}),
          // Let Raindrop fill in title/excerpt/cover from the page itself.
          pleaseParse: {},
        }),
      })
      return res.item
    },

    async createCollection(title) {
      // The plan says `PUT /collection`; the live API creates with POST and
      // updates with PUT.
      const res = await request<{ item: RaindropCollection }>('/collection', {
        method: 'POST',
        body: JSON.stringify({ title }),
      })
      return res.item
    },

    async moveRaindrops(ids, toCollectionId) {
      if (ids.length === 0) return 0
      // Collection 0 is Raindrop's "all collections" scope, which is what lets
      // one call move items regardless of where they currently sit.
      const res = await request<{ modified?: number }>('/raindrops/0', {
        method: 'PUT',
        body: JSON.stringify({
          ids: ids.map((id) => Number(id)),
          collection: { $id: Number(toCollectionId) },
        }),
      })
      return res.modified ?? ids.length
    },
  }
}

// ── Poller ───────────────────────────────────────────────────────────────────

export interface PollResult {
  /** Items actually inserted — duplicates of links already in the pipeline are not counted. */
  ingested: PressItem[]
  /** Raindrops newer than the cursor that this poll considered. */
  scanned: number
  cursor: string | null
}

export interface PollOptions {
  client?: RaindropClient
  db?: SupabaseClient
  collectionId?: string
  maxItems?: number
}

/**
 * Ingest everything saved to `hw` since the last poll.
 *
 * Exactly-once rests on two independent guards: the cursor, which only ever
 * moves forward past raindrops already handled, and the unique `url_key` in
 * `press_items`, which absorbs a re-drop of the same link from any door.
 */
export async function pollRaindrops(options: PollOptions = {}): Promise<PollResult> {
  const settings = loadSettings()
  const client = options.client ?? createRaindropClient({ token: settings.raindropToken })
  const collectionId = options.collectionId ?? settings.raindropCollectionId
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS
  const db = options.db

  const startCursor = await getCursor(RAINDROP_CURSOR_SOURCE, db)
  let cursor = startCursor
  const ingested: PressItem[] = []
  let scanned = 0

  for (let page = 0; scanned < maxItems; page++) {
    const batch = await client.listRaindrops(collectionId, { page, perPage: PER_PAGE })
    if (batch.length === 0) break

    for (const drop of newRaindropsSince(batch, startCursor)) {
      if (scanned >= maxItems) break
      scanned++
      const item = await insertItem(raindropToItem(drop), db)
      if (item) ingested.push(item)
      // Advance past the raindrop either way: a duplicate URL is handled, not pending.
      // Raindrop pages newest-first, so later pages hold OLDER drops — take the
      // high-water mark, or the cursor would walk backwards and rescan forever.
      const candidate = raindropCursor(drop)
      if (!cursor || candidate > cursor) cursor = candidate
    }

    if (batch.length < PER_PAGE) break
  }

  if (cursor && cursor !== startCursor) {
    await setCursor(RAINDROP_CURSOR_SOURCE, cursor, db)
    await recordEvent({ kind: 'raindrop_polled', detail: { scanned, ingested: ingested.length, cursor } }, db)
  }

  return { ingested, scanned, cursor }
}
