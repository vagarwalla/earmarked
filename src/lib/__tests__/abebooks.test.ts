import { readFileSync } from 'node:fs'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { conditionMeets, normalizeCondition, fetchListingsByISBN, ABE_DEFAULT_SHIPPING } from '../abebooks'

// ── conditionMeets ────────────────────────────────────────────────────────────

describe('conditionMeets', () => {
  it('new satisfies every condition level', () => {
    expect(conditionMeets('new', 'new')).toBe(true)
    expect(conditionMeets('new', 'fine')).toBe(true)
    expect(conditionMeets('new', 'good')).toBe(true)
    expect(conditionMeets('new', 'fair')).toBe(true)
  })

  it('fine satisfies fine and below, not new', () => {
    expect(conditionMeets('fine', 'new')).toBe(false)
    expect(conditionMeets('fine', 'fine')).toBe(true)
    expect(conditionMeets('fine', 'good')).toBe(true)
    expect(conditionMeets('fine', 'fair')).toBe(true)
  })

  it('good satisfies good and fair, not above', () => {
    expect(conditionMeets('good', 'new')).toBe(false)
    expect(conditionMeets('good', 'fine')).toBe(false)
    expect(conditionMeets('good', 'good')).toBe(true)
    expect(conditionMeets('good', 'fair')).toBe(true)
  })

  it('fair satisfies only fair', () => {
    expect(conditionMeets('fair', 'new')).toBe(false)
    expect(conditionMeets('fair', 'fine')).toBe(false)
    expect(conditionMeets('fair', 'good')).toBe(false)
    expect(conditionMeets('fair', 'fair')).toBe(true)
  })
})

// ── normalizeCondition ────────────────────────────────────────────────────────

describe('normalizeCondition', () => {
  it('maps "New" → new', () => {
    expect(normalizeCondition('New')).toBe('new')
    expect(normalizeCondition('Brand New')).toBe('new')
    expect(normalizeCondition('NEW')).toBe('new')
  })

  it('maps "Like New" / "As New" / "Fine" / "Near Fine" → fine', () => {
    expect(normalizeCondition('Like New')).toBe('fine')
    expect(normalizeCondition('As New')).toBe('fine')
    expect(normalizeCondition('Fine')).toBe('fine')
    expect(normalizeCondition('Near Fine')).toBe('fine')
    expect(normalizeCondition('LIKE NEW')).toBe('fine')
  })

  it('maps "Very Good" and "Good" → good', () => {
    expect(normalizeCondition('Very Good')).toBe('good')
    expect(normalizeCondition('Very Good+')).toBe('good')
    expect(normalizeCondition('Good')).toBe('good')
    expect(normalizeCondition('Good+')).toBe('good')
    expect(normalizeCondition('VERY GOOD')).toBe('good')
  })

  it('maps "Acceptable" / "Fair" / "Poor" → fair', () => {
    expect(normalizeCondition('Acceptable')).toBe('fair')
    expect(normalizeCondition('Fair')).toBe('fair')
    expect(normalizeCondition('Poor')).toBe('fair')
  })

  it('defaults unknown strings to good', () => {
    expect(normalizeCondition('')).toBe('good')
  })
})

// ── fetchListingsByISBN ───────────────────────────────────────────────────────

const ISBN = '9780385533225'

function mockFetch(html: string, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 503,
      text: () => Promise.resolve(html),
    })
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

// Helper: build an AbeBooks HTML listing block matching the current data-attribute format
function makeHtmlListing(opts: {
  listingId: string
  sellerId?: string
  sellerName: string
  price: string
  shipping?: string
  condition: string
  href?: string
}) {
  const { listingId, sellerId, sellerName, price, shipping = '3.99', condition, href } = opts
  const sfAttr = sellerId ? `href="/${sellerId}/${sellerId}/sf"` : ''
  const hrefAttr = href ?? `href="/book/id/${listingId}/bd"`
  // data-listingid must be inside the <li> content (not on the tag) for the regex to find it
  return `<li data-test-id="listing-item-${listingId}">
    <button data-listingid="${listingId}" data-csa-c-cost="${price}" data-csa-c-shipping-cost="${shipping}"></button>
    <span data-test-id="listing-book-condition">${condition}</span>
    <a data-test-id="listing-seller-link" href="/seller/sf">${sellerName}</a>
    <a ${hrefAttr}></a>
    ${sellerId ? `<a ${sfAttr}></a>` : ''}
  </li>`
}

