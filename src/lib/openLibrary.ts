import type { BookSearchResult, Edition, Format } from './types'

const BASE = 'https://openlibrary.org'
const COVERS = 'https://covers.openlibrary.org'
const GB_KEY = process.env.GOOGLE_BOOKS_API_KEY ? `&key=${process.env.GOOGLE_BOOKS_API_KEY}` : ''

/** How many OL search docs to pull before merging duplicates down to MAX_RESULTS. */
const SEARCH_FETCH_LIMIT = 40
/** How many merged results to return to the client (each one costs cover + Goodreads lookups). */
const MAX_RESULTS = 10

const SEARCH_FIELDS = 'title,author_name,key,cover_i,first_publish_year,series_name,series_key,series_position,edition_count'

function docToResult(doc: Record<string, unknown>): BookSearchResult {
  const olSeriesName = Array.isArray(doc.series_name) ? (doc.series_name as string[])[0] : null
  const olSeriesPos = Array.isArray(doc.series_position) ? (doc.series_position as string[])[0] : null
  const primaryCoverId = doc.cover_i as number | null
  const primaryCoverUrl = primaryCoverId ? `${COVERS}/b/id/${primaryCoverId}-M.jpg` : null
  const workId = doc.key as string

  return {
    title: doc.title as string,
    author: Array.isArray(doc.author_name) ? (doc.author_name as string[])[0] : 'Unknown',
    work_id: workId,
    work_ids: [workId],
    cover_url: primaryCoverUrl,
    cover_urls: primaryCoverUrl ? [primaryCoverUrl] : [],
    first_publish_year: doc.first_publish_year as number | null,
    series: olSeriesName ?? null,
    series_number: olSeriesPos ? String(parseInt(olSeriesPos)) : null,
    edition_count: (doc.edition_count as number | undefined) ?? 0,
  }
}

/** Raw OL search — no Google Books enrichment, no series detection. */
async function fetchWorkDocs(query: string): Promise<Record<string, unknown>[]> {
  const url = `${BASE}/search.json?q=${encodeURIComponent(query)}&fields=${SEARCH_FIELDS}&limit=${SEARCH_FETCH_LIMIT}`
  const res = await fetch(url, { next: { revalidate: 3600 } })
  if (!res.ok) return []
  const data = await res.json()
  return data.docs || []
}

