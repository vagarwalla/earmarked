// Goodreads shelf import.
//
// Goodreads retired their public API in 2020, but every public profile still
// exposes its shelves through two stable, unauthenticated surfaces:
//   1. The profile page (https://www.goodreads.com/user/show/{id}) lists the
//      user's shelves with counts in server-rendered HTML.
//   2. Each shelf has an RSS feed (https://www.goodreads.com/review/list_rss/{id}?shelf={name})
//      with up to 100 books per page, including title, author, ISBN, and cover.
// This module parses both. The profile must be public (not private) for either
// to work.

export interface GoodreadsShelf {
  name: string
  count: number
}

export interface GoodreadsShelfBook {
  goodreads_id: string | null
  title: string
  author: string
  isbn: string | null
  cover_url: string | null
}

const UA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

const RSS_PAGE_SIZE = 100
export const MAX_SHELF_BOOKS = 500

/**
 * Extract a numeric Goodreads user ID from raw input: a bare ID ("12345"),
 * a profile URL (goodreads.com/user/show/12345-jane-doe), or a shelf URL
 * (goodreads.com/review/list/12345?shelf=read). Returns null if unparseable.
 */
export function parseGoodreadsUserId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) return trimmed

  const urlMatch = trimmed.match(/goodreads\.com\/(?:user\/show|review\/list(?:_rss)?|author\/show)\/(\d+)/i)
  if (urlMatch) return urlMatch[1]

  // Bare "12345-jane-doe" fragment (what users see at the end of their URL)
  const fragmentMatch = trimmed.match(/^(\d+)-[\w-]+$/)
  if (fragmentMatch) return fragmentMatch[1]

  return null
}

/**
 * Extract a specific shelf name from a pasted Goodreads URL, e.g.
 * .../review/list/12345-jane?shelf=sociology or ...?tag=sociology
 * (the newer My Books UI links custom shelves with `tag=`). Returns null
 * when the input doesn't point at a specific shelf.
 */
export function parseGoodreadsShelfFromUrl(input: string): string | null {
  const m = input.match(/[?&](?:shelf|tag)=([^&#\s]+)/i)
  if (!m) return null
  const name = decodeURIComponent(m[1].replace(/\+/g, ' ')).trim()
  // "#ALL#" is Goodreads' pseudo-shelf for "everything"
  return name && !name.startsWith('#') ? name : null
}

const INVISIBLE_MARKS = /[\u200a-\u200f\u2060\ufeff]|&lrm;|&rlm;/g

/**
 * Parse shelf names + counts from Goodreads HTML. Works on both the profile
 * page (default shelves: <a href="/review/list/12345?shelf=to-read">to-read (42)</a>)
 * and the My Books page sidebar, where custom shelves may be linked with
 * `tag=` instead of `shelf=` and the count may sit just after the anchor:
 * <a href="?tag=sociology">sociology</a> <span>(23)</span>
 */
export function parseShelvesFromHtml(html: string): GoodreadsShelf[] {
  const shelves: GoodreadsShelf[] = []
  const seen = new Set<string>()
  const re = /<a[^>]*href="[^"]*[?&](?:shelf|tag)=([\w%.+~-]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const name = decodeURIComponent(m[1].replace(/\+/g, ' '))
    if (!name || name.startsWith('#') || seen.has(name)) continue
    seen.add(name)
    // Count is either inside the label ("sociology (23)") or shortly after the
    // anchor — but never past the next link, which belongs to another shelf
    const after = html.slice(re.lastIndex, re.lastIndex + 80).split(/<a[\s>]/)[0]
    const windowText = (m[2] + ' ' + after)
      .replace(INVISIBLE_MARKS, '')
      .replace(/<[^>]*>/g, ' ')
    const countMatch = windowText.match(/\((\d[\d,]*)\)/)
    shelves.push({ name, count: countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : -1 })
  }
  return shelves
}

/** Read the text content of an XML tag, unwrapping CDATA. Returns null when absent/empty. */
function xmlTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))
  if (!m) return null
  const raw = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
  return raw || null
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
}

/**
 * Strip a trailing series annotation Goodreads embeds in titles,
 * e.g. "The Golden Compass (His Dark Materials, #1)" → "The Golden Compass".
 * Conservative: only strips parentheticals that look like series markers.
 */
