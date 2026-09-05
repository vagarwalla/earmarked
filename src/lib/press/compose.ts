/**
 * press — issue composer (U5).
 *
 * A closed issue becomes one print-ready package: a named issue, a TOC built
 * from real page positions, an interior PDF, and a cover sized to its spine.
 *
 * On KTD7. The plan calls for the interior to be re-rendered in a single
 * Vivliostyle pass rather than concatenating the ingest-time measurement
 * fragments. The objection to concatenation was concrete: per-fragment page
 * counters restart at 1, rolled-over items carry a stale issue number, and a
 * long-lived issue ends up mixing template versions. All three are properties
 * of *reusing old fragments*, not of the number of passes.
 *
 * So: everything is re-rendered here, at the current template version, with
 * one continuous counter. Prose renders in a single pass — literally one, in
 * the common case. The exception is an emailed PDF, which arrives already laid
 * out and cannot be re-rendered by us at all. A PDF sitting between two
 * articles necessarily splits the prose either side of it, because one
 * Vivliostyle pass has one counter and it cannot skip the pages the PDF
 * occupies. Those runs are rendered with explicit start-page offsets, which
 * preserves continuous numbering across the whole interior — the property
 * KTD7 actually cares about. With no PDFs in an issue there is exactly one
 * render pass, as specified.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getJson,
  getObject,
  itemsForIssue,
  putObject,
  recordEvent,
  storagePath,
  updateIssue,
  updateItem,
} from './db'
import { loadSettings, type PressSettings } from './settings'
import { archiveCollectionName, nameIssue } from './naming'
import { GROUNDS, INKS, fallbackBrief, rampFor, type CoverBrief } from './art-direction'
import {
  buildArticleSection,
  buildDocument,
  escapeHtml,
  renderHtml,
  loadImages,
  articleImages,
  pdfPageCount,
  type ArticleEntry,
  type RenderDeps,
} from './layout/render'
import {
  PRINT_SPEC,
  coverSizePt,
  spineWidthPt,
  spineTakesText,
  spineTextHeightPt,
  BLEED_PT,
  COVER_SAFETY_PT,
  MEDIA_HEIGHT_PT,
  MEDIA_WIDTH_PT,
  type Article,
  type ArticleImage,
  type ComposedIssue,
  type PressIssue,
  type PressItem,
  tocMeta,
  type TocEntry,
} from './types'

// Re-exported so existing callers and tests keep one import site.
export { tocMeta }

// ── Closing decision ─────────────────────────────────────────────────────────

export interface CloseDecision {
  close: boolean
  reason: 'threshold' | 'max-age' | 'not-ready' | 'empty' | 'below-print-minimum'
  pageTotal: number
}

export function weeksBetween(from: string | Date, to: Date): number {
  const start = from instanceof Date ? from : new Date(from)
  return (to.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000)
}

/**
 * Should the open issue close on this weekly tick?
 *
 * Two ways in: it has filled (≥ threshold), or it has been open too long and
 * still clears Lulu's 32-page perfect-binding floor. The age backstop is what
 * stops a slow reading month from stalling the loop indefinitely.
 */
export function shouldCloseIssue(
  issue: Pick<PressIssue, 'opened_at'>,
  pageTotal: number,
  settings: Pick<PressSettings, 'pageThreshold' | 'maxIssueAgeWeeks'>,
  now: Date = new Date(),
): CloseDecision {
  if (pageTotal <= 0) return { close: false, reason: 'empty', pageTotal }
  if (pageTotal >= settings.pageThreshold) return { close: true, reason: 'threshold', pageTotal }

  if (weeksBetween(issue.opened_at, now) >= settings.maxIssueAgeWeeks) {
    return pageTotal >= PRINT_SPEC.minPages
      ? { close: true, reason: 'max-age', pageTotal }
      : { close: false, reason: 'below-print-minimum', pageTotal }
  }
  return { close: false, reason: 'not-ready', pageTotal }
}

