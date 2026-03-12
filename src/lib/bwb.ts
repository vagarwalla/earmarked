// Better World Books (BWB) scraper.
//
// Status: BWB blocks all server-side requests with Cloudflare managed challenge
// (HTTP 403, requires JS + browser fingerprinting).  Direct HTML/JSON scraping
// is not currently possible without a headless browser.
//
// This module keeps the same interface as the other scrapers so it can be
// trivially re-enabled if a working approach is found (partner API key,
// proxy, Playwright layer, etc.).  For now it always returns [].
//
// The search_url returned in SourceInfo still links users to the manual
// BWB search so they can check it themselves.

import type { Listing } from './types'

export async function fetchBWBListings(_isbn: string): Promise<Listing[]> {
  // BWB currently blocks all programmatic access via Cloudflare challenge.
  // Return an empty array so the rest of the pricing pipeline is unaffected.
  return []
}