describe('fetchListingsByISBN — HTML parsing', () => {
  it('parses listings from HTML data attributes', async () => {
    const html = `<ul>${makeHtmlListing({ listingId: '11111111', sellerId: '99001', sellerName: 'Great Books', price: '8.99', shipping: '3.99', condition: 'Used - Like New' })}</ul>`
    mockFetch(html)

    const { listings } = await fetchListingsByISBN(ISBN)
    expect(listings).toHaveLength(1)

    const l = listings[0]
    expect(l.seller_name).toBe('Great Books')
    expect(l.price).toBe(8.99)
    expect(l.condition_normalized).toBe('fine')
    expect(l.isbn).toBe(ISBN)
    expect(l.listing_id).toBe('11111111')
  })

  it('sets listing url from href attribute', async () => {
    const html = makeHtmlListing({ listingId: '123456', sellerName: 'S1', price: '9.00', condition: 'New' })
    mockFetch(html)
    const { listings: [listing] } = await fetchListingsByISBN(ISBN)
    expect(listing.url).toContain('123456')
  })

  it('ignores listings with no price', async () => {
    const withPrice = makeHtmlListing({ listingId: '11111', sellerName: 'S1', price: '7.00', condition: 'Good' })
    // Listing with no data-csa-c-cost attribute
    const noCost = `<li data-test-id="listing-item" data-listingid="22222"><span class="seller-name">S2</span></li>`
    mockFetch(`<ul>${noCost}${withPrice}</ul>`)
    const { listings } = await fetchListingsByISBN(ISBN)
    expect(listings).toHaveLength(1)
    expect(listings[0].listing_id).toBe('11111')
  })

  it('uses listing-optional-condition for quality when present', async () => {
    // AbeBooks puts the actual quality in listing-optional-condition ("Condition: Very good")
    // while listing-book-condition only shows the format ("Used - Hardcover").
    const html = `<li data-test-id="listing-item">
      <button data-listingid="99999" data-csa-c-cost="5.00" data-csa-c-shipping-cost="0.00"></button>
      <span data-test-id="listing-book-condition">Used - Hardcover</span>
      <span class="opt-subcondition" data-test-id="listing-optional-condition">Condition: Very good</span>
      <span class="seller-name">Quality Books</span>
      <a href="/book/id/99999/bd"></a>
    </li>`
    mockFetch(html)
    const { listings: [listing] } = await fetchListingsByISBN(ISBN)
    expect(listing.condition).toBe('Very good')
    expect(listing.condition_normalized).toBe('good')
  })

  it('falls back to listing-book-condition when optional condition is absent', async () => {
    const html = makeHtmlListing({ listingId: '88888', sellerName: 'S1', price: '7.00', condition: 'Used - Like New' })
    mockFetch(html)
    const { listings: [listing] } = await fetchListingsByISBN(ISBN)
    expect(listing.condition).toBe('Used - Like New')
    expect(listing.condition_normalized).toBe('fine')
  })

  it('treats an explicit 0.00 shipping cost as genuinely free', async () => {
    const html = makeHtmlListing({ listingId: 'FREE1', sellerName: 'Free Ship Co', price: '6.00', shipping: '0.00', condition: 'Good' })
    mockFetch(html)
    const { listings: [listing] } = await fetchListingsByISBN(ISBN)
    expect(listing.shipping_base).toBe(0)
  })

  it('falls back to the standard rate when the shipping attribute is missing', async () => {
    // A failed parse must not read as free shipping — that silently
    // under-reports every total the optimizer builds on top of it.
    const html = `<li data-test-id="listing-item">
      <button data-listingid="77777" data-csa-c-cost="6.00"></button>
      <span data-test-id="listing-book-condition">Used - Good</span>
      <span class="seller-name">No Shipping Attr</span>
    </li>`
    mockFetch(html)
    const { listings: [listing] } = await fetchListingsByISBN(ISBN)
    expect(listing.shipping_base).toBe(ABE_DEFAULT_SHIPPING)
    expect(listing.shipping_base).toBeGreaterThan(0)
  })

  it('parses multiple listings', async () => {
    const html = `<ul>
      ${makeHtmlListing({ listingId: 'L1', sellerName: 'Seller One', price: '5.00', condition: 'Good' })}
      ${makeHtmlListing({ listingId: 'L2', sellerName: 'Seller Two', price: '9.99', condition: 'Like New' })}
    </ul>`
    mockFetch(html)
    const { listings } = await fetchListingsByISBN(ISBN)
    expect(listings).toHaveLength(2)
  })
})