// ── Entries ──────────────────────────────────────────────────────────────────

/** An article to typeset, or a PDF that arrived already laid out. */
export type ComposeEntry =
  | { kind: 'article'; item: PressItem; article: Article }
  | { kind: 'pdf'; item: PressItem; pdf: Uint8Array; pageCount: number }

export interface ComposeDeps extends RenderDeps {
  db: SupabaseClient
  settings?: PressSettings
  /** Injected in tests; production names the issue with a small Claude model. */
  nameIssueFn?: typeof nameIssue
  now?: Date
  /**
   * Keep this name instead of naming the issue again.
   *
   * A rebuild re-renders an issue; it does not re-title it. `nameIssue` is a
   * model call, so without this the button quietly renames the magazine every
   * time it is pressed — the same reason `buildIssue` takes a `name`. Only once
   * it has one, though: an unnamed draft gets its name from the compose.
   */
  name?: string
  /**
   * Said as each stage begins, for the row a button is polling.
   *
   * A compose is four to six minutes with nothing to show for most of it. What
   * the caller does with these is its own business — the worker writes them
   * into `press_jobs.progress`, the tests ignore them.
   */
  onProgress?: (message: string) => void
}

/**
 * Load what an issue is made of. Items with neither an article nor a usable
 * fragment are skipped and reported — a half-ingested item must not become
 * blank pages in a printed magazine.
 */
export async function loadEntries(
  items: PressItem[],
  deps: ComposeDeps,
): Promise<{ entries: ComposeEntry[]; skipped: { item: PressItem; reason: string }[] }> {
  const db = deps.db
  const entries: ComposeEntry[] = []
  const skipped: { item: PressItem; reason: string }[] = []

  for (const item of items) {
    try {
      if (item.source === 'pdf') {
        if (!item.fragment_path) throw new Error('pdf item has no fragment')
        const pdf = await getObject(item.fragment_path, db)
        entries.push({ kind: 'pdf', item, pdf, pageCount: await pdfPageCount(pdf) })
        continue
      }
      if (!item.content_path) throw new Error('item has no extracted article')
      const article = await getJson<Article>(item.content_path, db)
      entries.push({ kind: 'article', item, article })
    } catch (err) {
      skipped.push({ item, reason: (err as Error).message })
    }
  }

  return { entries, skipped }
}

// ── Front matter ─────────────────────────────────────────────────────────────

/** Rough capacity of one TOC page; only used to sanity-check the rendered count. */
const TOC_ENTRIES_PER_PAGE = 18

/**
 * The byline/publication line, plus what the entry has to do with the entry
 * above it. A linkpost says so; the pieces it named say whose they are, and are
 * indented under it — which is the only place the reader sees the grouping
 * before they reach the pages themselves.
 */
function tocMetaHtml(entry: TocEntry): string {
  const parts: string[] = []
  const meta = tocMeta(entry)
  if (meta) parts.push(escapeHtml(meta))
  if (entry.isLinkpost) parts.push('<span class="toc-flag">Linkpost</span>')
  else if (entry.linkpostOf) {
    parts.push(`<span class="toc-via">via ${escapeHtml(entry.linkpostOf)}</span>`)
  }
  return parts.join('<span class="sep">·</span>')
}

export function buildTocSection(issueName: string, issueNumber: number, toc: TocEntry[]): string {
  const rows = toc
    .map((e) => {
      const classes = ['toc-entry']
      if (e.linkpostOf) classes.push('toc-entry--child')
      return `      <li class="${classes.join(' ')}">
        <span class="toc-title">${escapeHtml(e.title)}</span>
        <span class="toc-meta">${tocMetaHtml(e)}</span>
        <span class="toc-page">${e.startPage}</span>
      </li>`
    })
    .join('\n')

  return `    <section class="toc" id="toc">
      <h1 class="toc-masthead">${escapeHtml(issueName)}</h1>
      <p class="toc-issue">Issue ${issueNumber}</p>
      <ol class="toc-list">
${rows}
      </ol>
    </section>`
}

