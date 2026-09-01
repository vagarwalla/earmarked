import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  normalizeUrl,
  insertItem,
  closeIssue,
  skipIssue,

  consumeActionToken,
  getCursor,
  setCursor,
  failItem,
  storagePath,
} from '../db'
import {
  canTransitionItem,
  canTransitionIssue,
  ITEM_TRANSITIONS,
  ISSUE_TRANSITIONS,
  spineWidthPt,
  spineTakesText,
  spineTextHeightPt,
  coverSizePt,
  MEDIA_WIDTH_PT,
  MEDIA_HEIGHT_PT,
  type ItemState,
  type IssueState,
} from '../types'
import { loadSettings, missingSettings, assertConfigured } from '../settings'

// ── A fake Supabase client: enough chaining for what db.ts actually calls ─────

function tableStub(result: { data?: unknown; error?: { message: string } | null }) {
  const res = { data: result.data ?? null, error: result.error ?? null }
  const chain: Record<string, unknown> = {}
  const self = () => chain
  for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'update', 'insert', 'upsert']) {
    chain[m] = vi.fn(self)
  }
  chain.maybeSingle = vi.fn(async () => res)
  chain.single = vi.fn(async () => res)
  // Awaiting the chain itself resolves to the result (PostgREST builders are thenable).
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(res).then(resolve)
  return chain
}

function fakeDb(opts: {
  table?: { data?: unknown; error?: { message: string } | null }
  rpc?: { data?: unknown; error?: { message: string } | null }
} = {}) {
  const table = tableStub(opts.table ?? {})
  const from = vi.fn(() => table)
  const rpc = vi.fn(async () => ({ data: opts.rpc?.data ?? null, error: opts.rpc?.error ?? null }))
  return { client: { from, rpc } as unknown as SupabaseClient, from, rpc, table }
}

// ── normalizeUrl ─────────────────────────────────────────────────────────────

describe('normalizeUrl', () => {
  it('strips the tail Substack puts on a link shared from an email', () => {
    // Without this the same essay saved by hand and named by a linkpost
    // normalises to two keys, and the dedup meant to make it one article
    // prints it twice.
    expect(
      normalizeUrl(
        'https://www.astralcodexten.com/p/half-a-month-of-consolation-writing?utm_source=post-email-title&publication_id=89120&post_id=1234&isFreemail=true&r=abc',
      ),
    ).toBe(normalizeUrl('https://www.astralcodexten.com/p/half-a-month-of-consolation-writing'))
  })

  it('collapses the ways the same article gets saved', () => {
    const key = normalizeUrl('https://www.example.com/a-piece/')
    expect(normalizeUrl('http://example.com/a-piece')).toBe(key)
    expect(normalizeUrl('https://example.com/a-piece#section-2')).toBe(key)
    expect(normalizeUrl('https://www.example.com/a-piece/?utm_source=substack&utm_medium=email')).toBe(key)
    expect(normalizeUrl('  https://EXAMPLE.com/a-piece  ')).toBe(key)
  })

  it('keeps params that identify the document', () => {
    expect(normalizeUrl('https://example.com/read?id=99&utm_source=x')).toBe('example.com/read?id=99')
  })

  it('sorts params so order does not create a second item', () => {
    expect(normalizeUrl('https://example.com/p?b=2&a=1')).toBe(normalizeUrl('https://example.com/p?a=1&b=2'))
  })

  it('distinguishes genuinely different articles', () => {
    expect(normalizeUrl('https://example.com/one')).not.toBe(normalizeUrl('https://example.com/two'))
  })

  it('rejects non-http schemes and junk', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeUrl('not a url')).toBeNull()
    expect(normalizeUrl('')).toBeNull()
    expect(normalizeUrl(null)).toBeNull()
  })
})

// ── State machines ───────────────────────────────────────────────────────────

describe('item lifecycle', () => {
  it('walks the happy path', () => {
    const path: ItemState[] = ['queued', 'extracted', 'laid_out', 'in_issue', 'printed']
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransitionItem(path[i], path[i + 1])).toBe(true)
    }
  })

  it('refuses to skip stages', () => {
    expect(canTransitionItem('queued', 'in_issue')).toBe(false)
    expect(canTransitionItem('queued', 'printed')).toBe(false)
    expect(canTransitionItem('extracted', 'in_issue')).toBe(false)
  })

  it('lets anything but a printed item fail, and a failure be retried', () => {
    for (const from of ['queued', 'extracted', 'laid_out', 'in_issue'] as ItemState[]) {
      expect(canTransitionItem(from, 'failed')).toBe(true)
    }
    expect(canTransitionItem('printed', 'failed')).toBe(false)
    expect(canTransitionItem('failed', 'queued')).toBe(true)
  })

  it('returns a skipped issue’s items to laid_out so they rejoin the open issue', () => {
    expect(canTransitionItem('in_issue', 'laid_out')).toBe(true)
  })

  it('treats printed as terminal', () => {
    expect(ITEM_TRANSITIONS.printed).toHaveLength(0)
  })
})

