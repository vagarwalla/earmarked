import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Listing, PriceResponse, SourceFetch } from '@/lib/types'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('@/lib/abebooks', () => ({ fetchListingsByISBN: vi.fn() }))
vi.mock('@/lib/thriftbooks', () => ({ fetchThriftBooksListings: vi.fn() }))
vi.mock('@/lib/bwb', () => ({ fetchBWBListings: vi.fn() }))

import { POST } from '../route'
import { supabase } from '@/lib/supabase'
import { fetchListingsByISBN } from '@/lib/abebooks'
import { fetchThriftBooksListings } from '@/lib/thriftbooks'
import { fetchBWBListings } from '@/lib/bwb'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeListing(isbn: string, price: number): Listing {
  return {
    listing_id: `${isbn}-${price}`,
    seller_id: 'seller-1',
    seller_name: 'Test Seller',
    price,
    shipping_base: 3.99,
    shipping_per_additional: 1.99,
    condition: 'Very Good',
    condition_normalized: 'good',
    signed: false,
    first_edition: false,
    dust_jacket: false,
    url: `https://example.test/${isbn}`,
    isbn,
  }
}

const ok = (listings: Listing[] = []): SourceFetch => ({ listings, error: null })
const failed = (error: string): SourceFetch => ({ listings: [], error })

/** from('price_cache').select().in() for reads, .upsert() for writes. */
function mockCache(rows: Array<{ isbn: string; listings: Listing[]; cached_at: string }> = []) {
  const inFn = vi.fn().mockResolvedValue({ data: rows, error: null })
  const select = vi.fn().mockReturnValue({ in: inFn })
  const upsert = vi.fn().mockResolvedValue({ error: null })
  vi.mocked(supabase.from).mockReturnValue({ select, upsert } as unknown as ReturnType<typeof supabase.from>)
  return { select, upsert, in: inFn }
}

function request(isbns: unknown) {
  return new NextRequest('http://localhost/api/prices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isbns }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fetchListingsByISBN).mockResolvedValue(ok())
  vi.mocked(fetchThriftBooksListings).mockResolvedValue(ok())
  vi.mocked(fetchBWBListings).mockResolvedValue(ok())
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/prices', () => {
  it('merges listings from every source', async () => {
    mockCache()
    vi.mocked(fetchListingsByISBN).mockResolvedValue(ok([makeListing('isbn-1', 5)]))
    vi.mocked(fetchThriftBooksListings).mockResolvedValue(ok([makeListing('isbn-1', 6)]))

    const res = await POST(request(['isbn-1']))
    const body: PriceResponse = await res.json()

    expect(res.status).toBe(200)
    expect(body.listings['isbn-1']).toHaveLength(2)
    expect(body.unchecked_isbns).toEqual([])
  })

  it('reports a failing source instead of passing its outage off as "no listings"', async () => {
    mockCache()
    vi.mocked(fetchListingsByISBN).mockResolvedValue(failed('HTTP 403'))
    vi.mocked(fetchThriftBooksListings).mockResolvedValue(ok([makeListing('isbn-1', 6)]))

    const res = await POST(request(['isbn-1', 'isbn-2']))
    const body: PriceResponse = await res.json()

    const abe = body.sources.find((s) => s.name === 'AbeBooks')!
    expect(abe.failed).toBe(2)
    expect(abe.error).toBe('HTTP 403')

    const tb = body.sources.find((s) => s.name === 'ThriftBooks')!
    expect(tb.failed).toBe(0)
    expect(tb.found).toBe(2)
  })

  it('keeps listings from the sources that did answer', async () => {
    mockCache()
    vi.mocked(fetchListingsByISBN).mockResolvedValue(failed('HTTP 403'))
    vi.mocked(fetchBWBListings).mockResolvedValue(ok([makeListing('isbn-1', 4)]))

    const body: PriceResponse = await (await POST(request(['isbn-1']))).json()
    expect(body.listings['isbn-1']).toHaveLength(1)
  })

  it('trims a multi-line driver error down to its first line', async () => {
    mockCache()
    vi.mocked(fetchBWBListings).mockResolvedValue(failed('browserType.launch: missing\n╔═══╗\n║ run install ║'))

    const body: PriceResponse = await (await POST(request(['isbn-1']))).json()
    const bwb = body.sources.find((s) => s.name === 'Better World Books')!
    expect(bwb.error).toBe('browserType.launch: missing')
  })

  it('fetches every ISBN in the batch', async () => {
    mockCache()
    const isbns = Array.from({ length: 9 }, (_, i) => `isbn-${i}`)
    vi.mocked(fetchListingsByISBN).mockImplementation(async (isbn) => ok([makeListing(isbn, 5)]))

    const body: PriceResponse = await (await POST(request(isbns))).json()

    expect(vi.mocked(fetchListingsByISBN)).toHaveBeenCalledTimes(9)
    expect(Object.keys(body.listings).sort()).toEqual([...isbns].sort())
  })

  it('serves fresh cache entries without hitting the scrapers', async () => {
    mockCache([{ isbn: 'isbn-1', listings: [makeListing('isbn-1', 3)], cached_at: new Date().toISOString() }])

    const body: PriceResponse = await (await POST(request(['isbn-1']))).json()

    expect(vi.mocked(fetchListingsByISBN)).not.toHaveBeenCalled()
    expect(body.listings['isbn-1']).toHaveLength(1)
  })

  it('re-fetches stale cache entries', async () => {
    const stale = new Date(Date.now() - 7 * 3600 * 1000).toISOString()
    mockCache([{ isbn: 'isbn-1', listings: [makeListing('isbn-1', 3)], cached_at: stale }])

    await POST(request(['isbn-1']))
    expect(vi.mocked(fetchListingsByISBN)).toHaveBeenCalledWith('isbn-1')
  })

  it('never caches an empty result, so a blocked scraper cannot poison the cache', async () => {
    const cache = mockCache()
    vi.mocked(fetchListingsByISBN).mockResolvedValue(failed('HTTP 403'))
    vi.mocked(fetchThriftBooksListings).mockResolvedValue(failed('HTTP 403'))
    vi.mocked(fetchBWBListings).mockResolvedValue(failed('blocked by Cloudflare'))

    await POST(request(['isbn-1']))
    expect(cache.upsert).not.toHaveBeenCalled()
  })

  it('deduplicates repeated ISBNs', async () => {
    mockCache()
    await POST(request(['isbn-1', 'isbn-1', 'isbn-2']))
    expect(vi.mocked(fetchListingsByISBN)).toHaveBeenCalledTimes(2)
  })

  it('survives a cache read that throws', async () => {
    const select = vi.fn().mockReturnValue({ in: vi.fn().mockRejectedValue(new Error('supabase down')) })
    const upsert = vi.fn().mockResolvedValue({ error: null })
    vi.mocked(supabase.from).mockReturnValue({ select, upsert } as unknown as ReturnType<typeof supabase.from>)
    vi.mocked(fetchListingsByISBN).mockResolvedValue(ok([makeListing('isbn-1', 5)]))

    const res = await POST(request(['isbn-1']))
    const body: PriceResponse = await res.json()
    expect(res.status).toBe(200)
    expect(body.listings['isbn-1']).toHaveLength(1)
  })

  it('returns an empty payload for an empty request', async () => {
    const res = await POST(request([]))
    const body: PriceResponse = await res.json()
    expect(res.status).toBe(200)
    expect(body.listings).toEqual({})
    expect(body.sources).toEqual([])
  })
})

