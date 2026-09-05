import { describe, it, expect, vi } from 'vitest'
import { archiveIssue, movableItems } from '../archive'
import type { RaindropClient } from '../raindrop'
import type { PressIssue, PressItem } from '../types'
import type { PressSettings } from '../settings'

function item(over: Partial<PressItem> = {}): PressItem {
  // A named, typed base rather than one literal: spreading a `Partial<T>`
  // over a `T` widens every field the partial declares back to `| undefined`,
  // so the result stops being a `T`. Annotating the base keeps the literal
  // contextually typed, and Object.assign keeps the override behaviour.
  const base: PressItem = {
    // Owned, as every press row has been since migration 018. The factories
    // carry it so a test row is the shape the database actually stores.
    owner_id: '00000000-0000-0000-0000-000000000001',
    id: 'i1',
    url: 'https://example.com/a',
    url_key: 'example.com/a',
    source: 'raindrop',
    raindrop_id: '101',
    state: 'in_issue',
    issue_id: 'iss1',
    position: null,
    title: 'A piece',
    byline: null,
    source_name: null,
    published_at: null,
    content_path: 'items/i1/article.json',
    fragment_path: null,
    page_count: 4,
    failure_reason: null,
    raw_email_path: null,
    is_linkpost: false,
    linkpost_parent_id: null,
    linkpost_anchor: null,
    linkpost_scanned_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  }
  return Object.assign(base, over)
}

function issue(over: Partial<PressIssue> = {}): PressIssue {
  // A named, typed base rather than one literal: spreading a `Partial<T>`
  // over a `T` widens every field the partial declares back to `| undefined`,
  // so the result stops being a `T`. Annotating the base keeps the literal
  // contextually typed, and Object.assign keeps the override behaviour.
  const base: PressIssue = {
    // Owned, as every press row has been since migration 018. The factories
    // carry it so a test row is the shape the database actually stores.
    owner_id: '00000000-0000-0000-0000-000000000001',
    // Private until deliberately shared; the row has no implicit default,
    // so neither does the factory.
    visibility: 'private',
    shared_at: null,
    id: 'iss1',
    number: 3,
    state: 'ordered',
    name: 'Winter Light',
    page_total: 100,
    interior_path: 'i',
    cover_path: 'c',
    quote_cents: null,
    quote_currency: null,
    lulu_job_id: 'job_1',
    lulu_idempotency_key: 'k',
    lulu_status: 'CREATED',
    tracking_url: null,
    archive_collection_id: null,
    built_order: null,
    rejection_reason: null,
    opened_at: '2026-07-01T00:00:00Z',
    closed_at: '2026-08-29T00:00:00Z',
    approved_at: '2026-08-30T00:00:00Z',
    ordered_at: '2026-08-30T12:00:00Z',
    shipped_at: null,
    approval_sent_at: null,
    updated_at: '2026-08-30T00:00:00Z',
  }
  return Object.assign(base, over)
}

/** A db that reflects the writes archiveIssue makes, so a re-run sees them. */
function archiveDb(items: PressItem[], issueRow: PressIssue) {
  const state = { issue: { ...issueRow }, items: items.map((i) => ({ ...i })) }
  const events: string[] = []
  const client = {
    from(table: string) {
      const b: Record<string, unknown> = {}
      let patch: Record<string, unknown> | null = null
      b.select = () => b
      b.eq = (col: string, val: string) => {
        if (patch && table === 'press_issues') Object.assign(state.issue, patch)
        if (patch && table === 'press_items' && col === 'id') {
          const row = state.items.find((i) => i.id === val)
          if (row) Object.assign(row, patch)
        }
        return b
      }
      b.in = () => b
      b.order = () => b
      b.limit = () => b
      b.update = (p: Record<string, unknown>) => {
        patch = p
        return b
      }
      b.insert = (row: Record<string, unknown>) => {
        if (table === 'press_events') events.push(String(row.kind))
        return b
      }
      b.upsert = () => b
      b.maybeSingle = async () => ({ data: table === 'press_issues' ? state.issue : null, error: null })
      b.then = (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: table === 'press_items' ? state.items : [], error: null }).then(r)
      return b
    },
    rpc: async () => ({ data: null, error: null }),
  }
  return { client: client as never, state, events }
}

function fakeRaindrop(over: Partial<RaindropClient> = {}) {
  const created: string[] = []
  const moves: { ids: (string | number)[]; to: string | number }[] = []
  const client: RaindropClient = {
    listCollections: async () => [],
    resolveHomeworkCollection: async () => null,
    listRaindrops: async () => [],
    createRaindrop: async () => ({}) as never,
    createCollection: async (title: string) => {
      created.push(title)
      return { _id: 777, title } as never
    },
    moveRaindrops: async (ids, to) => {
      moves.push({ ids, to })
      return ids.length
    },
    ...over,
  }
  return { client, created, moves }
}

const settings = { raindropToken: 'rd', raindropCollectionId: '4242' } as PressSettings

