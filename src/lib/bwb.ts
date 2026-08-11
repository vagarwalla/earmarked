// Better World Books (BWB) scraper.
//
// BWB uses Cloudflare managed challenge, so direct fetch() won't work.
// We use headless Playwright with stealth settings to bypass the challenge,
// then extract the `detailObject` JSON embedded in the product page.
//
// Uses @sparticuz/chromium for Vercel serverless compatibility and
// playwright-core for browser automation.

import type { Listing, SourceFetch } from './types'
import { normalizeCondition } from './abebooks'
import { chromium as pw, type Browser, type BrowserContext } from 'playwright-core'
import chromium from '@sparticuz/chromium'

const PRODUCT_BASE = 'https://www.betterworldbooks.com/product/detail/'

// Reuse browser across invocations within the same serverless instance
let browserPromise: Promise<Browser> | null = null

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const browser = await browserPromise
    if (browser.isConnected()) return browser
    browserPromise = null
  }
  browserPromise = pw.launch({
    args: [...chromium.args, '--disable-blink-features=AutomationControlled'],
    executablePath: process.env.VERCEL
      ? await chromium.executablePath()
      : undefined,
    headless: true,
  })
  return browserPromise
}

async function createStealthContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    // @ts-expect-error -- injecting chrome runtime stub for stealth
    window.chrome = { runtime: {} }
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
  })
  return context
}

// Shape of the `detailObject` embedded in BWB product pages
interface BWBDetailObject {
  Isbn: string
  Title: string
  AddToCartOptions: {
    UsedItem: BWBItem | null
    NewItem: BWBItem | null
  }
}

interface BWBItem {
  InventoryId: number
  UnitPrice: number
  Quantity: number
  ConditionString: string
  Notes: string
  FlSigned: boolean
  FlDustJacket: boolean
  Exists: boolean
  ConditionVariant: {
    ConditionVariant: string
    ExLibrary: boolean
  } | null
}

export async function fetchBWBListings(isbn: string): Promise<SourceFetch> {
  let context: BrowserContext | null = null
  try {
    const browser = await getBrowser()
    context = await createStealthContext(browser)
    const page = await context.newPage()

    await page.goto(`${PRODUCT_BASE}${isbn}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    })

    // Wait for Cloudflare challenge to resolve and page to render
    await page.waitForTimeout(8000)

    const title = await page.title()
    if (title.includes('Just a moment') || title.includes('Attention') || title.includes('blocked')) {
      console.error('BWB: blocked by Cloudflare for ISBN', isbn)
      return { listings: [], error: 'blocked by Cloudflare' }
    }

    // Extract the detailObject from the page
    const detail: BWBDetailObject | null = await page.evaluate(() => {
      // @ts-expect-error -- detailObject is a global set by BWB's inline script
      return typeof detailObject !== 'undefined' ? detailObject : null
    })

    // No detailObject is BWB's answer for an ISBN it doesn't stock — a real
    // "nothing here", not a failure, so it isn't reported as one.
    if (!detail) return { listings: [], error: null }

    const productUrl = page.url()
    return { listings: parseBWBDetail(detail, isbn, productUrl), error: null }
  } catch (err) {
    console.error(`BWB fetch error for ${isbn}:`, err)
    return { listings: [], error: (err as Error).message }
  } finally {
    if (context) await context.close().catch(() => {})
  }
}

function parseBWBDetail(detail: BWBDetailObject, isbn: string, pageUrl: string): Listing[] {
  const listings: Listing[] = []
  const items = [detail.AddToCartOptions.UsedItem, detail.AddToCartOptions.NewItem]

  for (const item of items) {
    if (!item || !item.Exists || item.UnitPrice <= 0) continue

    const conditionText = item.ConditionString
    const isExLibrary = item.ConditionVariant?.ExLibrary ?? false
    const conditionParts = [conditionText]
    if (isExLibrary) conditionParts.push('Ex-Library')
    const conditionDisplay = conditionParts.join(', ')

    listings.push({
      listing_id: `bwb_${item.InventoryId}`,
      seller_id: 'betterworldbooks',
      seller_name: 'Better World Books',
      price: item.UnitPrice,
      // BWB: free shipping on orders $15+; $3.99 standard under that.
      // We report $3.99 base so the optimizer can account for it.
      shipping_base: 3.99,
      shipping_per_additional: 0,
      condition: conditionDisplay,
      condition_normalized: normalizeCondition(conditionText),
      signed: item.FlSigned,
      first_edition: false,
      dust_jacket: item.FlDustJacket,
      url: pageUrl,
      isbn,
    })
  }

  return listings
}
