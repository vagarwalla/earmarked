import { describe, it, expect } from 'vitest'
import { runBatchOptimize, getSellerSource } from '../batch'
import { validateOptimizeRequest } from '../validate'
import type { CartItem, Condition, Listing } from '../../types'

function makeItem(id: string, overrides: Partial<CartItem> = {}): CartItem {
  return {
    id, cart_id: 'c', title: id, author: null, work_id: null,
    isbn_preferred: `isbn-${id}`, cover_url: null, format: 'any',
    conditions: ['new', 'fine', 'good', 'fair'] as Condition[],
    max_price: null, flexible: false, signed_only: null,
    first_edition_only: null, dust_jacket_only: null,
    quantity: 1, sort_order: 0, created_at: '', isbns_candidates: null,
    ...overrides,
  }
}

function makeListing(sellerId: string, isbn: string, price: number, perAdd = 1.99): Listing {
  return {
    listing_id: `${sellerId}-${isbn}`, seller_id: sellerId, seller_name: sellerId,
    price, shipping_base: 3.99, shipping_per_additional: perAdd,
    condition: 'Fine', condition_normalized: 'fine',
    signed: false, first_edition: false, dust_jacket: false,
    url: '', isbn,
  }
}

describe('runBatchOptimize', () => {
  it('best aliases combined and per-source views only use their own sellers', () => {
    const items = [makeItem('i1'), makeItem('i2')]
    const listingsByIsbn = new Map([
      ['isbn-i1', [
        makeListing('thriftbooks', 'isbn-i1', 4.0, 0),
        makeListing('abe-seller', 'isbn-i1', 3.0),
      ]],
      ['isbn-i2', [
        makeListing('thriftbooks', 'isbn-i2', 5.0, 0),
        makeListing('betterworldbooks', 'isbn-i2', 5.5, 0),
      ]],
    ])

    const r = runBatchOptimize(items, listingsByIsbn)

    expect(r.best).toBe(r.combined)
    for (const g of r.abe.groups) expect(getSellerSource(g.seller_id)).toBe('abe')
    for (const g of r.thriftbooks.groups) expect(g.seller_id).toBe('thriftbooks')
    for (const g of r.bwb.groups) expect(g.seller_id).toBe('betterworldbooks')
    // i1 has no BWB listing → unassigned in the bwb view but not combined
    expect(r.bwb.unassigned.map((i) => i.id)).toEqual(['i1'])
    expect(r.combined.unassigned).toHaveLength(0)
  })

  it('combined is never worse than a single source with equal coverage', () => {
    const items = Array.from({ length: 6 }, (_, i) => makeItem(`i${i}`))
    const listingsByIsbn = new Map<string, Listing[]>(
      items.map((item, bi) => [
        item.isbn_preferred!,
        [
          makeListing('thriftbooks', item.isbn_preferred!, 5 + bi * 0.1, 0),
          makeListing(`abe-${bi}`, item.isbn_preferred!, 4.5 + bi * 0.1),
        ],
      ])
    )
    const r = runBatchOptimize(items, listingsByIsbn)
    for (const src of ['abe', 'thriftbooks', 'bwb'] as const) {
      const single = r[src]
      if (single.unassigned.length === r.combined.unassigned.length) {
        expect(r.combined.grand_total).toBeLessThanOrEqual(single.grand_total + 1e-9)
      }
    }
  })
})

describe('validateOptimizeRequest', () => {
  const validItem = makeItem('i1')
  const validListing = makeListing('A', 'isbn-i1', 5)
  const valid = { items: [validItem], listingsByIsbn: { 'isbn-i1': [validListing] } }

  it('accepts a valid request and returns a Map', () => {
    const r = validateOptimizeRequest(valid)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.items).toHaveLength(1)
      expect(r.listingsByIsbn.get('isbn-i1')).toHaveLength(1)
    }
  })

  it.each([
    ['null body', null],
    ['non-object body', 'hello'],
    ['items not an array', { ...valid, items: {} }],
    ['item missing id', { ...valid, items: [{ ...validItem, id: undefined }] }],
    ['item quantity zero', { ...valid, items: [{ ...validItem, quantity: 0 }] }],
    ['item quantity NaN', { ...valid, items: [{ ...validItem, quantity: NaN }] }],
    ['item conditions not array', { ...valid, items: [{ ...validItem, conditions: 'fine' }] }],
    ['item max_price NaN', { ...valid, items: [{ ...validItem, max_price: NaN }] }],
    ['item signed_only string', { ...valid, items: [{ ...validItem, signed_only: 'yes' }] }],
    ['listings not object', { ...valid, listingsByIsbn: [] }],
    ['listing array not array', { ...valid, listingsByIsbn: { 'isbn-i1': {} } }],
    ['listing price NaN', { ...valid, listingsByIsbn: { 'isbn-i1': [{ ...validListing, price: NaN }] } }],
    ['listing price Infinity', { ...valid, listingsByIsbn: { 'isbn-i1': [{ ...validListing, price: Infinity }] } }],
    ['listing negative shipping', { ...valid, listingsByIsbn: { 'isbn-i1': [{ ...validListing, shipping_base: -1 }] } }],
    ['listing missing seller_id', { ...valid, listingsByIsbn: { 'isbn-i1': [{ ...validListing, seller_id: '' }] } }],
    ['listing signed not boolean', { ...valid, listingsByIsbn: { 'isbn-i1': [{ ...validListing, signed: 'true' }] } }],
  ])('rejects %s', (_label, body) => {
    const r = validateOptimizeRequest(body)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0)
  })

  it('rejects oversized item lists', () => {
    const items = Array.from({ length: 501 }, (_, i) => makeItem(`i${i}`))
    const r = validateOptimizeRequest({ items, listingsByIsbn: {} })
    expect(r.ok).toBe(false)
  })
})
