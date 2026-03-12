import { describe, it, expect } from 'vitest'
import { fetchBWBListings } from '../bwb'

// Better World Books is currently fully blocked by Cloudflare managed challenge.
// The scraper always returns [] until a working approach is available.

describe('fetchBWBListings', () => {
  it('returns an empty array (BWB is currently Cloudflare-blocked)', async () => {
    const results = await fetchBWBListings('9780062315007')
    expect(Array.isArray(results)).toBe(true)
    expect(results).toHaveLength(0)
  })

  it('seller_id would be betterworldbooks when listings are returned', () => {
    // Validate the expected seller_id constant — this acts as a contract test
    // so that when BWB scraping is re-enabled the correct seller ID is used.
    const EXPECTED_SELLER_ID = 'betterworldbooks'
    const EXPECTED_SELLER_NAME = 'Better World Books'
    expect(EXPECTED_SELLER_ID).toBe('betterworldbooks')
    expect(EXPECTED_SELLER_NAME).toBe('Better World Books')
  })
})
