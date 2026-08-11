import { readFileSync } from 'node:fs'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchThriftBooksListings } from '../thriftbooks'

// ── helpers ───────────────────────────────────────────────────────────────────

function makeConditionEntry(overrides: Partial<{
  quality: string
  isbn: string
  ean: string
  idAmazon: number
  price: number
  exLib: boolean
  noDj: boolean
}>): string {
  const c = {
    quality: 'Good',
    isbn: '0062315005',
    ean: '9780062315007',
    idAmazon: 8060455,
    price: 7.29,
    exLib: false,
    noDj: false,
    ...overrides,
  }
  return JSON.stringify({
    bindingIdMedia: 74,
    idMedia: 74,
    idQuality: 3,
    qualityPriority: 3,
    quality: c.quality,
    hasShipCountryRestriction: false,
    isbn: c.isbn,
    ean: c.ean,
    upc: '642688057749',
    idIq: 5368789,
    idAmazon: c.idAmazon,
    price: c.price,
    listPrice: 17.99,
    isThriftDeal: false,
    idSKUPromo: null,
    sKUPromoDescription: null,
    exLib: c.exLib,
    noDj: c.noDj,
    noCd: false,
    quantity: 10,
    inCartQuantity: 0,
    imageUrl: 'https://i.thriftbooks.com/api/imagehandler/m/ABC.jpeg',
    loyaltyBonusPoints: 0,
    avgRank: 3.78,
    shippingSurcharge: 0.0,
    estDaysToShip: null,
    selectionScore: 2,
  })
}

function makeThriftBooksHTML(conditions: string[], isbn13 = '9780062315007'): string {
  const slug = 'the-alchemist_paulo-coelho'
  const workId = '246270'
  return `<!DOCTYPE html>
<html>
<head>
<link rel="canonical" href="https://www.thriftbooks.com/w/${slug}/${workId}/" />
</head>
<body>
<script>
var data = {"medias":[{"idMedia":74,"media":"Paperback","defaultEan":"${isbn13}","lowestPrice":6.89,"conditions":[${conditions.join(',')}]}]};
</script>
</body>
</html>`
}

// ── fetchThriftBooksListings ───────────────────────────────────────────────────

