import type { BookSearchResult, Edition, Format } from './types'

const BASE = 'https://openlibrary.org'
const COVERS = 'https://covers.openlibrary.org'

export async function searchBooks(query: string): Promise<BookSearchResult[]> {
  const olUrl = `${BASE}/search.json?q=${encodeURIComponent(query)}&fields=title,author_name,key,cover_i,first_publish_year,series&limit=10`
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
    const olSeries = Array.isArray(doc.series) ? (doc.series as string[])[0] : null
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
    return { bookTitle: parenMatch[1].trim(), series: parenMatch[2].trim() }
  }
  return null
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

export async function getEditions(workId: string, language = 'eng'): Promise<Edition[]> {
  // workId e.g. "/works/OL45804W"
  const url = `${BASE}${workId}/editions.json?limit=300`
  const res = await fetch(url, { next: { revalidate: 3600 } })
  if (!res.ok) return []
  const data = await res.json()

  const editions: Edition[] = []
  const seenIsbns = new Set<string>()

  for (const entry of data.entries || []) {
    // Language filter: only include entries matching the requested language (if set)
    if (language) {
      const langs: { key: string }[] = entry.languages || []
      const matchesLang = langs.some((l) => l.key === `/languages/${language}`)
      if (langs.length > 0) {
        // Edition has language data — skip if it doesn't match
        if (!matchesLang) continue
      } else {
        // No language metadata — use title as a fallback signal.
        // Skip if the title contains non-Latin script characters (Cyrillic, CJK, Arabic, etc.)
        const title: string = entry.title || ''
        const hasNonLatin = /[\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(title)
        if (hasNonLatin) continue
      }
    }

    const isbns: string[] = [
      ...(entry.isbn_13 || []),
      ...(entry.isbn_10 || []),
    ]
    if (isbns.length === 0) continue
    const isbn = isbns[0]
    if (seenIsbns.has(isbn)) continue
    seenIsbns.add(isbn)

    const rawCoverId = entry.covers?.[0]
    const coverId = rawCoverId && rawCoverId > 0 ? rawCoverId as number : null
    const coverUrl = coverId ? `${COVERS}/b/id/${coverId}-M.jpg` : null

    // Skip editions without a cover when language filtering is active
    if (language && !coverUrl) continue

    const yearMatch = entry.publish_date?.match(/\b(1\d{3}|20\d{2})\b/)
    const publishYear = yearMatch ? parseInt(yearMatch[1]) : null

    const physDesc = entry.physical_format || null
    const format = detectFormat(entry.title || '', physDesc)

    editions.push({
      isbn,
      title: entry.title || '',
      publisher: entry.publishers?.[0] || null,
      publish_year: publishYear,
      format,
      cover_url: coverUrl,
      cover_id: coverId,
      edition_name: (entry.edition_name as string) || null,
      pages: (entry.number_of_pages as number) || null,
    })
  }

  return editions
}

export function getCoverUrl(isbn: string, size: 'S' | 'M' | 'L' = 'M'): string {
  return `${COVERS}/b/isbn/${isbn}-${size}.jpg`
}