export function stripSeriesSuffix(title: string): string {
  const stripped = title.replace(/\s*\(([^)]*(?:#\d|Book \d|Series)[^)]*)\)\s*$/i, '').trim()
  return stripped || title
}

/** Goodreads serves a "nophoto" placeholder when a book has no cover — treat as no cover. */
function cleanCoverUrl(url: string | null): string | null {
  if (!url || url.includes('/nophoto/')) return null
  // Feed URLs point at small thumbs (_SX98_ / _SY75_); strip the size suffix for full-size
  return url.replace(/\._[A-Z]{2}\d+_(?=\.(?:jpg|jpeg|png))/i, '')
}

/** Parse one page of a Goodreads shelf RSS feed into books. */
export function parseShelfRss(xml: string): GoodreadsShelfBook[] {
  const books: GoodreadsShelfBook[] = []
  const itemRe = /<item>([\s\S]*?)<\/item>/g
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1]
    const rawTitle = xmlTag(block, 'title')
    if (!rawTitle) continue

    const isbn13 = xmlTag(block, 'isbn13')
    const isbn10 = xmlTag(block, 'isbn')
    const isbn = [isbn13, isbn10].find((v) => v && /^[\dXx-]{10,17}$/.test(v)) ?? null

    const cover =
      xmlTag(block, 'book_medium_image_url') ??
      xmlTag(block, 'book_large_image_url') ??
      xmlTag(block, 'book_image_url')

    books.push({
      goodreads_id: xmlTag(block, 'book_id'),
      title: decodeXmlEntities(stripSeriesSuffix(rawTitle)),
      author: decodeXmlEntities(xmlTag(block, 'author_name') ?? ''),
      isbn: isbn ? isbn.replace(/-/g, '').toUpperCase() : null,
      cover_url: cleanCoverUrl(cover),
    })
  }
  return books
}

/** Extract the shelf owner's display name from the RSS channel title ("Jane's bookshelf: read"). */
export function parseRssOwnerName(xml: string): string | null {
  const channelTitle = xml.match(/<channel>[\s\S]*?<title>([\s\S]*?)<\/title>/)
  if (!channelTitle) return null
  const text = channelTitle[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
  const m = text.match(/^(.*?)['’]s bookshelf/)
  return m ? decodeXmlEntities(m[1]) : null
}

/**
 * Fetch the list of shelves for a Goodreads user. Scrapes two pages and merges:
 * the My Books page sidebar (lists ALL shelves, including custom ones) and the
 * profile page (only top shelves, but reliable counts). Throws only if both
 * pages are unreachable.
 */
export async function fetchShelves(userId: string): Promise<GoodreadsShelf[]> {
  const urls = [
    `https://www.goodreads.com/review/list/${userId}`,
    `https://www.goodreads.com/user/show/${userId}`,
  ]
  const results = await Promise.allSettled(
    urls.map(async (url) => {
      const res = await fetch(url, {
        headers: UA_HEADERS,
        signal: AbortSignal.timeout(10000),
        next: { revalidate: 300 },
      })
      if (!res.ok) throw new Error(`Goodreads returned ${res.status} for ${url}`)
      return parseShelvesFromHtml(await res.text())
    })
  )

  if (results.every((r) => r.status === 'rejected')) {
    throw new Error('Goodreads unreachable')
  }

  const merged = new Map<string, GoodreadsShelf>()
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    for (const shelf of r.value) {
      const existing = merged.get(shelf.name)
      // Prefer whichever source knew the count
      if (!existing || (existing.count < 0 && shelf.count >= 0)) {
        merged.set(shelf.name, shelf)
      }
    }
  }
  return [...merged.values()]
}

/**
 * Fetch every book on a shelf via the RSS feed, paginating until the feed
 * runs out or maxBooks is reached.
 */
export async function fetchShelfBooks(
  userId: string,
  shelf: string,
  maxBooks: number = MAX_SHELF_BOOKS
): Promise<{ books: GoodreadsShelfBook[]; ownerName: string | null }> {
  const books: GoodreadsShelfBook[] = []
  let ownerName: string | null = null

  for (let page = 1; books.length < maxBooks; page++) {
    const url = `https://www.goodreads.com/review/list_rss/${userId}?shelf=${encodeURIComponent(shelf)}&page=${page}`
    const res = await fetch(url, {
      headers: UA_HEADERS,
      signal: AbortSignal.timeout(15000),
      next: { revalidate: 300 },
    })
    if (!res.ok) {
      if (page === 1) throw new Error(`Goodreads shelf feed returned ${res.status}`)
      break
    }
    const xml = await res.text()
    const pageBooks = parseShelfRss(xml)
    if (page === 1 && pageBooks.length === 0) break
    if (ownerName === null) ownerName = parseRssOwnerName(xml)
    books.push(...pageBooks)
    if (pageBooks.length < RSS_PAGE_SIZE) break
  }

  return { books: books.slice(0, maxBooks), ownerName }
}
