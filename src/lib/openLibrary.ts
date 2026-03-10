import type { BookSearchResult, Edition, Format } from './types'

const BASE = 'https://openlibrary.org'
const COVERS = 'https://covers.openlibrary.org'

export async function searchBooks(query: string): Promise<BookSearchResult[]> {
  const olUrl = `${BASE}/search.json?q=${encodeURIComponent(query)}&fields=title,author_name,key,cover_i,first_publish_year,series_name&limit=10`
  const gbUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=20`

  const [olRes, gbRes] = await Promise.all([
    fetch(olUrl, { next: { revalidate: 3600 } }),
    fetch(gbUrl, { next: { revalidate: 3600 } }).catch(() => null),
  ])

  if (!olRes.ok) return []
  const olData = await olRes.json()

  const gbTitlesWithSeries: Array<{ bookTitle: string; series: string }> = []
  if (gbRes?.ok) {
    const gbData = await gbRes.json()
    for (const item of gbData.items || []) {
      const gbTitle: string = item.volumeInfo?.title || ''
      const extracted = extractSeriesFromGBTitle(gbTitle)
      if (extracted) gbTitlesWithSeries.push(extracted)
    }
  }

  return (olData.docs || []).map((doc: Record<string, unknown>) => {
    const olTitle = doc.title as string
    // series_name is the authoritative OL field; fall back to GB title parsing
    const olSeries = Array.isArray(doc.series_name) ? (doc.series_name as string[])[0] : null
    const series = olSeries ?? matchSeries(olTitle, gbTitlesWithSeries)
    return {
      title: olTitle,
      author: Array.isArray(doc.author_name) ? (doc.author_name as string[])[0] : 'Unknown',
      work_id: doc.key as string,
      cover_url: doc.cover_i ? `${COVERS}/b/id/${doc.cover_i}-M.jpg` : null,
      first_publish_year: doc.first_publish_year as number | null,
      series,
    }
  })
}

function extractSeriesFromGBTitle(gbTitle: string): { bookTitle: string; series: string } | null {
  // Pattern 1: "Series: Book Title" or "Series #N: Book Title"
  // e.g., "Lockwood & Co.: The Screaming Staircase" or "Lockwood & Co. 1: The Screaming Staircase"
  const colonIdx = gbTitle.indexOf(':')
  if (colonIdx > 0) {
    const prefix = gbTitle.slice(0, colonIdx).trim()
    const seriesName = prefix.replace(/[,\s]*(book\s+)?#?\d+\s*$/i, '').trim()
    const bookTitle = gbTitle.slice(colonIdx + 1).trim()
    if (seriesName.length > 1 && bookTitle.length > 1) {
      return { bookTitle, series: seriesName }
    }
  }
  // Pattern 2: "Book Title (Series, #N)" or "Book Title (Series Book N)"
  const parenMatch = gbTitle.match(/^(.+?)\s*\(([^)]+?)(?:[,\s]+(?:book\s+)?#?\d+)?\)\s*$/i)
  if (parenMatch) {
    const candidate = parenMatch[2].trim()
    if (!isEditionNote(candidate)) return { bookTitle: parenMatch[1].trim(), series: candidate }
  }
  return null
}

// Reject strings that are marketing/edition notes rather than series names
const EDITION_NOTE_RE = /\b(edition|tie-in|priced|special|anniversary|illustrated|revised|expanded|complete|omnibus|box\s*set|collection|volume|vol\.|reprint|abridged|unabridged|classic|deluxe|premium|exclusive|authorized|official|gift)\b/i
function isEditionNote(s: string): boolean {
  return EDITION_NOTE_RE.test(s)
}

function matchSeries(olTitle: string, candidates: Array<{ bookTitle: string; series: string }>): string | null {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
  const normOL = normalize(olTitle)
  for (const { bookTitle, series } of candidates) {
    const normGB = normalize(bookTitle)
    if (normOL === normGB || normOL.includes(normGB) || normGB.includes(normOL)) {
      return series
    }
  }
  return null
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

  // Verify untagged editions via Google Books (cap at 40 to stay fast)
  if (language && needsVerification.length > 0) {
    const gbLangCode = OL_TO_GB_LANG[language] ?? language.slice(0, 2)
    const toCheck = needsVerification.slice(0, 40)
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
