import type { BookSearchResult, Edition, Format } from './types'

const BASE = 'https://openlibrary.org'
const COVERS = 'https://covers.openlibrary.org'
const GB_KEY = process.env.GOOGLE_BOOKS_API_KEY ? `&key=${process.env.GOOGLE_BOOKS_API_KEY}` : ''

export async function searchBooks(query: string): Promise<BookSearchResult[]> {
  const olUrl = `${BASE}/search.json?q=${encodeURIComponent(query)}&fields=title,author_name,key,cover_i,first_publish_year,series_name,series_key,series_position&limit=10`
  const olRes = await fetch(olUrl, { next: { revalidate: 3600 } })
  if (!olRes.ok) return []
  const olData = await olRes.json()
  const docs: Record<string, unknown>[] = olData.docs || []

  // Build initial results with OL data
  const results: BookSearchResult[] = docs.map((doc) => {
    const olSeriesName = Array.isArray(doc.series_name) ? (doc.series_name as string[])[0] : null
    const olSeriesPos = Array.isArray(doc.series_position) ? (doc.series_position as string[])[0] : null
    const primaryCoverId = doc.cover_i as number | null
    const primaryCoverUrl = primaryCoverId ? `${COVERS}/b/id/${primaryCoverId}-M.jpg` : null

    return {
      title: doc.title as string,
      author: Array.isArray(doc.author_name) ? (doc.author_name as string[])[0] : 'Unknown',
      work_id: doc.key as string,
      cover_url: primaryCoverUrl,
      cover_urls: primaryCoverUrl ? [primaryCoverUrl] : [],
      first_publish_year: doc.first_publish_year as number | null,
      series: olSeriesName ?? null,
      series_number: olSeriesPos ? String(parseInt(olSeriesPos)) : null,
    }
  })

  // Detect series search via OL series key
  const seriesKey = detectSeriesKey(query, docs)
  if (seriesKey) {
    const seriesResults = await fetchSeriesBooks(seriesKey, results)
    if (seriesResults.length > 0) return seriesResults
  }

  // Only call GB if OL has no series data — GB fills gaps (e.g. series OL doesn't track)
  const olHasSeries = results.some((r) => r.series)
  if (!olHasSeries) {
    const gbUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=20${GB_KEY}`
    const gbRes = await fetch(gbUrl, { next: { revalidate: 3600 } }).catch(() => null)
    if (gbRes?.ok) {
      const gbByTitle = new Map<string, { series: string; number: string | null }>()
      const gbData = await gbRes.json()
      for (const item of gbData.items || []) {
        const gbTitle: string = item.volumeInfo?.title || ''
        const extracted = extractSeriesFromGBTitle(gbTitle)
        if (extracted) gbByTitle.set(normalize(extracted.bookTitle), { series: extracted.series, number: extracted.number })
      }
      // Enrich results with GB series data
      for (const r of results) {
        if (!r.series) {
          const gbMatch = matchGB(r.title, gbByTitle)
          if (gbMatch) {
            r.series = gbMatch.series
            r.series_number = gbMatch.number ? String(parseInt(gbMatch.number)) : null
          }
        }
      }
      // Detect series search via GB (e.g. "Lockwood & Co" — not in OL series)
      const gbSeriesResults = detectGBSeriesSearch(query, results, gbByTitle)
      if (gbSeriesResults) return gbSeriesResults
    }
  }

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
      cover_urls: coverUrl ? [coverUrl] : (existing_?.cover_urls ?? []),
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

// Returns true if the URL points to a genuine cover image.
// OL and GB both occasionally serve small "image not available" placeholders
// (typically a GIF, or a JPEG under 5 KB). Real covers are almost always ≥ 5 KB.
async function isRealCoverImage(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000), next: { revalidate: 3600 } })
    if (!res.ok) return false
    const type = res.headers.get('content-type') ?? ''
    if (type.includes('gif')) return false
    const lengthStr = res.headers.get('content-length')
    if (lengthStr) return parseInt(lengthStr, 10) >= 5000
    // Some CDNs omit Content-Length — read the body to check actual size
    const buf = await res.arrayBuffer()
    return buf.byteLength >= 5000
  } catch {
    return false
  }
}

async function fetchOLCoverByIsbn(isbn: string): Promise<string | null> {
  try {
    const url = `${COVERS}/b/isbn/${isbn}-M.jpg?default=false`
    const res = await fetch(url, { next: { revalidate: 3600 } })
    if (!res.ok) return null
    const coverUrl = `${COVERS}/b/isbn/${isbn}-M.jpg`
    // Even with ?default=false OL can occasionally serve a placeholder — validate
    return await isRealCoverImage(coverUrl) ? coverUrl : null
  } catch {
    return null
  }
}

type GBInfo = { language: string | null; coverUrl: string | null; publishYear: number | null; publisher: string | null; format: Format | null }

function normaliseGBUrl(raw: string | undefined): string | null {
  return raw?.replace('http://', 'https://').replace('&zoom=1', '&zoom=0') ?? null
}

async function fetchGoogleBooksInfo(isbn: string): Promise<GBInfo> {
  const empty: GBInfo = { language: null, coverUrl: null, publishYear: null, publisher: null, format: null }
  try {
    // Include `id` so we can construct a direct cover URL when imageLinks is absent
    const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&fields=items(id,volumeInfo/language,volumeInfo/imageLinks,volumeInfo/publishedDate,volumeInfo/publisher,volumeInfo/printType)&maxResults=1${GB_KEY}`
    const res = await fetch(url, { next: { revalidate: 3600 } })
    if (!res.ok) return empty
    const data = await res.json()
    const item = data.items?.[0]
    if (!item) return empty
    const info = item.volumeInfo ?? {}
    const volumeId = item.id as string | undefined

    // Cover priority: thumbnail → smallThumbnail → direct volume URL (covers GB books
    // that have a cover on the web but don't expose it through imageLinks)
    const thumbnail = normaliseGBUrl(info.imageLinks?.thumbnail as string | undefined)
    const smallThumbnail = normaliseGBUrl(info.imageLinks?.smallThumbnail as string | undefined)
    const directUrl = volumeId
      ? `https://books.google.com/books/content?id=${volumeId}&printsec=frontcover&img=1&zoom=1`
      : null

    let coverUrl: string | null = null
    for (const candidate of [thumbnail, smallThumbnail, directUrl]) {
      if (candidate && await isRealCoverImage(candidate)) { coverUrl = candidate; break }
    }

    const yearMatch = (info.publishedDate as string | undefined)?.match(/\b(1\d{3}|20\d{2})\b/)
    const publishYear = yearMatch ? parseInt(yearMatch[1]) : null
    const publisher = (info.publisher as string | undefined) ?? null
    const printType = (info.printType as string | undefined)?.toLowerCase() ?? ''
    const format: Format | null = printType === 'book' ? null : printType.includes('hardcover') ? 'hardcover' : printType.includes('paperback') ? 'paperback' : null
    return { language: (info.language as string) ?? null, coverUrl, publishYear, publisher, format }
  } catch {
    return empty
  }
}