describe('issue lifecycle', () => {
  it('walks the happy path', () => {
    const path: IssueState[] = ['open', 'closed', 'approved', 'ordered', 'shipped']
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransitionIssue(path[i], path[i + 1])).toBe(true)
    }
  })

  it('never orders straight from open — approval is the gate', () => {
    expect(canTransitionIssue('open', 'approved')).toBe(false)
    expect(canTransitionIssue('open', 'ordered')).toBe(false)
    expect(canTransitionIssue('closed', 'ordered')).toBe(false)
  })

  it('recovers from a post-approval Lulu rejection', () => {
    expect(canTransitionIssue('approved', 'rejected')).toBe(true)
    expect(canTransitionIssue('rejected', 'approved')).toBe(true)
    expect(canTransitionIssue('rejected', 'skipped')).toBe(true)
  })

  it('treats shipped and skipped as terminal', () => {
    expect(ISSUE_TRANSITIONS.shipped).toHaveLength(0)
    expect(ISSUE_TRANSITIONS.skipped).toHaveLength(0)
  })
})

// ── Print spec ───────────────────────────────────────────────────────────────

describe('print spec', () => {
  it('sizes the interior media box as 7x10 plus bleed', () => {
    expect(MEDIA_WIDTH_PT).toBe(522)  // (7 + 0.25) * 72
    expect(MEDIA_HEIGHT_PT).toBe(738) // (10 + 0.25) * 72
  })

  it('grows the spine with the page count', () => {
    const thin = spineWidthPt(32)
    const fat = spineWidthPt(200)
    expect(fat).toBeGreaterThan(thin)
    // Lulu: (pages / 444) + 0.06" for softcover perfect bound. The paper stack
    // is one inch at 444 pages; the constant is the glue and the wrap's fold.
    expect(spineWidthPt(444)).toBeCloseTo(72 + 0.06 * 72, 5)
    expect(spineWidthPt(0)).toBeCloseTo(0.06 * 72, 5)
  })

  it('withholds spine text below Lulu`s 100-page floor', () => {
    expect(spineTakesText(99)).toBe(false)
    expect(spineTakesText(100)).toBe(true)
    // Whatever is left after 1/16" of clearance at each edge of the spine.
    expect(spineTextHeightPt(100)).toBeCloseTo(spineWidthPt(100) - 2 * 0.0625 * 72, 5)
    expect(spineTextHeightPt(100)).toBeGreaterThan(0)
  })

  it('makes the cover two trims wide plus the spine and bleed', () => {
    const { width, height } = coverSizePt(100)
    expect(width).toBeCloseTo(504 * 2 + spineWidthPt(100) + 18, 5)
    expect(height).toBe(738)
  })
})

// ── db functions ─────────────────────────────────────────────────────────────

describe('insertItem', () => {
  it('derives the dedupe key from the url', async () => {
    const { client, from, table } = fakeDb({ table: { data: [{ id: 'i1' }] } })
    await insertItem({ source: 'raindrop', url: 'https://www.example.com/a/?utm_source=x' }, client)
    expect(from).toHaveBeenCalledWith('press_items')
    expect(table.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ url_key: 'example.com/a' }),
      expect.objectContaining({ onConflict: 'url_key', ignoreDuplicates: true }),
    )
  })

  it('returns null when the link is already in the pipeline', async () => {
    // ignoreDuplicates makes PostgREST return no rows for a conflicting insert.
    const { client } = fakeDb({ table: { data: [] } })
    expect(await insertItem({ source: 'raindrop', url: 'https://example.com/a' }, client)).toBeNull()
  })

  it('leaves url_key null for items with no url', async () => {
    const { client, table } = fakeDb({ table: { data: [{ id: 'i2' }] } })
    await insertItem({ source: 'newsletter', title: 'A newsletter' }, client)
    expect(table.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ url_key: null }),
      expect.anything(),
    )
  })

  it('surfaces a database error rather than silently dropping the item', async () => {
    const { client } = fakeDb({ table: { error: { message: 'connection reset' } } })
    await expect(insertItem({ source: 'raindrop', url: 'https://example.com/a' }, client)).rejects.toThrow(
      /connection reset/,
    )
  })
})

describe('closeIssue', () => {
  it('goes through the atomic rpc, not a bare update', async () => {
    const { client, rpc } = fakeDb({ rpc: { data: { id: 'iss1', state: 'closed' } } })
    const closed = await closeIssue('iss1', 104, client)
    expect(rpc).toHaveBeenCalledWith('press_close_issue', { p_issue_id: 'iss1', p_page_total: 104 })
    expect(closed.state).toBe('closed')
  })

  it('propagates the guard when the issue is not open', async () => {
    const { client } = fakeDb({ rpc: { error: { message: 'issue is not open' } } })
    await expect(closeIssue('iss1', 104, client)).rejects.toThrow(/not open/)
  })
})