/**
 * TOC page numbers are resolved from measured article lengths rather than from
 * anchor positions, because every article opener carries `break-before: page`:
 * an article's own page count does not change with what precedes it, so the
 * cumulative sum *is* its start page in the combined render.
 */
export function computeToc(entries: ComposeEntry[], pageCounts: number[], frontPages: number): TocEntry[] {
  const toc: TocEntry[] = []
  let page = frontPages + 1
  entries.forEach((entry, i) => {
    const pageCount = pageCounts[i]
    const title = entry.kind === 'article' ? entry.article.title : (entry.item.title ?? 'Untitled')
    toc.push({
      itemId: entry.item.id,
      title,
      byline: entry.kind === 'article' ? entry.article.byline : null,
      sourceName: entry.kind === 'article' ? entry.article.sourceName : entry.item.source_name,
      startPage: page,
      pageCount,
      isLinkpost: entry.kind === 'article' ? Boolean(entry.article.linkpost) : entry.item.is_linkpost,
      linkpostOf: entry.kind === 'article' ? (entry.article.linkpostOf?.title ?? null) : null,
    })
    page += pageCount
  })
  return toc
}

// ── Interior ─────────────────────────────────────────────────────────────────

/** Consecutive articles that can share one render pass. */
interface Run {
  start: number
  entries: { entry: Extract<ComposeEntry, { kind: 'article' }>; index: number }[]
}

function groupRuns(entries: ComposeEntry[]): (Run | { pdf: Extract<ComposeEntry, { kind: 'pdf' }> })[] {
  const out: (Run | { pdf: Extract<ComposeEntry, { kind: 'pdf' }> })[] = []
  let run: Run | null = null
  entries.forEach((entry, index) => {
    if (entry.kind === 'pdf') {
      run = null
      out.push({ pdf: entry })
      return
    }
    if (!run) {
      run = { start: index, entries: [] }
      out.push(run)
    }
    run.entries.push({ entry, index })
  })
  return out
}

function toArticleEntry(entry: Extract<ComposeEntry, { kind: 'article' }>): ArticleEntry {
  return { article: entry.article, id: `article-${entry.item.id}` }
}

/** Merge PDFs in order into one document. */
export async function mergePdfs(parts: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  for (const part of parts) {
    const doc = await PDFDocument.load(part, { ignoreEncryption: true })
    const pages = await out.copyPages(doc, doc.getPageIndices())
    for (const page of pages) out.addPage(page)
  }
  return out.save()
}

/** Perfect binding needs an even leaf count; a blank verso is the standard fix. */
export async function padToEven(pdf: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true })
  if (doc.getPageCount() % 2 === 0) return pdf
  doc.addPage([MEDIA_WIDTH_PT, MEDIA_HEIGHT_PT])
  return doc.save()
}

// ── Cover ────────────────────────────────────────────────────────────────────

let coverTemplateCache: string | null = null

const HERE = path.dirname(fileURLToPath(import.meta.url))

export function coverTemplate(): string {
  if (coverTemplateCache === null) {
    coverTemplateCache = readFileSync(path.join(HERE, 'layout', 'templates', 'cover.html'), 'utf8')
  }
  return coverTemplateCache
}

export function __resetComposeCache(): void {
  coverTemplateCache = null
}

/**
 * The dateline a cover carries: when the issue was made up, not the span its
 * contents were originally published over. Those are very different numbers —
 * issue 1 holds a piece from 2014 — and "February 2014 – August 2026" on a
 * cover says something false about the object.
 */