// Extract an edition descriptor from a title when OL's edition_name field is absent.
// e.g. "Subtle Knife Gist Edition" → "Gist Edition", "Harry Potter Illustrated Edition" → "Illustrated Edition"
function deriveEditionName(title: string): string | null {
  const match = title.match(/\b((?:\w[\w'-]*\s+){0,4}edition(?:\s+\w[\w'-]*)*)\s*$/i)
  return match ? match[1] : null
}

/** Detect titles written in non-Latin scripts (CJK, Cyrillic, Arabic, Hebrew, Greek, Hindi, Thai…) */
export function hasNonLatinScript(text: string): boolean {
  return /[\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0600-\u06FF\u0590-\u05FF\u0900-\u097F\u0386-\u03CE\u0E00-\u0E7F]/.test(text)
}

/** Return true if this OL entry appears to be an audio edition (audiobook, CD, cassette, etc.) */
export function isAudioEdition(entry: Record<string, unknown>): boolean {
  const AUDIO_RE = /\baudio\b|audiobook|audio\s*cd|compact\s*disc|cassette|unabridged|abridged|\bmp3\b|\bcd\b/i
  const title = (entry.title as string) ?? ''
  const publisher = (entry.publishers as string[] | undefined)?.[0] ?? ''
  const physFormat = (entry.physical_format as string) ?? ''
  const editionName = (entry.edition_name as string) ?? ''
  return AUDIO_RE.test(title) || AUDIO_RE.test(publisher) || AUDIO_RE.test(physFormat) || AUDIO_RE.test(editionName)
}