describe('movableItems', () => {
  it('is exactly the items that have a raindrop and are still in the issue', () => {
    const items = [
      item({ id: 'a', raindrop_id: '1' }),
      item({ id: 'b', raindrop_id: null, source: 'newsletter' }),
      item({ id: 'c', raindrop_id: '3', state: 'printed' }),
      item({ id: 'd', raindrop_id: '4', state: 'failed' }),
    ]
    expect(movableItems(items).map((i) => i.id)).toEqual(['a'])
  })
})

describe('archiveIssue', () => {
  it('creates the dated collection and moves the raindrops into it', async () => {
    const items = [
      item({ id: 'a', raindrop_id: '101' }),
      item({ id: 'b', raindrop_id: '102' }),
      item({ id: 'c', raindrop_id: '103' }),
      item({ id: 'd', raindrop_id: null, source: 'newsletter' }),
    ]
    const db = archiveDb(items, issue())
    const rd = fakeRaindrop()

    const result = await archiveIssue(issue(), { db: db.client, settings, raindrop: rd.client })

    expect(rd.created).toEqual(['2026-08-30 — Winter Light'])
    expect(rd.moves).toEqual([{ ids: ['101', '102', '103'], to: '777' }])
    expect(result.moved).toBe(3)
    // All four items are printed — the newsletter simply has nothing to move.
    expect(result.printed).toBe(4)
    expect(db.state.items.every((i) => i.state === 'printed')).toBe(true)
    expect(db.state.issue.archive_collection_id).toBe('777')
  })

  it('names the collection for the order date, not today', async () => {
    const db = archiveDb([item()], issue({ ordered_at: '2026-03-14T09:00:00Z' }))
    const rd = fakeRaindrop()
    await archiveIssue(issue({ ordered_at: '2026-03-14T09:00:00Z' }), {
      db: db.client,
      settings,
      raindrop: rd.client,
      now: new Date('2026-09-01T00:00:00Z'),
    })
    expect(rd.created).toEqual(['2026-03-14 — Winter Light'])
  })

  it('re-running after a crash mid-move does not create a second collection', async () => {
    const items = [item({ id: 'a', raindrop_id: '101' }), item({ id: 'b', raindrop_id: '102' })]
    const db = archiveDb(items, issue())
    const rd = fakeRaindrop({
      moveRaindrops: vi.fn(async () => {
        throw new Error('raindrop 502')
      }),
    })

    // First run: the collection is created, then the move fails.
    await expect(
      archiveIssue(issue(), { db: db.client, settings, raindrop: rd.client }),
    ).rejects.toThrow(/502/)
    expect(rd.created).toHaveLength(1)
    expect(db.state.issue.archive_collection_id).toBe('777')
    expect(db.state.items.every((i) => i.state === 'in_issue')).toBe(true)

    // Next tick: it picks up the existing collection and finishes the move.
    const rd2 = fakeRaindrop()
    // The issue row already carries the collection id from the failed run.
    const result = await archiveIssue(
      { ...issue(), archive_collection_id: '777' },
      { db: db.client, settings, raindrop: rd2.client },
    )
    expect(rd2.created).toHaveLength(0)
    expect(result.collectionId).toBe('777')
    expect(result.moved).toBe(2)
    expect(db.state.items.every((i) => i.state === 'printed')).toBe(true)
  })

  it('is a no-op once everything has already been archived', async () => {
    const items = [item({ id: 'a', state: 'printed' }), item({ id: 'b', state: 'printed' })]
    const db = archiveDb(items, issue({ archive_collection_id: '777' }))
    const rd = fakeRaindrop()

    const result = await archiveIssue(issue({ archive_collection_id: '777' }), {
      db: db.client,
      settings,
      raindrop: rd.client,
    })
    expect(result.alreadyDone).toBe(true)
    expect(result.moved).toBe(0)
    expect(rd.moves).toHaveLength(0)
    expect(rd.created).toHaveLength(0)
  })

  it('leaves a dropped article in hw — it was never printed', async () => {
    const items = [
      item({ id: 'a', raindrop_id: '101' }),
      item({ id: 'dropped', raindrop_id: '999', state: 'failed', failure_reason: 'reader-dropped' }),
    ]
    const db = archiveDb(items, issue())
    const rd = fakeRaindrop()

    await archiveIssue(issue(), { db: db.client, settings, raindrop: rd.client })

    expect(rd.moves[0].ids).toEqual(['101'])
    expect(db.state.items.find((i) => i.id === 'dropped')?.state).toBe('failed')
  })

  it('refuses to archive an issue that was never ordered', async () => {
    const db = archiveDb([item()], issue({ state: 'closed' }))
    const rd = fakeRaindrop()
    await expect(
      archiveIssue(issue({ state: 'closed' }), { db: db.client, settings, raindrop: rd.client }),
    ).rejects.toThrow(/not ordered/)
    expect(rd.created).toHaveLength(0)
  })

  it('archives a shipped issue too, in case the ordered tick was missed', async () => {
    const db = archiveDb([item()], issue({ state: 'shipped' }))
    const rd = fakeRaindrop()
    await expect(
      archiveIssue(issue({ state: 'shipped' }), { db: db.client, settings, raindrop: rd.client }),
    ).resolves.toMatchObject({ moved: 1 })
  })
})