describe('skipIssue', () => {
  it('reports how many items went back to the open issue', async () => {
    const { client, rpc } = fakeDb({ rpc: { data: 7 } })
    expect(await skipIssue('iss1', client)).toBe(7)
    expect(rpc).toHaveBeenCalledWith('press_skip_issue', { p_issue_id: 'iss1' })
  })
})

// claimOrder's tests moved with it. What they were protecting — "a retry
// after a timeout must not buy a second copy" — is now protected one level
// down, by press_orders.idempotency_key, and is tested against performApproval
// in lulu.test.ts where the retry actually happens.

describe('consumeActionToken', () => {
  it('returns the token when it was still unspent', async () => {
    const { client, rpc } = fakeDb({ rpc: { data: { token_hash: 'h', action: 'approve', issue_id: 'iss1' } } })
    const token = await consumeActionToken('h', client)
    expect(token?.action).toBe('approve')
    expect(rpc).toHaveBeenCalledWith('press_consume_token', { p_token_hash: 'h' })
  })

  it('returns null for a token already spent or expired', async () => {
    const { client } = fakeDb({ rpc: { data: null } })
    expect(await consumeActionToken('h', client)).toBeNull()
  })
})

describe('cursors', () => {
  it('reads null before the first poll', async () => {
    const { client } = fakeDb({ table: { data: null } })
    expect(await getCursor('raindrop', client)).toBeNull()
  })

  it('upserts on the source key so a poll never duplicates a row', async () => {
    const { client, table } = fakeDb({ table: { data: null } })
    await setCursor('raindrop', '12345', client)
    expect(table.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'raindrop', cursor: '12345' }),
      { onConflict: 'source' },
    )
  })
})

describe('failItem', () => {
  it('records the reason on the item and in the audit log', async () => {
    const { client, from, table } = fakeDb({ table: { data: null } })
    await failItem('item1', 'extraction ladder exhausted', client)
    expect(table.update).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failed', failure_reason: 'extraction ladder exhausted' }),
    )
    expect(from).toHaveBeenCalledWith('press_events')
  })
})

describe('storagePath', () => {
  it('keeps every artefact for an item under one prefix', () => {
    expect(storagePath.articleJson('abc')).toBe('items/abc/article.json')
    expect(storagePath.fragment('abc')).toBe('items/abc/fragment.pdf')
    expect(storagePath.image('abc', 'lead.jpg')).toBe('items/abc/images/lead.jpg')
    expect(storagePath.interior('iss1')).toBe('issues/iss1/interior.pdf')
  })
})

// ── settings ─────────────────────────────────────────────────────────────────

describe('settings', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('PRESS_') || k.startsWith('LULU_') || k.startsWith('RAINDROP_')) delete process.env[k]
    }
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it('defaults the issue policy to the plan’s numbers', () => {
    const s = loadSettings()
    expect(s.pageThreshold).toBe(100)
    expect(s.maxIssueAgeWeeks).toBe(8)
    expect(s.storageBucket).toBe('press')
  })

  it('starts on the Lulu sandbox unless production is explicit', () => {
    expect(loadSettings().luluSandbox).toBe(true)
    process.env.LULU_SANDBOX = 'false'
    expect(loadSettings().luluSandbox).toBe(false)
  })

  it('ignores a nonsense threshold rather than closing issues at zero pages', () => {
    process.env.PRESS_PAGE_THRESHOLD = 'lots'
    expect(loadSettings().pageThreshold).toBe(100)
    process.env.PRESS_PAGE_THRESHOLD = '-5'
    expect(loadSettings().pageThreshold).toBe(100)
  })

  it('parses the newsletter allowlist case-insensitively', () => {
    process.env.PRESS_NEWSLETTER_ALLOWLIST = 'A@substack.com, b@Example.COM ,'
    expect(loadSettings().newsletterAllowlist).toEqual(['a@substack.com', 'b@example.com'])
  })

  it('treats a partial shipping address as no address', () => {
    process.env.PRESS_SHIP_STREET1 = '1 Somewhere'
    expect(loadSettings().shipping).toBeNull()
    process.env.PRESS_SHIP_CITY = 'Town'
    process.env.PRESS_SHIP_POSTCODE = '00000'
    expect(loadSettings().shipping?.countryCode).toBe('US')
  })

  it('names what a unit is missing instead of failing at 2am', () => {
    expect(missingSettings('ingest')).toEqual(['raindropToken', 'raindropCollectionId'])
    expect(() => assertConfigured('ingest')).toThrow(/raindropToken/)
    process.env.RAINDROP_TOKEN = 't'
    process.env.RAINDROP_COLLECTION_ID = '42'
    expect(missingSettings('ingest')).toEqual([])
  })
})
