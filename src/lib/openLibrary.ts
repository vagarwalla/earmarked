import type { BookSearchResult, Edition, Format } from './types'

const BASE = 'https://openlibrary.org'
const COVERS = 'https://covers.openlibrary.org'

export async function searchBooks(query: string): Promise<BookSearchResult[]> {
  const olUrl = `${BASE}/search.json?q=${encodeURIComponent(query)}&fields=title,author_name,key,cover_i,first_publish_year,series_name,series_key,series_position&limit=10`
  const gbUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=20`

  const [olRes, gbRes] = await Promise.all([
    fetch(olUrl, { next: { revalidate: 3600 } }),
    fetch(gbUrl, { cache: 'no-store' }).catch(() => null),
  ])

  if (!olRes.ok) return []
  const olData = await olRes.json()

  // Build GB series map: book title → { series, number }
  const gbByTitle = new Map<string, { series: string; number: string | null }>()
  if (gbRes?.ok) {
    const gbData = await gbRes.json()
    for (const item of gbData.items || []) {
      const gbTitle: string = item.volumeInfo?.title || ''
      const extracted = extractSeriesFromGBTitle(gbTitle)
      if (extracted) gbByTitle.set(normalize(extracted.bookTitle), { series: extracted.series, number: extracted.number })
    }
  }

  // Build initial results with OL data
  const docs: Record<string, unknown>[] = olData.docs || []
  const results: BookSearchResult[] = docs.map((doc) => {
    const olTitle = doc.title as string
    const olSeriesName = Array.isArray(doc.series_name) ? (doc.series_name as string[])[0] : null
    const olSeriesPos = Array.isArray(doc.series_position) ? (doc.series_position as string[])[0] : null
    const gbMatch = matchGB(olTitle, gbByTitle)
    return {
      title: olTitle,
      author: Array.isArray(doc.author_name) ? (doc.author_name as string[])[0] : 'Unknown',
      work_id: doc.key as string,
      cover_url: doc.cover_i ? `${COVERS}/b/id/${doc.cover_i}-M.jpg` : null,
      first_publish_year: doc.first_publish_year as number | null,
      series: olSeriesName ?? gbMatch?.series ?? null,
      series_number: olSeriesPos
        ? String(parseInt(olSeriesPos))
        : gbMatch?.number
          ? String(parseInt(gbMatch.number))
          : null,
    }
  })

  // Detect series search: query closely matches a series name that multiple results share
  const seriesKey = detectSeriesKey(query, docs)
  if (seriesKey) {
    const seriesResults = await fetchSeriesBooks(seriesKey, results)
    if (seriesResults.length > 0) return seriesResults
  }

  // Detect series search via GB (e.g. "Lockwood & Co" — not in OL series)
  const gbSeriesResults = detectGBSeriesSearch(query, results, gbByTitle)
  if (gbSeriesResults) return gbSeriesResults

  return results
}

/** If most results share a series_key and the series_name matches the query, return that key */
function detectSeriesKey(query: string, docs: Record<string, unknown>[]): string | null {
  const norm = normalize(query)
  const keyCounts = new Map<string, { count: number; name: string }>()
  for (const doc of docs) {
    const keys = (doc.series_key as string[] | null) || []
    const names = (doc.series_name as string[] | null) || []
    if (keys[0] && names[0]) {
      const existing = keyCounts.get(keys[0])
      if (existing) existing.count++
      else keyCounts.set(keys[0], { count: 1, name: names[0] })
    }
  }
  for (const [key, { count, name }] of keyCounts) {
    if (count >= 2 && normalize(name).includes(norm)) return key
    if (normalize(name) === norm) return key
  }
  return null
}

/** Fetch all books for a series from OL seeds endpoint, enriched with author from existing results */
async function fetchSeriesBooks(seriesKey: string, existing: BookSearchResult[]): Promise<BookSearchResult[]> {
  const url = `${BASE}/series/${seriesKey}/seeds.json`
  const res = await fetch(url, { next: { revalidate: 3600 } }).catch(() => null)
  if (!res?.ok) return []
  const data = await res.json()

  const author = existing[0]?.author ?? 'Unknown'
  const series = existing.find(r => r.series)?.series ?? null

  const books: BookSearchResult[] = []
  let pos = 0
  for (const entry of data.entries || []) {
    if (entry.type !== 'work') continue
    pos++
    const workId: string = entry.url  // e.g. "/works/OL82563W"
    const existing_ = existing.find(r => r.work_id === workId)
    const coverUrl = entry.picture?.url
      ? `https:${entry.picture.url.replace('-S.jpg', '-M.jpg')}`
      : existing_?.cover_url ?? null
    books.push({
      title: entry.title as string,
      author: existing_?.author ?? author,
      work_id: workId,
      cover_url: coverUrl,
      first_publish_year: existing_?.first_publish_year ?? null,
      series,
      series_number: String(pos),
    })
  }
  return books
}

/** If GB results show a series matching the query, sort all results by series number */
function detectGBSeriesSearch(
  query: string,
  results: BookSearchResult[],
  gbByTitle: Map<string, { series: string; number: string | null }>,
): BookSearchResult[] | null {
  const normQuery = normalize(query)
  // Count how many results have a series matching the query
  const seriesCounts = new Map<string, number>()
  for (const r of results) {
    if (r.series) {
      const normSeries = normalize(r.series)
      if (normSeries.includes(normQuery) || normQuery.includes(normSeries)) {
        seriesCounts.set(r.series, (seriesCounts.get(r.series) ?? 0) + 1)
      }
    }
  }
  if (seriesCounts.size === 0) return null

  let bestSeries = ''
  let bestCount = 0
  for (const [s, c] of seriesCounts) {
    if (c > bestCount) { bestCount = c; bestSeries = s }
  }
  if (bestCount < 2) return null

  // Sort: numbered series books first (in order), then unnumbered series books, then others
  return [...results].sort((a, b) => {
    const aInSeries = a.series === bestSeries
    const bInSeries = b.series === bestSeries
    if (aInSeries !== bInSeries) return aInSeries ? -1 : 1
    const na = a.series_number ? parseInt(a.series_number) : Infinity
    const nb = b.series_number ? parseInt(b.series_number) : Infinity
    return na - nb
  })
}

type GBMatch = { series: string; number: string | null }

function matchGB(olTitle: string, gbByTitle: Map<string, GBMatch>): GBMatch | null {
  const normOL = normalize(olTitle)
  // Skip very short titles — too likely to match unrelated GB content
  if (normOL.length < 12) return null
  // Strip leading articles for suffix matching (e.g. "the screaming staircase" → "screaming staircase")
  const stripped = normOL.replace(/^(the|a|an) /, '')
  for (const [normGB, match] of gbByTitle) {
    if (normOL === normGB) return match
    if (normGB.endsWith(normOL) || normGB.endsWith(' ' + normOL)) return match
    if (stripped.length >= 12 && (normGB.endsWith(stripped) || normGB.endsWith(' ' + stripped))) return match
    if (normGB.includes(normOL)) return match
  }
  return null
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
}

function extractSeriesFromGBTitle(gbTitle: string): { bookTitle: string; series: string; number: string | null } | null {
  // Pattern 1: "Series: Book Title" or "Series #N: Book Title"
  const colonIdx = gbTitle.indexOf(':')
  if (colonIdx > 0) {
    const prefix = gbTitle.slice(0, colonIdx).trim()
    const numMatch = prefix.match(/\s*#?(\d+)\s*$/)
    const number = numMatch ? numMatch[1] : null
    const seriesName = prefix.replace(/[,\s]*(book\s+)?#?\d+\s*$/i, '').trim()
    const bookTitle = gbTitle.slice(colonIdx + 1).trim()
    if (seriesName.length > 1 && bookTitle.length > 1) {
      return { bookTitle, series: seriesName, number }
    }
  }
  // Pattern 2: "Book Title (Series, #N)" or "Book Title (Series Book N/Word)"
  const WORD_NUMS: Record<string, string> = { one:'1',two:'2',three:'3',four:'4',five:'5',six:'6',seven:'7',eight:'8',nine:'9',ten:'10' }
  const parenMatch = gbTitle.match(/^(.+?)\s*\(([^)]+?)(?:[,\s]+(?:book\s+)?(?:#?(\d+)|(one|two|three|four|five|six|seven|eight|nine|ten)))?\)\s*$/i)
  if (parenMatch) {
    const candidate = parenMatch[2].trim()
    const number = parenMatch[3] ?? (parenMatch[4] ? WORD_NUMS[parenMatch[4].toLowerCase()] : null)
    if (!isEditionNote(candidate)) return { bookTitle: parenMatch[1].trim(), series: candidate, number }
  }
  return null
}

// Reject strings that are marketing/edition notes rather than series names
const EDITION_NOTE_RE = /\b(edition|tie-in|priced|special|anniversary|illustrated|revised|expanded|complete|omnibus|box\s*set|collection|volume|vol\.|reprint|abridged|unabridged|classic|deluxe|premium|exclusive|authorized|official|gift)\b/i
function isEditionNote(s: string): boolean {
  return EDITION_NOTE_RE.test(s)
}

export function detectFormat(title: string, physDesc: string | null): Format {
  const text = `${title} ${physDesc || ''}`.toLowerCase()
  if (text.includes('hardcover') || text.includes('hardback')) return 'hardcover'
  if (text.includes('paperback') || text.includes('softcover') || text.includes('mass market')) return 'paperback'
  return 'any'
}

// Maps Open Library ISO 639-2 codes to Google Books ISO 639-1 codes
const OL_TO_GB_LANG: Record<string, string> = {
  eng: 'en', fre: 'fr', ger: 'de', spa: 'es', ita: 'it',
  por: 'pt', dut: 'nl', rus: 'ru', jpn: 'ja', zho: 'zh',
  ara: 'ar', kor: 'ko', pol: 'pl', swe: 'sv', dan: 'da',
  nor: 'no', fin: 'fi', tur: 'tr', heb: 'he', hin: 'hi',
}

async function fetchGoogleBooksLanguage(isbn: string): Promise<string | null> {
  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&fields=items(volumeInfo/language)&maxResults=1`
    const res = await fetch(url, { next: { revalidate: 86400 } })
    if (!res.ok) return null
    const data = await res.json()
    return (data.items?.[0]?.volumeInfo?.language as string) ?? null
  } catch {
    return null
  }
}