export async function searchBooks(query: string): Promise<BookSearchResult[]> {
  const docs = await fetchWorkDocs(query)
  if (docs.length === 0) return []

  // Build initial results with OL data, drop study guides/summaries, then collapse
  // the duplicate work records OL keeps for the same book.
  const results = mergeDuplicateWorks(
    dropDerivativeWorks(docs.map(docToResult), query)
  ).slice(0, MAX_RESULTS)

  // Detect series search via OL series key
  const seriesKey = detectSeriesKey(query, docs.slice(0, MAX_RESULTS))
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
    const existing_ = existing.find(r => (r.work_ids ?? [r.work_id]).includes(workId))
    const coverUrl = entry.picture?.url
      ? `https:${entry.picture.url.replace('-S.jpg', '-M.jpg')}`
      : existing_?.cover_url ?? null
    books.push({
      title: entry.title as string,
      author: existing_?.author ?? author,
      work_id: workId,
      work_ids: existing_?.work_ids ?? [workId],
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

// ─── Duplicate work merging ──────────────────────────────────────────────────
//
// Open Library keeps a separate work record for many title variants of the same
// book. Non-fiction fragments hardest, because it fragments on the subtitle:
// "Sapiens", "Sapiens: A Brief History of Humankind" and
// "Sapiens : a brief history of humankind" can each be their own work, each
// holding only part of the editions. Merging them is what makes the full edition
// list reachable from one search result.

/** Drop a trailing parenthetical, e.g. "Dune (Special Edition)" → "Dune". */
function stripEditionParens(title: string): string {
  return title.replace(/\s*\([^()]*\)\s*$/, ' ').trim()
}

function stripLeadingArticle(normalized: string): string {
  return normalized.replace(/^(the|a|an) /, '')
}

/** Full title, normalised — the strict key. "The Dawn of Everything: A New History" stays whole. */
export function titleKey(title: string): string {
  return stripLeadingArticle(normalize(stripEditionParens(title)))
}

/** Title with any subtitle removed — the loose key. "Sapiens: A Brief History" → "sapiens". */
export function titleCore(title: string): string {
  let t = stripEditionParens(title)
  const colon = t.indexOf(':')
  if (colon > 0) {
    const head = t.slice(0, colon).trim()
    // A one- or two-character head ("A: ...") is punctuation noise, not a main title
    if (head.length >= 3) t = head
  }
  return stripLeadingArticle(normalize(t))
}

/**
 * The volume/part designation in a title, if any. Two records that disagree here
 * are different books ("Collected Essays Vol. 1" vs "Collected Essays Vol. 2"),
 * even when everything else matches.
 */
function volumeToken(title: string): string | null {
  const match = title.match(/\b(?:volume|vol|book|part|no)\.?\s*(\d+|[ivxlc]+)\b/i)
  return match ? match[1].toLowerCase() : null
}

/** Authors match, or one side is unattributed (OL leaves many work records author-less). */
function authorsCompatible(a: string, b: string): boolean {
  const na = normalize(a)
  const nb = normalize(b)
  if (!na || !nb || na === 'unknown' || nb === 'unknown') return true
  return na === nb
}

/**
 * True when two search results are the same book split across OL work records.
 *
 * Deliberately strict: it merges identical titles, and merges a bare main title
 * into a subtitled one, but never merges two different subtitles under a shared
 * main title — "Sapiens: A Brief History of Humankind" and "Sapiens: A Graphic
 * History" are different books.
 */
function canMerge(a: BookSearchResult, b: BookSearchResult): boolean {
  if (!authorsCompatible(a.author, b.author)) return false
  if (volumeToken(a.title) !== volumeToken(b.title)) return false

  const fullA = titleKey(a.title)
  const fullB = titleKey(b.title)
  if (!fullA || !fullB) return false
  if (fullA === fullB) return true

  const coreA = titleCore(a.title)
  const coreB = titleCore(b.title)
  // Same main title, and at least one side carries no subtitle of its own
  return coreA === coreB && (fullA === coreA || fullB === coreB)
}

type WorkGroup = { rep: BookSearchResult; members: BookSearchResult[] }

/** Fold a group's members into a single result, keeping every work id. */
function collapse(group: WorkGroup): BookSearchResult {
  // The record with the most editions is the best-maintained one — use it for display
  const rep = group.members.reduce((best, m) =>
    (m.edition_count ?? 0) > (best.edition_count ?? 0) ? m : best, group.members[0])

  const workIds: string[] = []
  const coverUrls: string[] = []
  for (const m of [rep, ...group.members]) {
    for (const id of m.work_ids ?? [m.work_id]) {
      if (!workIds.includes(id)) workIds.push(id)
    }
    for (const url of m.cover_urls) {
      if (url && !coverUrls.includes(url)) coverUrls.push(url)
    }
  }

  const years = group.members.map((m) => m.first_publish_year).filter((y): y is number => y != null)
  const withSeries = group.members.find((m) => m.series)

  return {
    ...rep,
    work_id: workIds[0],
    work_ids: workIds,
    cover_url: rep.cover_url ?? group.members.find((m) => m.cover_url)?.cover_url ?? null,
    cover_urls: coverUrls.slice(0, 3),
    first_publish_year: years.length > 0 ? Math.min(...years) : null,
    series: withSeries?.series ?? null,
    series_number: withSeries?.series_number ?? null,
    edition_count: group.members.reduce((sum, m) => sum + (m.edition_count ?? 0), 0),
  }
}

/**
 * Collapse duplicate OL work records into one result per book, preserving the
 * order in which each book first appeared (i.e. OL's relevance ranking).
 */
export function mergeDuplicateWorks(results: BookSearchResult[]): BookSearchResult[] {
  // Pass 1: exact title + author matches
  const groups: WorkGroup[] = []
  const byKey = new Map<string, WorkGroup>()
  for (const r of results) {
    const key = `${normalize(r.author)}|${titleKey(r.title)}`
    const existing = byKey.get(key)
    if (existing) {
      existing.members.push(r)
    } else {
      const group: WorkGroup = { rep: r, members: [r] }
      byKey.set(key, group)
      groups.push(group)
    }
  }

  // Pass 2: attach bare-title (or unattributed) groups to their one subtitled sibling.
  // Requiring a *unique* candidate is what stops "Sapiens" from bridging
  // "Sapiens: A Brief History" and "Sapiens: A Graphic History" into one result.
  const absorbed = new Set<WorkGroup>()
  for (const group of groups) {
    if (absorbed.has(group)) continue
    const rep = group.rep
    const isBare = titleKey(rep.title) === titleCore(rep.title)
    const isUnattributed = normalize(rep.author) === 'unknown' || !normalize(rep.author)
    if (!isBare && !isUnattributed) continue

    const candidates = groups.filter(
      (other) => other !== group && !absorbed.has(other) && canMerge(rep, other.rep)
    )
    if (candidates.length !== 1) continue

    candidates[0].members.push(...group.members)
    absorbed.add(group)
  }

  return groups.filter((g) => !absorbed.has(g)).map(collapse)
}

// ─── Derivative works ────────────────────────────────────────────────────────
//
// Popular non-fiction attracts summaries, study guides and workbooks, each its
// own OL work with a near-identical title. They crowd out the real book.

// `analysis` and `companion` are deliberately absent as bare prefixes — "Analysis
// of Algorithms" and "Companion to Russian Studies" are real books. Genuine
// derivatives that use those words pair them with "summary", which is covered.
const DERIVATIVE_PREFIX_RE = /^\s*(?:the\s+)?(?:summary|summaries|study\s*guide|studyguide|reading\s*group\s*guide|teacher'?s?\s*guide|workbook|conversation\s*starters?|key\s*takeaways|quicklet|instaread|joosr|blinkist|cliffs?\s*notes|spark\s*notes|shmoop|sidekick|book\s*summary|extended\s*summary)\b/i
const DERIVATIVE_PHRASE_RE = /\b(?:summary|study\s*guide|workbook|conversation\s*starters?|key\s*takeaways)\s+(?:of|for|on|to)\b/i
const DERIVATIVE_SUFFIX_RE = /[|:]\s*(?:a\s+)?(?:summary|analysis|summary\s*(?:&|and)\s*analysis|study\s*guide|workbook)\b/i

/** True for study guides, summaries and other companions to a book — not the book itself. */
export function isDerivativeWork(title: string): boolean {
  return DERIVATIVE_PREFIX_RE.test(title)
    || DERIVATIVE_PHRASE_RE.test(title)
    || DERIVATIVE_SUFFIX_RE.test(title)
}

/**
 * Remove study guides and summaries — unless the user asked for one, or unless
 * doing so would leave nothing behind.
 */
export function dropDerivativeWorks(results: BookSearchResult[], query: string): BookSearchResult[] {
  if (isDerivativeWork(query) || /\b(summary|guide|workbook|analysis)\b/i.test(query)) return results
  const kept = results.filter((r) => !isDerivativeWork(r.title))
  return kept.length > 0 ? kept : results
}

function extractSeriesFromGBTitle(gbTitle: string): { bookTitle: string; series: string; number: string | null } | null {
  // Pattern 1: "Series #N: Book Title".
  //
  // The number is required. Without it, "X: Y" is overwhelmingly a title and its
  // subtitle — which is how most non-fiction is titled ("Bad Blood: Secrets and
  // Lies in a Silicon Valley Startup") — and reading X as a series name invents
  // phantom series metadata that then re-sorts the whole result set.
  const colonIdx = gbTitle.indexOf(':')
  if (colonIdx > 0) {
    const prefix = gbTitle.slice(0, colonIdx).trim()
    const numMatch = prefix.match(/\s*#?(\d+)\s*$/)
    if (numMatch) {
      const seriesName = prefix.replace(/[,\s]*(book\s+)?#?\d+\s*$/i, '').trim()
      const bookTitle = gbTitle.slice(colonIdx + 1).trim()
      if (seriesName.length > 1 && bookTitle.length > 1) {
        return { bookTitle, series: seriesName, number: numMatch[1] }
      }
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
const EDITION_NOTE_RE = /\b(edition|tie-in|priced|special|anniversary|illustrated|revised|expanded|complete|omnibus|box\s*set|collection|volume|vol\.|reprint|abridged|unabridged|classic|deluxe|premium|exclusive|authorized|official|gift|graphic|novel|adaptation|adapted|movie|film|large\s*print|annotated|translated|paperback|hardcover|hardback|kindle|ebook|summary|study\s*guide|workbook)\b/i
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

/** Upper bound on merged works to fetch editions for, so a bad merge can't fan out. */
const MAX_WORKS_PER_FETCH = 5

/** Fetch up to 600 edition entries for one OL work: first 300, then a second page if needed. */
async function fetchWorkEditionEntries(workId: string): Promise<Record<string, unknown>[]> {
  // workId e.g. "/works/OL45804W"
  const page1Url = `${BASE}${workId}/editions.json?limit=300`
  const page1Res = await fetch(page1Url, { next: { revalidate: 3600, tags: ['editions'] } }).catch(() => null)
  if (!page1Res?.ok) return []
  const page1Data = await page1Res.json()

  const totalSize: number = page1Data.size ?? 0
  let entries: Record<string, unknown>[] = page1Data.entries || []

  if (totalSize > 300) {
    const page2Url = `${BASE}${workId}/editions.json?limit=300&offset=300`
    const page2Res = await fetch(page2Url, { next: { revalidate: 3600 } }).catch(() => null)
    if (page2Res?.ok) {
      const page2Data = await page2Res.json()
      entries = [...entries, ...(page2Data.entries || [])]
    }
  }
  return entries
}

/**
 * Editions for a book. Accepts every OL work the book is split across — passing a
 * single id keeps the old behaviour. Entries are concatenated and then
 * de-duplicated by ISBN, so works that overlap cost nothing extra.
 */
export async function getEditions(workId: string | string[], language = 'eng'): Promise<Edition[]> {
  const workIds = (Array.isArray(workId) ? workId : [workId]).filter(Boolean).slice(0, MAX_WORKS_PER_FETCH)
  if (workIds.length === 0) return []

  const perWork = await Promise.all(workIds.map(fetchWorkEditionEntries))
  const allEntries: Record<string, unknown>[] = perWork.flat()

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


/**
 * Expand a single OL work id into the full set of work records that hold the same
 * book. Stack items persist only one `work_id`, so this is what lets an item saved
 * before work-merging existed still reach every edition.
 *
 * Falls back to `[workId]` whenever the lookup is inconclusive.
 */
export async function findSiblingWorkIds(workId: string, title: string, author: string): Promise<string[]> {
  if (!workId || !title) return [workId].filter(Boolean)

  const normAuthor = author && normalize(author) !== 'unknown' ? author : ''
  const query = normAuthor ? `${title} ${normAuthor}` : title

  try {
    const docs = await fetchWorkDocs(query)
    if (docs.length === 0) return [workId]

    const merged = mergeDuplicateWorks(docs.map(docToResult))
    const group = merged.find((r) => (r.work_ids ?? [r.work_id]).includes(workId))
    if (!group) return [workId]

    const ids = group.work_ids ?? [group.work_id]
    // Keep the caller's work id first — it is the one the user actually chose
    return [workId, ...ids.filter((id) => id !== workId)]
  } catch {
    return [workId]
  }
}
