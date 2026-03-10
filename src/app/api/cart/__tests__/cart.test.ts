import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// Mock supabase before importing the route handlers
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))

import { GET, POST } from '../route'
import { supabase } from '@/lib/supabase'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCartRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cart-uuid-1',
    slug: 'abc12345',
    name: 'My Reading List',
    created_at: '2024-01-01T00:00:00Z',
    default_conditions: ['new', 'like_new'],
    default_format: 'any',
    default_max_price: null,
    ...overrides,
  }
}

/** Build the chained supabase mock: from().insert().select().single() */
function mockInsertChain(result: { data?: unknown; error?: unknown }) {
  const single = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
  const select = vi.fn().mockReturnValue({ single })
  const insert = vi.fn().mockReturnValue({ select })
  vi.mocked(supabase.from).mockReturnValue({ insert } as ReturnType<typeof supabase.from>)
  return { insert, select, single }
}

/** Build the chained supabase mock: from().select().order() */
function mockSelectChain(result: { data?: unknown; error?: unknown }) {
  const order = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
  const select = vi.fn().mockReturnValue({ order })
  vi.mocked(supabase.from).mockReturnValue({ select } as ReturnType<typeof supabase.from>)
  return { select, order }
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/cart', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── POST /api/cart ─────────────────────────────────────────────────────────────

describe('POST /api/cart — create cart', () => {
  it('creates a cart and returns 201 with the new cart data', async () => {
    const cart = makeCartRow({ name: 'Summer Reading' })
    mockInsertChain({ data: cart })

    const res = await POST(postRequest({ name: 'Summer Reading' }))

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.name).toBe('Summer Reading')
    expect(body.slug).toBe('abc12345')
    expect(body.id).toBe('cart-uuid-1')
  })

  it('inserts a generated slug and the trimmed name', async () => {
    const { insert } = mockInsertChain({ data: makeCartRow() })

    await POST(postRequest({ name: '  Wishlist  ' }))

    const insertArg = insert.mock.calls[0][0] as Record<string, string>
    expect(insertArg.name).toBe('Wishlist')        // whitespace trimmed
    expect(typeof insertArg.slug).toBe('string')   // auto-generated
    expect(insertArg.slug.length).toBeGreaterThan(0)
  })

  it('returns 400 when name is missing', async () => {
    const res = await POST(postRequest({}))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/name/i)
  })

  it('returns 400 when name is an empty string', async () => {
    const res = await POST(postRequest({ name: '   ' }))
    expect(res.status).toBe(400)
  })

  it('returns 500 when Supabase returns an error', async () => {
    mockInsertChain({ error: { message: 'duplicate key value' } })

    const res = await POST(postRequest({ name: 'Duplicate' }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('duplicate key value')
  })

  it('generates a unique slug each time', async () => {
    const { insert: insert1 } = mockInsertChain({ data: makeCartRow() })
    await POST(postRequest({ name: 'Cart A' }))
    const slug1 = (insert1.mock.calls[0][0] as Record<string, string>).slug

    mockInsertChain({ data: makeCartRow() })
    const { insert: insert2 } = mockInsertChain({ data: makeCartRow() })
    await POST(postRequest({ name: 'Cart B' }))
    const slug2 = (insert2.mock.calls[0][0] as Record<string, string>).slug

    expect(slug1).not.toBe(slug2)
  })
})

// ── GET /api/cart ──────────────────────────────────────────────────────────────

describe('GET /api/cart — list carts', () => {
  it('returns an empty array when no carts exist', async () => {
    // First from() call: list carts — returns []
    const orderCarts = vi.fn().mockResolvedValue({ data: [], error: null })
    const selectCarts = vi.fn().mockReturnValue({ order: orderCarts })
    vi.mocked(supabase.from).mockReturnValue({ select: selectCarts } as ReturnType<typeof supabase.from>)

    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('returns carts with item_count attached', async () => {
    const carts = [makeCartRow({ id: 'c1' }), makeCartRow({ id: 'c2', slug: 'xyz99' })]
    const itemRows = [{ cart_id: 'c1' }, { cart_id: 'c1' }, { cart_id: 'c2' }]

    // supabase.from is called twice: once for 'carts', once for 'cart_items'
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === 'carts') {
        const order = vi.fn().mockResolvedValue({ data: carts, error: null })
        const select = vi.fn().mockReturnValue({ order })
        return { select } as ReturnType<typeof supabase.from>
      }
      // cart_items
      const inFn = vi.fn().mockResolvedValue({ data: itemRows, error: null })
      const select = vi.fn().mockReturnValue({ in: inFn })
      return { select } as ReturnType<typeof supabase.from>
    })

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(2)
    expect(body.find((c: { id: string }) => c.id === 'c1').item_count).toBe(2)
    expect(body.find((c: { id: string }) => c.id === 'c2').item_count).toBe(1)
  })

  it('returns 500 when Supabase returns an error', async () => {
    const order = vi.fn().mockResolvedValue({ data: null, error: { message: 'connection refused' } })
    const select = vi.fn().mockReturnValue({ order })
    vi.mocked(supabase.from).mockReturnValue({ select } as ReturnType<typeof supabase.from>)

    const res = await GET()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('connection refused')
  })
})