describe('fetchThriftBooksListings', () => {
  const ORIGINAL_FETCH = globalThis.fetch

  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('returns listings for a matching ISBN-13', async () => {
    const html = makeThriftBooksHTML([
      makeConditionEntry({ quality: 'Good', price: 7.29 }),
      makeConditionEntry({ quality: 'Very Good', price: 8.29 }),
    ])

    const mockResponse = {
      ok: true,
      status: 200,
      url: 'https://www.thriftbooks.com/w/the-alchemist_paulo-coelho/246270/',
      text: vi.fn().mockResolvedValue(html),
    }
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse)

    const { listings: results } = await fetchThriftBooksListings('9780062315007')

    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.seller_id).toBe('thriftbooks')
      expect(r.seller_name).toBe('ThriftBooks')
      expect(r.price).toBeGreaterThan(0)
      expect(r.shipping_base).toBe(3.99)
      expect(r.shipping_per_additional).toBe(0)
      expect(r.isbn).toBe('9780062315007')
      expect(r.url).toContain('thriftbooks.com')
    }
  })

  it('maps condition quality strings correctly', async () => {
    const html = makeThriftBooksHTML([
      makeConditionEntry({ quality: 'Like New', price: 9.99 }),
      makeConditionEntry({ quality: 'Acceptable', price: 5.49 }),
    ])
    const mockResponse = {
      ok: true,
      status: 200,
      url: 'https://www.thriftbooks.com/w/the-alchemist_paulo-coelho/246270/',
      text: vi.fn().mockResolvedValue(html),
    }
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse)

    const { listings: results } = await fetchThriftBooksListings('9780062315007')
    const likeNew = results.find(r => r.condition.includes('Like New'))
    const acceptable = results.find(r => r.condition.includes('Acceptable'))

    expect(likeNew?.condition_normalized).toBe('fine')
    expect(acceptable?.condition_normalized).toBe('fair')
  })

  it('excludes listings with price <= 0', async () => {
    const html = makeThriftBooksHTML([
      makeConditionEntry({ quality: 'Good', price: 0.0 }),
      makeConditionEntry({ quality: 'Very Good', price: 8.29 }),
    ])
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://www.thriftbooks.com/w/the-alchemist_paulo-coelho/246270/',
      text: vi.fn().mockResolvedValue(html),
    })

    const { listings: results } = await fetchThriftBooksListings('9780062315007')
    expect(results.every(r => r.price > 0)).toBe(true)
  })

  it('excludes listings for non-matching ISBNs', async () => {
    // Build HTML with two conditions — one matching, one with a different ISBN
    const matching = makeConditionEntry({ quality: 'Good', price: 7.29, ean: '9780062315007', isbn: '0062315005' })
    const other = makeConditionEntry({ quality: 'Good', price: 6.99, ean: '9780061122415', isbn: '0061122416', idAmazon: 9999 })
    const html = makeThriftBooksHTML([matching, other])

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://www.thriftbooks.com/w/the-alchemist_paulo-coelho/246270/',
      text: vi.fn().mockResolvedValue(html),
    })

    const { listings: results } = await fetchThriftBooksListings('9780062315007')
    expect(results.every(r => r.isbn === '9780062315007')).toBe(true)
    expect(results.some(r => r.listing_id.includes('9999'))).toBe(false)
  })

  it('includes ex-library note in condition text', async () => {
    const html = makeThriftBooksHTML([
      makeConditionEntry({ quality: 'Very Good', price: 8.29, exLib: true }),
    ])
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://www.thriftbooks.com/w/the-alchemist_paulo-coelho/246270/',
      text: vi.fn().mockResolvedValue(html),
    })

    const { listings: results } = await fetchThriftBooksListings('9780062315007')
    expect(results[0]?.condition).toContain('Ex-Library')
  })

  it('reports an error on HTTP error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, url: '' })
    const { listings: results, error } = await fetchThriftBooksListings('9780062315007')
    expect(results).toEqual([])
    expect(error).toBe('HTTP 503')
  })

  it('reports an error on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network failure'))
    const { listings: results, error } = await fetchThriftBooksListings('9780062315007')
    expect(results).toEqual([])
    expect(error).toBe('Network failure')
  })

  it('builds correct listing URL using slug and workId', async () => {
    const html = makeThriftBooksHTML([makeConditionEntry({ price: 7.29 })])
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://www.thriftbooks.com/w/the-alchemist_paulo-coelho/246270/',
      text: vi.fn().mockResolvedValue(html),
    })

    const { listings: results } = await fetchThriftBooksListings('9780062315007')
    expect(results[0]?.url).toMatch(/\/w\/the-alchemist_paulo-coelho\/246270\/item\//)
    expect(results[0]?.url).toContain('selectedISBN=0062315005')
    expect(results[0]?.url).toContain('#edition=8060455')
  })
})

// ── real captured page ────────────────────────────────────────────────────────
// The hand-built fixtures above embed the conditions payload once. A live
// ThriftBooks page embeds it twice, which is a difference the parser could not
// see until this fixture existed.

describe('fetchThriftBooksListings — against a live-captured page', () => {
  const html = readFileSync(new URL('./fixtures/thriftbooks-work.html', import.meta.url), 'utf8')

  async function parseFixture(isbn = '9780062315007') {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://www.thriftbooks.com/w/o-alquimista-by-paulo-coelho/246270/item/',
      text: vi.fn().mockResolvedValue(html),
    })
    return fetchThriftBooksListings(isbn)
  }

  it('returns one listing per distinct copy, not one per embedded payload', async () => {
    const { listings, error } = await parseFixture()
    expect(error).toBeNull()
    expect(listings.map((l) => l.condition).sort()).toEqual(['Good', 'New', 'Very Good'])
  })

  it('gives each distinct copy a stable id that does not depend on scan order', async () => {
    const { listings } = await parseFixture()
    const ids = listings.map((l) => l.listing_id)
    expect(new Set(ids).size).toBe(ids.length)
    const { listings: again } = await parseFixture()
    expect(again.map((l) => l.listing_id)).toEqual(ids)
  })

  it('does not claim a dust jacket ThriftBooks never reported', async () => {
    // `noDj` is only set when a copy is explicitly flagged as lacking one.
    // Its absence is silence, not confirmation — and these are paperbacks.
    const { listings } = await parseFixture()
    expect(listings.every((l) => l.dust_jacket === false)).toBe(true)
  })

  it('prices the copies as the page lists them', async () => {
    const { listings } = await parseFixture()
    const byCondition = Object.fromEntries(listings.map((l) => [l.condition, l.price]))
    expect(byCondition).toEqual({ 'Very Good': 9.29, Good: 8.19, New: 14.79 })
  })
})