describe('fetchListingsByISBN — error handling', () => {
  it('reports an error when the HTTP response is not ok', async () => {
    mockFetch('Service unavailable', false)
    const { listings, error } = await fetchListingsByISBN(ISBN)
    expect(listings).toHaveLength(0)
    expect(error).toBeTruthy()
  })

  it('reports an error when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))
    const { listings, error } = await fetchListingsByISBN(ISBN)
    expect(listings).toHaveLength(0)
    expect(error).toBe('Network error')
  })

  it('reports no error when the page simply has no listings', async () => {
    mockFetch('<html><body>No results found</body></html>')
    const { listings, error } = await fetchListingsByISBN(ISBN)
    expect(listings).toHaveLength(0)
    expect(error).toBeNull()
  })
})

// ── real captured page ────────────────────────────────────────────────────────
// Every fixture above is hand-written, so it re-encodes whatever markup the
// parser already expects and keeps passing after AbeBooks changes its HTML.
// This one is captured from a live search-results page.

describe('fetchListingsByISBN — against a live-captured search page', () => {
  const html = readFileSync(new URL('./fixtures/abebooks-srp.html', import.meta.url), 'utf8')
  const FIXTURE_ISBN = '9780062315007'

  async function parseFixture() {
    mockFetch(html)
    return fetchListingsByISBN(FIXTURE_ISBN)
  }

  it('finds every listing on the page', async () => {
    const { listings, error } = await parseFixture()
    expect(error).toBeNull()
    expect(listings).toHaveLength(4)
  })

  it('reads price, shipping and condition off each listing', async () => {
    const { listings } = await parseFixture()
    expect(listings.map((l) => l.price)).toEqual([5.54, 6.03, 6.39, 595])
    expect(listings.map((l) => l.shipping_base)).toEqual([0, 0, 0, 6.95])
    expect(listings.map((l) => l.condition_normalized)).toEqual(['fair', 'fair', 'good', 'new'])
  })

  it('reads the condition as text, not as the markup around it', async () => {
    // The quality sits inside nested spans. Keeping the raw fragment put markup
    // on screen and broke normalizeCondition, which saw the "as" in `class=`.
    const { listings } = await parseFixture()
    expect(listings.map((l) => l.condition)).toEqual([
      'Used - Fair',
      'Used - Fair',
      'Used - Very good',
      'New',
    ])
    expect(listings.every((l) => !/[<>]/.test(l.condition))).toBe(true)
  })

  it('attributes each listing to the bookseller offering it', async () => {
    const { listings } = await parseFixture()
    expect(listings[0].seller_name).toBe('Dream Books Co.')
    expect(listings[0].seller_id).toBe('54248992')
    // Distinct sellers must stay distinct, or the optimizer merges their orders.
    expect(new Set(listings.map((l) => l.seller_id)).size).toBe(4)
  })

  it('flags the signed first edition and nothing else', async () => {
    const { listings } = await parseFixture()
    expect(listings.filter((l) => l.signed).map((l) => l.price)).toEqual([595])
    expect(listings.filter((l) => l.first_edition).map((l) => l.price)).toEqual([595])
  })

  it('links each listing to its own detail page', async () => {
    const { listings } = await parseFixture()
    expect(listings[0].url).toMatch(/^https:\/\/www\.abebooks\.com\/.+\/\d+\/bd$/)
    expect(new Set(listings.map((l) => l.url)).size).toBe(4)
  })
})