function buildEdition(
  isbn: string,
  entry: Record<string, unknown>,
  coverId: number | null,
  coverUrl: string,
): Edition {
  const yearMatch = (entry.publish_date as string | undefined)?.match(/\b(1\d{3}|20\d{2})\b/)
  const publishYear = yearMatch ? parseInt(yearMatch[1]) : null
  const physDesc = (entry.physical_format as string | null) ?? null
  const format = detectFormat((entry.title as string) || '', physDesc)
  return {
    isbn,
    title: (entry.title as string) || '',
    publisher: (entry.publishers as string[] | undefined)?.[0] ?? null,
    publish_year: publishYear,
    format,
    cover_url: coverUrl,
    cover_id: coverId,
    edition_name: (entry.edition_name as string) || null,
    pages: (entry.number_of_pages as number) || null,
  }
}

export async function getEditions(workId: string, language = 'eng'): Promise<Edition[]> {
  // workId e.g. "/works/OL45804W"
  const url = `${BASE}${workId}/editions.json?limit=300`
  const res = await fetch(url, { next: { revalidate: 3600 } })
  if (!res.ok) return []
  const data = await res.json()

  const confirmed: Edition[] = []
  const needsVerification: Array<{ isbn: string; entry: Record<string, unknown>; coverId: number | null; coverUrl: string }> = []
  const seenIsbns = new Set<string>()

  for (const entry of data.entries || []) {
    const isbns: string[] = [
      ...(entry.isbn_13 as string[] || []),
      ...(entry.isbn_10 as string[] || []),
    ]
    if (isbns.length === 0) continue
    const isbn = isbns[0]
    if (seenIsbns.has(isbn)) continue
    seenIsbns.add(isbn)

    const rawCoverId = (entry.covers as number[] | undefined)?.[0]
    const coverId = rawCoverId && rawCoverId > 0 ? rawCoverId : null
    const coverUrl = coverId ? `${COVERS}/b/id/${coverId}-M.jpg` : null

    if (language && !coverUrl) continue

    if (language) {
      const langs = (entry.languages as { key: string }[]) || []
      if (langs.length > 0) {
        // OL has language data — trust it
        if (!langs.some((l) => l.key === `/languages/${language}`)) continue
        confirmed.push(buildEdition(isbn, entry, coverId, coverUrl!))
      } else {
        // No OL language data — queue for Google Books verification
        needsVerification.push({ isbn, entry, coverId, coverUrl: coverUrl! })
      }
    } else {
      confirmed.push(buildEdition(isbn, entry, coverId, coverUrl!))
    }
  }

  // Verify untagged editions via Google Books (cap at 8 to stay fast)
  if (language && needsVerification.length > 0) {
    const gbLangCode = OL_TO_GB_LANG[language] ?? language.slice(0, 2)
    const toCheck = needsVerification.slice(0, 8)
    const gbLanguages = await Promise.all(toCheck.map(({ isbn }) => fetchGoogleBooksLanguage(isbn)))
    for (let i = 0; i < toCheck.length; i++) {
      const gbLang = gbLanguages[i]
      // Include if Google Books confirms the language OR has no data (give benefit of the doubt)
      if (gbLang === null || gbLang === gbLangCode) {
        const { isbn, entry, coverId, coverUrl } = toCheck[i]
        confirmed.push(buildEdition(isbn, entry, coverId, coverUrl))
      }
    }
  }

  return confirmed
}

export function getCoverUrl(isbn: string, size: 'S' | 'M' | 'L' = 'M'): string {
  return `${COVERS}/b/isbn/${isbn}-${size}.jpg`
}
