import { describe, it, expect, vi } from 'vitest'
import type { Listing } from '../types'

// Mock playwright-core and @sparticuz/chromium so unit tests don't launch a browser
const mockEvaluate = vi.fn()
const mockGoto = vi.fn()
const mockWaitForTimeout = vi.fn()
const mockTitle = vi.fn()
const mockUrl = vi.fn()
const mockClose = vi.fn()
const mockNewPage = vi.fn().mockResolvedValue({
  goto: mockGoto,
  waitForTimeout: mockWaitForTimeout,
  title: mockTitle,
  url: mockUrl,
  evaluate: mockEvaluate,
})
const mockAddInitScript = vi.fn()
const mockContextClose = vi.fn().mockResolvedValue(undefined)
const mockNewContext = vi.fn().mockResolvedValue({
  newPage: mockNewPage,
  addInitScript: mockAddInitScript,
  close: mockContextClose,
})
const mockBrowserIsConnected = vi.fn().mockReturnValue(true)

vi.mock('playwright-core', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue({
      newContext: mockNewContext,
      isConnected: mockBrowserIsConnected,
    }),
  },
}))

vi.mock('@sparticuz/chromium', () => ({
  default: {
    args: [],
    executablePath: vi.fn().mockResolvedValue('/fake/chromium'),
    setHeadlessMode: 'shell',
  },
}))

// Import after mocks are set up
const { fetchBWBListings } = await import('../bwb')

describe('fetchBWBListings', () => {
  it('returns listings when detailObject has used and new items', async () => {
    mockTitle.mockResolvedValue('The Alchemist used book')
    mockUrl.mockResolvedValue('https://www.betterworldbooks.com/product/detail/the-alchemist-9780062315007')
    mockEvaluate.mockResolvedValue({
      Isbn: '9780062315007',
      Title: 'The Alchemist',
      AddToCartOptions: {
        UsedItem: {
          InventoryId: 165283440,
          UnitPrice: 6.40,
          Quantity: 1,
          ConditionString: 'Used Good',
          Notes: 'Pages intact.',
          FlSigned: false,
          FlDustJacket: false,
          Exists: true,
          ConditionVariant: { ConditionVariant: 'Used - Good', ExLibrary: false },
        },
        NewItem: {
          InventoryId: 104323881,
          UnitPrice: 15.33,
          Quantity: 358,
          ConditionString: 'New',
          Notes: 'Brand new.',
          FlSigned: false,
          FlDustJacket: false,
          Exists: true,
          ConditionVariant: { ConditionVariant: 'New', ExLibrary: false },
        },
      },
    })

    const { listings: results } = await fetchBWBListings('9780062315007')

    expect(results).toHaveLength(2)

    const used = results.find((l: Listing) => l.condition === 'Used Good')!
    expect(used).toBeDefined()
    expect(used.seller_id).toBe('betterworldbooks')
    expect(used.seller_name).toBe('Better World Books')
    expect(used.price).toBe(6.40)
    expect(used.shipping_base).toBe(3.99)
    expect(used.shipping_per_additional).toBe(0)
    expect(used.condition_normalized).toBe('good')
    expect(used.listing_id).toBe('bwb_165283440')

    const newItem = results.find((l: Listing) => l.condition === 'New')!
    expect(newItem).toBeDefined()
    expect(newItem.price).toBe(15.33)
    expect(newItem.condition_normalized).toBe('new')
  })

  it('skips items that do not exist', async () => {
    mockTitle.mockResolvedValue('Some Book')
    mockUrl.mockResolvedValue('https://www.betterworldbooks.com/product/detail/some-book-1234567890')
    mockEvaluate.mockResolvedValue({
      Isbn: '1234567890',
      Title: 'Some Book',
      AddToCartOptions: {
        UsedItem: null,
        NewItem: {
          InventoryId: 999,
          UnitPrice: 10.00,
          Quantity: 5,
          ConditionString: 'New',
          Notes: '',
          FlSigned: false,
          FlDustJacket: false,
          Exists: true,
          ConditionVariant: null,
        },
      },
    })

    const { listings: results } = await fetchBWBListings('1234567890')
    expect(results).toHaveLength(1)
    expect(results[0].condition).toBe('New')
  })

  it('reports an error when blocked by Cloudflare', async () => {
    mockTitle.mockResolvedValue('Just a moment...')
    const { listings: results, error } = await fetchBWBListings('9780062315007')
    expect(results).toHaveLength(0)
    expect(error).toBe('blocked by Cloudflare')
  })

  it('treats a missing detailObject as "not stocked", not a failure', async () => {
    mockTitle.mockResolvedValue('Some Valid Title')
    mockEvaluate.mockResolvedValue(null)
    const { listings: results, error } = await fetchBWBListings('9780062315007')
    expect(results).toHaveLength(0)
    expect(error).toBeNull()
  })

  it('includes Ex-Library in condition text', async () => {
    mockTitle.mockResolvedValue('A Book')
    mockUrl.mockResolvedValue('https://www.betterworldbooks.com/product/detail/a-book-1111111111')
    mockEvaluate.mockResolvedValue({
      Isbn: '1111111111',
      Title: 'A Book',
      AddToCartOptions: {
        UsedItem: {
          InventoryId: 500,
          UnitPrice: 4.00,
          Quantity: 1,
          ConditionString: 'Used Good',
          Notes: '',
          FlSigned: false,
          FlDustJacket: false,
          Exists: true,
          ConditionVariant: { ConditionVariant: 'Used - Good', ExLibrary: true },
        },
        NewItem: null,
      },
    })

    const { listings: results } = await fetchBWBListings('1111111111')
    expect(results).toHaveLength(1)
    expect(results[0].condition).toBe('Used Good, Ex-Library')
  })
})