// ── fast (probe) mode ─────────────────────────────────────────────────────────

describe('fast mode', () => {
  it('asks only the cheap sources and caches under a separate key', async () => {
    const cache = mockCache([])
    vi.mocked(fetchListingsByISBN).mockResolvedValue(ok([makeListing('111', 5)]))
    vi.mocked(fetchThriftBooksListings).mockResolvedValue(ok([makeListing('111', 6)]))
    const req = new NextRequest('http://localhost/api/prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isbns: ['111'], fast: true }),
    })
    const data = (await (await POST(req)).json()) as PriceResponse
    expect(fetchBWBListings).not.toHaveBeenCalled()
    expect(data.listings['111']).toHaveLength(2)
    expect(data.sources.map((s) => s.name)).toEqual(['AbeBooks', 'ThriftBooks'])
    expect(cache.upsert).toHaveBeenCalledWith([expect.objectContaining({ isbn: 'f:111' })])
  })

  it('serves a fast request from a fast or full cache row, but a full request never from a fast row', async () => {
    const now = new Date().toISOString()
    mockCache([{ isbn: 'f:222', listings: [makeListing('222', 4)], cached_at: now }])
    const fastReq = new NextRequest('http://localhost/api/prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isbns: ['222'], fast: true }),
    })
    const fastData = (await (await POST(fastReq)).json()) as PriceResponse
    expect(fastData.listings['222']).toHaveLength(1)
    expect(fetchListingsByISBN).not.toHaveBeenCalled()

    vi.clearAllMocks()
    vi.mocked(fetchListingsByISBN).mockResolvedValue(ok())
    vi.mocked(fetchThriftBooksListings).mockResolvedValue(ok())
    vi.mocked(fetchBWBListings).mockResolvedValue(ok())
    // A full request only asks for plain keys, so the mocked cache is empty for it.
    mockCache([])
    const fullData = (await (await POST(request(['222']))).json()) as PriceResponse
    expect(fetchListingsByISBN).toHaveBeenCalledWith('222')
    expect(fullData.listings['222']).toEqual([])
  })
})