/**
 * ISBN-13 registration group → language/country of publication.
 * Groups 0 and 1 are English; the prefixes listed here are definitively non-English.
 * Source: https://www.isbn-international.org/range_file_generation
 */
const NON_ENGLISH_ISBN13_PREFIXES = [
  // Single-digit non-English groups
  '9782', '9783', '9784', '9785', '9787',
  // Two-digit non-English groups (80–91)
  '97880', '97882', '97883', '97884', '97885', '97886', '97887', '97888', '97889', '97890', '97891',
  // Three-digit non-English groups (selected)
  '978950', '978951', '978952', '978953', '978954', '978955', '978956', '978957', '978958', '978959',
  '978960', '978961', '978963', '978964', '978966', '978968', '978970', '978972', '978973', '978974',
  '978975', '978980', '978985', '978986', '978987', '978989',
]

export function isNonEnglishIsbn(isbn: string): boolean {
  const digits = isbn.replace(/\D/g, '')
  if (digits.length !== 13) return false
  return NON_ENGLISH_ISBN13_PREFIXES.some((p) => digits.startsWith(p))
}

function computePopularityScore(params: {
  ocaid: string | null
  coverId: number | null
  publisher: string | null
  publishYear: number | null
  pages: number | null
  editionName: string | null
}): number {
  let score = 0
  if (params.ocaid) score += 30         // digitized by Internet Archive → widely read
  if (params.publisher) score += 10     // has publisher metadata
  if (params.publishYear) score += 5    // has year metadata
  if (params.pages && params.pages > 0) score += 5  // has page count
  if (params.editionName) score += 5    // has named edition (e.g. "Penguin Classics")
  if (params.publishYear && params.publishYear > 1980) score += 5  // modern printing = more likely in circulation
  return Math.min(60, score)
}

function buildEdition(
  isbn: string,
  entry: Record<string, unknown>,
  coverId: number | null,
  coverUrl: string | null,
): Edition {
  const yearMatch = (entry.publish_date as string | undefined)?.match(/\b(1\d{3}|20\d{2})\b/)
  const publishYear = yearMatch ? parseInt(yearMatch[1]) : null
  const physDesc = (entry.physical_format as string | null) ?? null
  const format = detectFormat((entry.title as string) || '', physDesc)
  const publisher = (entry.publishers as string[] | undefined)?.[0] ?? null
  const editionName = (entry.edition_name as string) || deriveEditionName((entry.title as string) || '') || null
  const pages = (entry.number_of_pages as number) || null
  const ocaid = (entry.ocaid as string | undefined) ?? null
  return {
    isbn,
    title: (entry.title as string) || '',
    publisher,
    publish_year: publishYear,
    format,
    cover_url: coverUrl,
    cover_id: coverId,
    edition_name: editionName,
    pages,
    popularity_score: computePopularityScore({ ocaid, coverId, publisher, publishYear, pages, editionName }),
    ocaid,
  }
}