export function issueDateline(at: Date | string = new Date()): string {
  const d = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  // Local time, deliberately not UTC: this is an editorial date, not a
  // timestamp. Building on the evening of 31 August west of Greenwich would
  // otherwise print "September" on a magazine made up in August.
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

export interface CoverOptions {
  issueName: string
  issueNumber: number
  pageCount: number
  /** Free line printed under the masthead — see `issueDateline`. */
  dateRange: string
  toc: TocEntry[]
  /**
   * The colours and composition, chosen from the contents by `chooseCover`.
   * Omitted, the issue number picks one — which is what every cover used to
   * do, and is still what a press with no API key gets.
   */
  brief?: CoverBrief
}

/**
 * Cover palette. Warm-dominant with two cool anchors, in the register of a
 * riso-printed art magazine — saturated enough to carry a cover, muted enough
 * not to fight the interior's black-on-cream.
 */
export const COVER_PALETTE = [
  '#E9A93A', // marigold
  '#D9603B', // persimmon
  '#B8324B', // crimson
  '#6E3A6B', // plum
  '#2B4C9B', // ultramarine
  '#1E7F6B', // viridian
] as const

/**
 * The palette rotated by the issue number, so consecutive issues do not come
 * out the same colour. Deterministic: the same issue always prints the same.
 */
export function paletteFor(issueNumber: number, length = COVER_PALETTE.length): string[] {
  const n = COVER_PALETTE.length
  const offset = ((Math.trunc(issueNumber) - 1) % n + n) % n
  return Array.from({ length }, (_, i) => COVER_PALETTE[(offset + i) % n])
}

// ── Cover art ────────────────────────────────────────────────────────────────
//
// Nine issues had nine covers that were the same picture in a rotated palette,
// which on a shelf reads as one magazine printed nine times. So the artwork is
// a *family* now: a set of compositions, one picked per issue, each drawn in
// that issue's rotation of the palette. Same grid, same type, same paper — a
// series that is recognisably a series, with a different cover every time.
//
// Still drawn in CSS rather than placed as an image, for the reason the cover
// template gives: Lulu wants 300 PPI on a cover, which is ~2100x3000px for one
// 7x10 panel, and the art extraction pulls down is 424-1320px wide and would
// print visibly soft. A gradient has no resolution to be wrong.

/** Hard-stop colour stops across 0-100%, so bands meet without a blur. */
function bands(colors: string[], from = 0, to = 100): string {
  const span = to - from
  return colors
    .map((c, i) => {
      const a = from + (i / colors.length) * span
      const b = from + ((i + 1) / colors.length) * span
      return `${c} ${a.toFixed(1)}% ${b.toFixed(1)}%`
    })
    .join(', ')
}

/**
 * Hard-stop stops at deliberately unequal widths.
 *
 * Six equal bands is what a gradient does by default, and it looks like it:
 * flat, and obviously not chosen. These proportions are — wide, narrow, wide
 * again — so a plain stack of colour reads as a composition.
 */
function unevenBands(colors: string[]): string {
  const stops = [0, 9, 21, 39, 62, 80, 100]
  return colors
    .map((c, i) => `${c} ${stops[i] ?? 100}% ${stops[i + 1] ?? 100}%`)
    .join(', ')
}

/**
 * One composition. `css` is a complete declaration list dropped into the
 * `.art` rule — every value in it is a palette colour or a number computed
 * here, so nothing from an article can reach the stylesheet.
 */
interface CoverArt {
  name: string
  css: string
}

/**
 * The compositions, in the order issues take them. Deliberately varied in
 * *structure* rather than just in hue: an arc, a horizon, a stack of rules and
 * a column of blocks look like different covers even in the same six colours.
 */
export const COVER_ARTS: ((c: string[]) => CoverArt)[] = [
  // 1. Orbit — concentric arcs struck from the outer bottom corner.
  (c) => ({
    name: 'orbit',
    css: `background: radial-gradient(circle at 100% 100%, ${bands(c)}, transparent 118%);`,
  }),

  // 2. Horizon — a low sun over a banded ground. The one that reads as a
  //    landscape rather than as geometry.
  (c) => ({
    name: 'horizon',
    css: [
      `background:`,
      `  radial-gradient(circle at 50% 78%, ${c[0]} 0 22%, transparent 22.4%),`,
      `  linear-gradient(to bottom, ${bands(c.slice(1).reverse())});`,
    ].join('\n        '),
  }),

  // 3. Column — vertical blocks at unequal widths.
  (c) => ({
    name: 'column',
    css: `background: linear-gradient(to right, ${unevenBands(c)});`,
  }),

  // 4. Fan — a conic sweep from the outer corner. Same corner as the orbit,
  //    entirely different figure. `from 270deg` because that is where the
  //    panel actually is: measured from north, the quadrant visible above a
  //    bottom-right origin runs 270deg to 360deg, and starting anywhere else
  //    puts the whole fan off the page.
  (c) => ({
    name: 'fan',
    css: `background: conic-gradient(from 270deg at 100% 100%, ${bands(c, 0, 25)}, transparent 25%);`,
  }),

  // 5. Stack — horizontal bands at unequal depths; the quietest of the set and
  //    the one that lets the colour do all the work.
  (c) => ({
    name: 'stack',
    css: `background: linear-gradient(to bottom, ${unevenBands(c)});`,
  }),

  // 6. Lens — concentric circles centred in the panel, ringed like a target.
  (c) => ({
    name: 'lens',
    css: `background: radial-gradient(circle at 50% 46%, ${bands(c, 0, 62)}, ${c[c.length - 1]} 62%);`,
  }),

  // 7. Chevron — hard diagonal bands running corner to corner.
  (c) => ({
    name: 'chevron',
    css: `background: linear-gradient(128deg, ${bands(c)});`,
  }),

  // 8. Nested — rectangles inside rectangles, weighted low the way Albers set
  //    his squares. The quietest of the family and the most expensive-looking.
  (c) => ({
    name: 'nested',
    css: [
      `background:`,
      `  linear-gradient(${c[4]}, ${c[4]}) 50% 66% / 30% 26% no-repeat,`,
      `  linear-gradient(${c[3]}, ${c[3]}) 50% 64% / 52% 46% no-repeat,`,
      `  linear-gradient(${c[2]}, ${c[2]}) 50% 62% / 74% 66% no-repeat,`,
      `  ${c[0]};`,
    ].join('\n        '),
  }),

  // 9. Arch — a half-round standing on a banded base. The most figurative of
  //    them, and the one that reads as architecture.
  (c) => ({
    name: 'arch',
    css: [
      `background:`,
      `  radial-gradient(circle at 50% 62%, transparent 0 30%, ${c[1]} 30% 44%, transparent 44.4%),`,
      `  radial-gradient(circle at 50% 62%, ${c[3]} 0 30%, transparent 30.4%),`,
      `  linear-gradient(to bottom, ${c[5]} 0 62%, ${c[0]} 62% 100%);`,
    ].join('\n        '),
  }),
]

/**
 * The composition this issue's cover is drawn in. Deterministic, so a rebuild
 * of Issue 4 is always the same cover, and adjacent issues never repeat.
 */
export function coverArtFor(issueNumber: number, colors: string[]): CoverArt {
  const n = COVER_ARTS.length
  const i = ((Math.trunc(issueNumber) - 1) % n + n) % n
  return COVER_ARTS[i](colors)
}

/**
 * One composition by name, which is how the art direction asks for it.
 *
 * The names are the contract between `FIGURES` and the drawings; an unknown
 * one falls back to the first rather than throwing, because a cover that
 * cannot be drawn must not be the reason an issue cannot be printed.
 */
export function coverArtByName(name: string, colors: string[]): CoverArt {
  return (COVER_ARTS.map((f) => f(colors)).find((a) => a.name === name) ?? COVER_ARTS[0](colors))
}

/**
 * Set the issue title at a size that still fits the panel. Measured against
 * the 7" trim less both safety margins; the thresholds are character counts
 * because there is no text metric available at build time.
 */
function themeClass(name: string): string {
  const longestWord = Math.max(...name.split(/\s+/).map((w) => w.length), 0)
  if (name.length > 52 || longestWord > 15) return 'theme-name--verylong'
  if (name.length > 30 || longestWord > 12) return 'theme-name--long'
  return ''
}

/**
 * Size step for the run of titles on the back. Driven by total characters
 * rather than piece count: four long essay titles set more text than ten short
 * ones, and it is the text that has to fit the panel.
 */
export function contentsClass(toc: TocEntry[]): string {
  // Titles plus roughly three characters of separator apiece.
  const chars = toc.reduce((n, e) => n + e.title.length + 3, 0)
  if (chars > 700) return 'contents--verylong'
  if (chars > 450) return 'contents--long'
  if (chars < 180) return 'contents--short'
  return ''
}

/**
 * The spine panel. Lulu refuses spine text below `minPagesForSpineText` — a
 * thinner spine cannot hold the words clear of the faces once the binder's
 * drift is allowed for — so a thin issue gets a bare spine rather than a
 * rejected cover.
 */
function spineContent(opts: CoverOptions): string {
  if (!spineTakesText(opts.pageCount)) return ''
  return [
    `<span class="spine-text">${escapeHtml(opts.issueName)}</span>`,
    `<span class="spine-num">No. ${opts.issueNumber}</span>`,
  ].join('')
}

/**
 * The cover is one spread — back, spine, front — sized to the interior's page
 * count, because the spine width is a function of it.
 *
 * The art is drawn in CSS, not placed as an image: Lulu wants 300 PPI on the
 * cover and the extracted article art is web-sized. See `templates/cover.html`.
 */
export function buildCoverHtml(opts: CoverOptions): string {
  const { width, height } = coverSizePt(opts.pageCount)
  const spine = spineWidthPt(opts.pageCount)

  // Titles only, run together as one block. Bylines and page numbers belong
  // to the contents page inside; repeating them on the back made it a second,
  // worse index instead of a look at what the issue is.
  const backList = opts.toc
    .map((e) => escapeHtml(e.title))
    .join('<span class="c-sep">\u25c6</span>')

  // Spine text is sized off the clearance Lulu requires either side of it, so
  // it shrinks with the spine instead of overflowing onto the faces.
  const spineTextHeight = Math.max(spineTextHeightPt(opts.pageCount), 4)

  // Two or three colours chosen for what the issue is about, not six rotated
  // by its number. See art-direction.ts, which holds the rules and the brief.
  const brief = opts.brief ?? fallbackBrief(opts.issueNumber)
  const colors = rampFor(brief.scheme, 6, opts.issueNumber)
  const art = coverArtByName(brief.figure.name, colors)
  const ground = GROUNDS[brief.scheme.ground]

  const values: Record<string, string> = {
    ART_STYLE: art.css,
    ART_NAME: art.name,
    // The accent picks up the first colour of this issue's rotation, so the
    // rules and the spine numeral belong to the same palette as the art.
    ACCENT: colors[0],
    GROUND: ground,
    // The band on the back reprises the cover's own colours, so it says which
    // issue this is rather than showing the whole palette on every one.
    PALETTE_BAND: brief.scheme.inks
      .map((ink) => `<span style="background:${INKS[ink]}"></span>`)
      .join(''),
    COVER_WIDTH: width.toFixed(2),
    COVER_HEIGHT: height.toFixed(2),
    SPINE_WIDTH: spine.toFixed(2),
    // Each outer panel is one trim plus the bleed it absorbs at its outer edge.
    PANEL_WIDTH: ((width - spine) / 2).toFixed(2),
    // Safety inside the trim; the outer edges carry the bleed on top of it.
    SAFETY_TOP: (COVER_SAFETY_PT + BLEED_PT).toFixed(2),
    SAFETY_OUTER: (COVER_SAFETY_PT + BLEED_PT).toFixed(2),
    SAFETY_INNER: COVER_SAFETY_PT.toFixed(2),
    SPINE_PAD: (COVER_SAFETY_PT + BLEED_PT).toFixed(2),
    SPINE_TEXT_HEIGHT: spineTextHeight.toFixed(2),
    SPINE_FONT: Math.min(8.5, spineTextHeight * 0.72).toFixed(2),
    SPINE_CONTENT: spineContent(opts),
    ISSUE_NAME: escapeHtml(opts.issueName),
    ISSUE_NUMBER: String(opts.issueNumber),
    DATE_RANGE: escapeHtml(opts.dateRange),
    PAGE_COUNT: String(opts.pageCount),
    THEME_CLASS: themeClass(opts.issueName),
    CONTENTS_CLASS: contentsClass(opts.toc),
    BACK_LIST: backList,
  }

  // A function replacement, so `$&` and friends in the values stay literal.
  return coverTemplate().replace(
    /\{\{([A-Z_]+)\}\}/g,
    (whole, key: string) => (key in values ? values[key] : whole),
  )
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface PreflightProblem {
  code: 'too-few-pages' | 'too-many-pages' | 'odd-pages' | 'wrong-page-size'
  detail: string
}

/**
 * The checks Lulu will run, run here first — a rejection after V has approved
 * an issue costs a round trip through her inbox.
 */
export async function preflightInterior(pdf: Uint8Array): Promise<PreflightProblem[]> {
  const problems: PreflightProblem[] = []
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true })
  const pages = doc.getPageCount()

  if (pages < PRINT_SPEC.minPages) {
    problems.push({ code: 'too-few-pages', detail: `${pages} pages, minimum ${PRINT_SPEC.minPages}` })
  }
  if (pages > PRINT_SPEC.maxPages) {
    problems.push({ code: 'too-many-pages', detail: `${pages} pages, maximum ${PRINT_SPEC.maxPages}` })
  }
  if (pages % 2 !== 0) {
    problems.push({ code: 'odd-pages', detail: `${pages} pages` })
  }

  doc.getPages().forEach((page, i) => {
    const { width, height } = page.getSize()
    if (Math.abs(width - MEDIA_WIDTH_PT) > 1 || Math.abs(height - MEDIA_HEIGHT_PT) > 1) {
      problems.push({
        code: 'wrong-page-size',
        detail: `page ${i + 1} is ${width.toFixed(1)}x${height.toFixed(1)}pt, expected ${MEDIA_WIDTH_PT}x${MEDIA_HEIGHT_PT}pt`,
      })
    }
  })

  return problems
}

