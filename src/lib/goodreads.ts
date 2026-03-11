export interface GoodreadsData {
  rating: number
  ratings_count: number
  url: string
}

/**
 * Fetch Goodreads rating data by scraping the search page.
 * Returns null on any error or if no results are found.
 */
export async function fetchGoodreadsData(title: string, author: string): Promise<GoodreadsData | null> {
  const query = author ? `${title} ${author}` : title
  const searchUrl = `https://www.goodreads.com/search?q=${encodeURIComponent(query)}&search_type=books`

  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 86400 }, // cache for 24h
    })

    if (!res.ok) return null

    const html = await res.text()

    // Extract rating from minirating spans, e.g.:
    // "4.11 avg rating — 2,343,984 ratings"
    const ratingMatch = html.match(/(\d+\.\d+)\s+avg\s+rating\s+[—–-]+\s*([\d,]+)\s+ratings/)
    if (!ratingMatch) return null

    const rating = parseFloat(ratingMatch[1])
    const ratings_count = parseInt(ratingMatch[2].replace(/,/g, ''), 10)
    if (isNaN(rating) || isNaN(ratings_count)) return null

    // Extract first book URL from search results
    const urlMatch = html.match(/href="(\/book\/show\/[^"?#]+)/)
    const bookPath = urlMatch?.[1] ?? null
    const url = bookPath ? `https://www.goodreads.com${bookPath}` : searchUrl

    return { rating, ratings_count, url }
  } catch {
    return null
  }
}

/** Format a ratings count for display: 1234567 → "1.2M", 12345 → "12.3k" */
export function formatRatingsCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}
