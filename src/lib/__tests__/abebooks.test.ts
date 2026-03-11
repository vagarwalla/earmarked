import { describe, it, expect, vi, beforeEach } from 'vitest'
import { conditionMeets, normalizeCondition, fetchListingsByISBN } from '../abebooks'

// ── conditionMeets ────────────────────────────────────────────────────────────

describe('conditionMeets', () => {
  it('new satisfies every condition level', () => {
    expect(conditionMeets('new', 'new')).toBe(true)
    expect(conditionMeets('new', 'like_new')).toBe(true)
    expect(conditionMeets('new', 'very_good')).toBe(true)
    expect(conditionMeets('new', 'good')).toBe(true)
  })

  it('like_new satisfies like_new and below, not new', () => {
    expect(conditionMeets('like_new', 'new')).toBe(false)
    expect(conditionMeets('like_new', 'like_new')).toBe(true)
    expect(conditionMeets('like_new', 'very_good')).toBe(true)
    expect(conditionMeets('like_new', 'good')).toBe(true)
  })

  it('very_good satisfies very_good and good only', () => {
    expect(conditionMeets('very_good', 'new')).toBe(false)
    expect(conditionMeets('very_good', 'like_new')).toBe(false)
    expect(conditionMeets('very_good', 'very_good')).toBe(true)
    expect(conditionMeets('very_good', 'good')).toBe(true)
  })

  it('good satisfies only good', () => {
    expect(conditionMeets('good', 'new')).toBe(false)
    expect(conditionMeets('good', 'like_new')).toBe(false)
    expect(conditionMeets('good', 'very_good')).toBe(false)
    expect(conditionMeets('good', 'good')).toBe(true)
  })
})

// ── normalizeCondition ────────────────────────────────────────────────────────

describe('normalizeCondition', () => {
  it('maps "New" → new', () => {
    expect(normalizeCondition('New')).toBe('new')
    expect(normalizeCondition('Brand New')).toBe('new')
    expect(normalizeCondition('NEW')).toBe('new')
  })

  it('maps "Like New" / "As New" / "Fine" → like_new', () => {
    expect(normalizeCondition('Like New')).toBe('like_new')
    expect(normalizeCondition('As New')).toBe('like_new')
    expect(normalizeCondition('Fine')).toBe('like_new')
    expect(normalizeCondition('LIKE NEW')).toBe('like_new')
  })

  it('maps "Very Good" → very_good', () => {
    expect(normalizeCondition('Very Good')).toBe('very_good')
    expect(normalizeCondition('Very Good+')).toBe('very_good')
    expect(normalizeCondition('VERY GOOD')).toBe('very_good')
  })

  it('maps "Good" → good', () => {
    expect(normalizeCondition('Good')).toBe('good')
    expect(normalizeCondition('Good+')).toBe('good')
    expect(normalizeCondition('GOOD')).toBe('good')
  })

  it('defaults unknown strings to good', () => {
    expect(normalizeCondition('Fair')).toBe('good')
    expect(normalizeCondition('Poor')).toBe('good')
    expect(normalizeCondition('Acceptable')).toBe('good')
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
  return `<li data-test-id="listing-item">
    <button data-listingid="${listingId}" data-csa-c-cost="${price}" data-csa-c-shipping-cost="${shipping}"></button>
    <span data-test-id="listing-book-condition">${condition}</span>
    <span class="seller-name">${sellerName}</span>
    <a ${hrefAttr}></a>
    ${sellerId ? `<a ${sfAttr}></a>` : ''}
  </li>`
}

describe('fetchListingsByISBN — HTML parsing', () => {
  it('parses listings from HTML data attributes', async () => {
    const html = `<ul>${makeHtmlListing({ listingId: '11111111', sellerId: '99001', sellerName: 'Great Books', price: '8.99', shipping: '3.99', condition: 'Used - Like New' })}</ul>`
    mockFetch(html)

    const listings = await fetchListingsByISBN(ISBN)
    expect(listings).toHaveLength(1)

    const l = listings[0]
    expect(l.seller_name).toBe('Great Books')
    expect(l.price).toBe(8.99)
    expect(l.condition_normalized).toBe('like_new')
    expect(l.isbn).toBe(ISBN)
    expect(l.listing_id).toBe('11111111')
  })

  it('sets listing url from href attribute', async () => {
    const html = makeHtmlListing({ listingId: '123456', sellerName: 'S1', price: '9.00', condition: 'New' })
    mockFetch(html)
    const [listing] = await fetchListingsByISBN(ISBN)
    expect(listing.url).toContain('123456')
  })

  it('ignores listings with no price', async () => {
    const withPrice = makeHtmlListing({ listingId: '11111', sellerName: 'S1', price: '7.00', condition: 'Good' })
    // Listing with no data-csa-c-cost attribute
    const noCost = `<li data-test-id="listing-item" data-listingid="22222"><span class="seller-name">S2</span></li>`
    mockFetch(`<ul>${noCost}${withPrice}</ul>`)
    const listings = await fetchListingsByISBN(ISBN)
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
    const [listing] = await fetchListingsByISBN(ISBN)
    expect(listing.condition).toBe('Very good')
    expect(listing.condition_normalized).toBe('very_good')
  })

  it('falls back to listing-book-condition when optional condition is absent', async () => {
    const html = makeHtmlListing({ listingId: '88888', sellerName: 'S1', price: '7.00', condition: 'Used - Like New' })
    mockFetch(html)
    const [listing] = await fetchListingsByISBN(ISBN)
    expect(listing.condition).toBe('Used - Like New')
    expect(listing.condition_normalized).toBe('like_new')
  })

  it('parses multiple listings', async () => {
    const html = `<ul>
      ${makeHtmlListing({ listingId: 'L1', sellerName: 'Seller One', price: '5.00', condition: 'Good' })}
      ${makeHtmlListing({ listingId: 'L2', sellerName: 'Seller Two', price: '9.99', condition: 'Like New' })}
    </ul>`
    mockFetch(html)
    const listings = await fetchListingsByISBN(ISBN)
    expect(listings).toHaveLength(2)
  })
})

describe('fetchListingsByISBN — error handling', () => {
  it('returns a placeholder when the HTTP response is not ok', async () => {
    mockFetch('Service unavailable', false)
    const listings = await fetchListingsByISBN(ISBN)
    expect(listings).toHaveLength(0)
  })

  it('returns a placeholder when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))
    const listings = await fetchListingsByISBN(ISBN)
    expect(listings).toHaveLength(0)
  })

  it('returns empty array when HTML has no recognisable listings', async () => {
    mockFetch('<html><body>No results found</body></html>')
    const listings = await fetchListingsByISBN(ISBN)
    expect(listings).toHaveLength(0)
  })
})