// ── Compose ──────────────────────────────────────────────────────────────────

export interface ComposeResult extends ComposedIssue {
  skipped: { item: PressItem; reason: string }[]
  preflight: PreflightProblem[]
  archiveName: string
}

/**
 * Closed issue → print-ready interior + cover, stored and recorded.
 */
export async function composeIssue(issue: PressIssue, deps: ComposeDeps): Promise<ComposeResult> {
  const settings = deps.settings ?? loadSettings()
  const db = deps.db
  const now = deps.now ?? new Date()
  const nameFn = deps.nameIssueFn ?? nameIssue
  const progress = deps.onProgress ?? (() => {})

  progress('Loading the articles')
  const items = await itemsForIssue(issue.id, db)
  const { entries, skipped } = await loadEntries(items, deps)
  if (entries.length === 0) throw new Error(`press/compose: issue ${issue.number} has nothing to print`)

  for (const s of skipped) {
    await updateItem(s.item.id, { state: 'failed', failure_reason: `not composable: ${s.reason}` }, db)
  }

  // 1. Measure each article at the current template version (KTD7).
  const pageCounts: number[] = []
  for (const [i, entry] of entries.entries()) {
    progress(`Measuring ${i + 1} of ${entries.length}`)
    if (entry.kind === 'pdf') {
      pageCounts.push(entry.pageCount)
      continue
    }
    const html = buildDocument([buildArticleSection(toArticleEntry(entry))], {
      issueNumber: issue.number,
      startPage: 1,
      documentTitle: entry.article.title,
    })
    const images = await loadImages(articleImages(entry.article), deps.loadImage)
    pageCounts.push((await renderHtml(html, images, deps)).pageCount)
  }

  // 2. Name the issue from what is actually in it — unless it already has one.
  const provisionalToc = computeToc(entries, pageCounts, 0)
  let name = deps.name
  if (!name) {
    progress('Naming the issue')
    name = await nameFn({
      issueNumber: issue.number,
      toc: provisionalToc,
      apiKey: settings.anthropicApiKey,
    })
  }

  // 3. Render the front matter to learn how long it really is, then rebuild it
  //    with the page numbers that knowledge produces.
  progress('Setting the contents page')
  let frontPages = Math.max(1, Math.ceil(entries.length / TOC_ENTRIES_PER_PAGE))
  let toc = computeToc(entries, pageCounts, frontPages)
  let front = await renderHtml(
    buildDocument([buildTocSection(name, issue.number, toc)], {
      issueNumber: issue.number,
      startPage: 1,
      measurement: true,
      documentTitle: name,
    }),
    new Map(),
    deps,
  )
  if (front.pageCount !== frontPages) {
    // The estimate was off; the real count is now known, so one correction is
    // enough — the entry count did not change, so neither will the length.
    frontPages = front.pageCount
    toc = computeToc(entries, pageCounts, frontPages)
    front = await renderHtml(
      buildDocument([buildTocSection(name, issue.number, toc)], {
        issueNumber: issue.number,
        startPage: 1,
        measurement: true,
        documentTitle: name,
      }),
      new Map(),
      deps,
    )
  }

  // 4. Render the prose. One pass when nothing interrupts it.
  progress('Typesetting the pages')
  const parts: Uint8Array[] = [front.pdf]
  for (const group of groupRuns(entries)) {
    if ('pdf' in group) {
      parts.push(group.pdf.pdf)
      continue
    }
    const startPage = toc[group.entries[0].index].startPage
    const html = buildDocument(
      group.entries.map((e, i) => buildArticleSection(toArticleEntry(e.entry), i)),
      { issueNumber: issue.number, startPage, documentTitle: name },
    )
    const images = await loadImages(
      group.entries.flatMap((e) => articleImages(e.entry.article)),
      deps.loadImage,
    )
    parts.push((await renderHtml(html, images, deps)).pdf)
  }

  progress('Binding the interior')
  const interior = await padToEven(await mergePdfs(parts))
  const pageCount = await pdfPageCount(interior)
  const preflight = await preflightInterior(interior)

  // 5. Cover, sized to the finished interior.
  progress('Rendering the cover')
  const cover = (
    await renderHtml(
      buildCoverHtml({
        issueName: name,
        issueNumber: issue.number,
        pageCount,
        // The month the issue was made up, not the span its contents were
        // published over — see `issueDateline`.
        dateRange: issueDateline(deps.now),
        toc,
      }),
      new Map(),
      deps,
    )
  ).pdf

  progress('Storing the files')
  const interiorPath = storagePath.interior(issue.id)
  const coverPath = storagePath.cover(issue.id)
  await putObject(interiorPath, interior, 'application/pdf', db)
  await putObject(coverPath, cover, 'application/pdf', db)
  await updateIssue(
    issue.id,
    { name, page_total: pageCount, interior_path: interiorPath, cover_path: coverPath },
    db,
  )
  await recordEvent(
    {
      issue_id: issue.id,
      kind: 'issue_composed',
      detail: { name, pageCount, articles: entries.length, skipped: skipped.length, preflight },
    },
    db,
  )

  return {
    issueId: issue.id,
    number: issue.number,
    name,
    interior,
    cover,
    pageCount,
    toc,
    skipped,
    preflight,
    archiveName: archiveCollectionName(now, name),
  }
}

/** Images referenced by every entry — used by the worker to warm storage reads. */
export function allImages(entries: ComposeEntry[]): ArticleImage[] {
  return entries.flatMap((e) => (e.kind === 'article' ? articleImages(e.article) : []))
}