export async function getEditions(workId: string, language = 'eng'): Promise<Edition[]> {
  // workId e.g. "/works/OL45804W"
  // Fetch up to 600 editions: first 300, then a second page if needed
  const page1Url = `${BASE}${workId}/editions.json?limit=300`
  const page1Res = await fetch(page1Url, { next: { revalidate: 3600, tags: ['editions'] } })
  if (!page1Res.ok) return []
  const page1Data = await page1Res.json()

  const totalSize: number = page1Data.size ?? 0
  let allEntries: Record<string, unknown>[] = page1Data.entries || []

  if (totalSize > 300) {
    const page2Url = `${BASE}${workId}/editions.json?limit=300&offset=300`
    const page2Res = await fetch(page2Url, { next: { revalidate: 3600 } }).catch(() => null)
    if (page2Res?.ok) {
      const page2Data = await page2Res.json()
      allEntries = [...allEntries, ...(page2Data.entries || [])]
    }
  }

  const data = { entries: allEntries }

  const confirmed: Edition[] = []
  // Track ISBNs that had no OL language tag — needs GB verification
  const langUnknownIsbns = new Set<string>()
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

    // Skip audio editions regardless of language
    if (isAudioEdition(entry)) continue

    if (language === 'other') {
      // Show only editions that are definitively non-English
      const langs = (entry.languages as { key: string }[]) || []
      if (langs.length > 0) {
        // OL has explicit language data — include only if it's not English
        const isEnglish = langs.some((l) => l.key === `/languages/eng`)
        if (isEnglish) continue
        confirmed.push(buildEdition(isbn, entry, coverId, coverUrl))
      } else {
        // No OL language tag — use heuristics: only include if there's a positive
        // signal it's non-English (non-Latin script or non-English ISBN)
        const title = (entry.title as string) || ''
        if (!hasNonLatinScript(title) && !isNonEnglishIsbn(isbn)) continue
        confirmed.push(buildEdition(isbn, entry, coverId, coverUrl))
      }
    } else if (language) {
      const langs = (entry.languages as { key: string }[]) || []
      if (langs.length > 0) {
        // OL has explicit language data — exclude if it doesn't match, no exceptions
        const matchesLanguage = langs.some((l) => l.key === `/languages/${language}`)
        if (!matchesLanguage) continue
        confirmed.push(buildEdition(isbn, entry, coverId, coverUrl))
      } else {
        // No OL language tag — apply heuristics before including
        const title = (entry.title as string) || ''
        // Non-Latin scripts (Cyrillic, CJK, Arabic, Hebrew, Greek, Hindi, etc.) are
        // a reliable signal this is not an English edition
        if (hasNonLatinScript(title)) continue
        // ISBN registration group is assigned by each country's national ISBN agency —
        // a reliable indicator of language/country of publication
        if (isNonEnglishIsbn(isbn)) continue
        confirmed.push(buildEdition(isbn, entry, coverId, coverUrl))
        langUnknownIsbns.add(isbn)
      }
    } else {
      confirmed.push(buildEdition(isbn, entry, coverId, coverUrl))
    }
  }

  // Back-fill missing critical fields: cover, year, publisher, format
  // Step 1: try OL ISBN cover for editions missing a cover (free, no quota)
  const noCoverEditions = confirmed.filter((e) => !e.cover_url)
  if (noCoverEditions.length > 0) {
    const olChecks = await Promise.all(noCoverEditions.map((e) => fetchOLCoverByIsbn(e.isbn)))
    for (let i = 0; i < noCoverEditions.length; i++) {
      if (olChecks[i]) noCoverEditions[i].cover_url = olChecks[i]
    }
  }
  // Step 2: call GB for any edition missing cover, year, publisher, or format — one call fills all gaps.
  // Also collect language data so we can post-filter no-language-tag editions.
  const gbLanguages = new Map<string, string | null>()
  const needsGB = confirmed.filter((e) => !e.cover_url || !e.publish_year || !e.publisher || e.format === 'any')
  if (needsGB.length > 0) {
    const gbInfos = await Promise.all(needsGB.map((e) => fetchGoogleBooksInfo(e.isbn)))
    for (let i = 0; i < needsGB.length; i++) {
      const e = needsGB[i]
      const gb = gbInfos[i]
      if (!e.cover_url && gb.coverUrl) e.cover_url = gb.coverUrl
      if (!e.publish_year && gb.publishYear) e.publish_year = gb.publishYear
      if (!e.publisher && gb.publisher) e.publisher = gb.publisher
      if (e.format === 'any' && gb.format) e.format = gb.format
      if (langUnknownIsbns.has(e.isbn)) gbLanguages.set(e.isbn, gb.language)
    }
  }

  // Step 3: for no-language-tag editions not already checked above, call GB just for language
  const targetGBLang = OL_TO_GB_LANG[language] ?? null
  if (language && langUnknownIsbns.size > 0) {
    const needsLangCheck = confirmed.filter(
      (e) => langUnknownIsbns.has(e.isbn) && !gbLanguages.has(e.isbn)
    )
    if (needsLangCheck.length > 0) {
      const langInfos = await Promise.all(needsLangCheck.map((e) => fetchGoogleBooksInfo(e.isbn)))
      for (let i = 0; i < needsLangCheck.length; i++) {
        gbLanguages.set(needsLangCheck[i].isbn, langInfos[i].language)
      }
    }
    // Remove no-language-tag editions that GB confirms are non-English
    return confirmed.filter((e) => {
      if (!langUnknownIsbns.has(e.isbn)) return true
      const gbLang = gbLanguages.get(e.isbn)
      if (!gbLang) return true  // GB also has no language data — include (benefit of the doubt)
      return gbLang === targetGBLang
    })
  }

  return confirmed
}

export function getCoverUrl(isbn: string, size: 'S' | 'M' | 'L' = 'M'): string {
  return `${COVERS}/b/isbn/${isbn}-${size}.jpg`
}
