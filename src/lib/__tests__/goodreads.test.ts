import { describe, it, expect, vi, beforeEach } from 'vitest'
import { formatRatingsCount, fetchGoodreadsData } from '../goodreads'

beforeEach(() => {
  vi.unstubAllGlobals()
})

// ── formatRatingsCount ────────────────────────────────────────────────────────

describe('formatRatingsCount', () => {
  it('formats millions', () => {
    expect(formatRatingsCount(1_234_567)).toBe('1.2M')
    expect(formatRatingsCount(2_340_000)).toBe('2.3M')
  })

  it('formats thousands', () => {
    expect(formatRatingsCount(12_345)).toBe('12.3k')
    expect(formatRatingsCount(1_000)).toBe('1.0k')
  })

  it('formats small counts as-is', () => {
    expect(formatRatingsCount(999)).toBe('999')
    expect(formatRatingsCount(0)).toBe('0')
  })
})

// ── fetchGoodreadsData ────────────────────────────────────────────────────────

describe('fetchGoodreadsData', () => {
  it('returns null when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
    const result = await fetchGoodreadsData('Some Book', 'Some Author')
    expect(result).toBeNull()
  })

  it('returns null when response is not OK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    const result = await fetchGoodreadsData('Some Book', 'Some Author')
    expect(result).toBeNull()
  })

  it('returns null when no rating found in HTML', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '<html><body>No ratings here</body></html>',
    }))
    const result = await fetchGoodreadsData('Some Book', 'Some Author')
    expect(result).toBeNull()
  })

  it('parses rating, count, and URL from Goodreads HTML', async () => {
    const html = `
      <html><body>
        <span class="minirating">4.12 avg rating — 1,234,567 ratings</span>
        <a href="/book/show/12345.Some_Book">Some Book</a>
      </body></html>
    `
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => html }))
    const result = await fetchGoodreadsData('Some Book', 'Some Author')
    expect(result).not.toBeNull()
    expect(result!.rating).toBe(4.12)
    expect(result!.ratings_count).toBe(1_234_567)
    expect(result!.url).toBe('https://www.goodreads.com/book/show/12345.Some_Book')
  })

  it('handles em-dash and en-dash separators in minirating', async () => {
    const html = `<span>3.98 avg rating – 56,789 ratings</span>
      <a href="/book/show/99.Title">Title</a>`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => html }))
    const result = await fetchGoodreadsData('Title', 'Author')
    expect(result!.rating).toBe(3.98)
    expect(result!.ratings_count).toBe(56_789)
  })

  it('falls back to search URL when no book link found', async () => {
    const html = `<span>4.00 avg rating — 100 ratings</span>`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => html }))
    const result = await fetchGoodreadsData('Obscure Book', '')
    expect(result!.url).toContain('goodreads.com')
  })
})
