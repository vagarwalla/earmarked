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
  db?: SupabaseClient
  settings?: PressSettings
  /** Injected in tests; production names the issue with a small Claude model. */
  nameIssueFn?: typeof nameIssue
  now?: Date
}

/**
 * Load what an issue is made of. Items with neither an article nor a usable
 * fragment are skipped and reported — a half-ingested item must not become
 * blank pages in a printed magazine.
 */
export async function loadEntries(
  items: PressItem[],
  deps: ComposeDeps = {},
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

/**
 * Every issue is drawn its own figure, and the figures have to read as one
 * series: the same six-colour palette, the same hard-stop riso register, the
 * same paper ground showing through as the drawing's negative space. What
 * changes from issue to issue is the geometry — which motif is struck, and the
 * handful of numbers inside it.
 *
 * The motif steps with the issue number, so no two issues standing next to each
 * other on a shelf carry the same figure. Seven motifs against six palette
 * rotations: a figure and a colour set do not pair up again for 42 issues. The
 * numbers inside a motif come off a hash of the issue's number *and* its name,
 * so even those two are drawn differently — and the hash is stable, so
 * re-composing an issue prints the cover it printed before.
 *
 * Still CSS rather than a placed photograph, for the resolution reason set out
 * at the top of templates/cover.html.
 */
export const COVER_MOTIFS = [
  'orbit',
  'arches',
  'rays',
  'strata',
  'columns',
  'eclipse',
  'horizon',
] as const

export type CoverMotif = (typeof COVER_MOTIFS)[number]

/** The figure this issue is drawn with. Consecutive issues never share one. */
export function motifFor(issueNumber: number): CoverMotif {
  const n = COVER_MOTIFS.length
  return COVER_MOTIFS[((Math.trunc(issueNumber) - 1) % n + n) % n]
}

/** FNV-1a, 32-bit: small, dependency-free, and stable from run to run. */
function hash32(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * The dials one figure is drawn with — an angle, a radius, a band count. Each
 * is read off the issue's seed under its own name, so adding a dial to a motif
 * does not shift the ones already there.
 */
interface Dials {
  /** A whole number in [lo, hi]. */
  int(salt: string, lo: number, hi: number): number
  /** A number in [lo, hi). */
  span(salt: string, lo: number, hi: number): number
}

function dialsFor(seed: number): Dials {
  const at = (salt: string) => hash32(salt, seed)
  return {
    int: (salt, lo, hi) => lo + (at(salt) % (hi - lo + 1)),
    span: (salt, lo, hi) => lo + ((at(salt) % 1024) / 1024) * (hi - lo),
  }
}

const pc = (n: number) => `${n.toFixed(1)}%`

/**
 * A run of bands across a stretch of the gradient line. Every stop is hard —
 * each colour ends exactly where the next begins — because a riso plate does
 * not gradate, and because a colour left to interpolate towards `transparent`
 * fringes grey on the way there.
 */
function bandStops(colors: string[], from: number, to: number, unit = '%'): string {
  const step = (to - from) / colors.length
  return colors
    .map((c, i) => {
      const a = (from + i * step).toFixed(1)
      const b = (from + (i + 1) * step).toFixed(1)
      return `${c} ${a}${unit} ${b}${unit}`
    })
    .join(', ')
}

/** Concentric rings with paper left between them. */
function ringStops(colors: string[], inner: number, outer: number, gap: number): string {
  const step = (outer - inner) / colors.length
  const parts = [`transparent 0 ${pc(inner)}`]
  colors.forEach((c, i) => {
    const a = inner + i * step
    const b = a + step - gap
    parts.push(`${c} ${pc(a)} ${pc(b)}`, `transparent ${pc(b)} ${pc(a + step)}`)
  })
  return parts.join(', ')
}

/** Weights that sum to 1 — uneven, but never so uneven a band disappears. */
function weights(d: Dials, salt: string, n: number): number[] {
  const raw = Array.from({ length: n }, (_, i) => 0.6 + d.span(`${salt}-w${i}`, 0, 0.8))
  const total = raw.reduce((a, b) => a + b, 0)
  return raw.map((w) => w / total)
}

/**
 * Bands of unequal width, laid end to end along the gradient line, with one
 * seam of paper left open between two of them. The seam is a hairline of the
 * ground rather than a whole band: a band dropped to paper leaves a hole in the
 * middle of the figure, where a seam reads as one plate lifted off the next.
 */
function unevenStops(colors: string[], ws: number[], seam: { at: number; width: number }): string {
  let at = 0
  const parts: string[] = []
  colors.forEach((c, i) => {
    const from = at * 100
    at += ws[i]
    const to = at * 100
    const cut = i === seam.at ? seam.width : 0
    parts.push(`${c} ${pc(from)} ${pc(to - cut)}`)
    if (cut) parts.push(`transparent ${pc(to - cut)} ${pc(to)}`)
  })
  return parts.join(', ')
}

/**
 * One flat disc. Sized `closest-side`, so its radius is measured against the
 * short edge of the art box and a thicker issue does not inflate it.
 */
function disc(color: string, x: number, y: number, r: number): string {
  return `radial-gradient(circle closest-side at ${pc(x)} ${pc(y)}, ${color} 0 ${pc(r)}, transparent ${pc(r)})`
}

/** Bands held to the foot of the box — the ground a figure stands on. */
function ground(colors: string[], from: number, ws: number[]): string {
  let at = from
  const parts = [`transparent 0 ${pc(from)}`]
  colors.forEach((c, i) => {
    const next = at + ws[i] * (100 - from)
    parts.push(`${c} ${pc(at)} ${pc(next)}`)
    at = next
  })
  return `linear-gradient(to bottom, ${parts.join(', ')})`
}

/**
 * Each motif returns a CSS `background-image` list, front layer first. They all
 * bleed off the outer edge of the panel, and none of them reference anything.
 */
const MOTIF_LAYERS: Record<CoverMotif, (colors: string[], d: Dials) => string[]> = {
  /** Concentric hard bands struck from the panel's outer bottom corner. */
  orbit: (colors, d) => {
    const rings = colors.slice(0, d.int('orbit-rings', 4, colors.length))
    // Past 100% is past the box's far corner: the outermost band has to reach
    // beyond it, or the corner prints paper.
    const reach = d.span('orbit-reach', 106, 124)
    return [
      `radial-gradient(circle at 100% 100%, ${bandStops(rings, 0, reach)}, transparent ${pc(reach)})`,
    ]
  },

  /** Half-rings rising from the foot, with paper between them. */
  arches: (colors, d) => {
    const arcs = colors.slice(0, d.int('arch-count', 3, 5))
    return [
      `radial-gradient(circle at ${pc(d.span('arch-x', 34, 66))} 100%, ${ringStops(
        arcs,
        d.span('arch-inner', 16, 32),
        d.span('arch-outer', 98, 122),
        d.span('arch-gap', 3, 6),
      )})`,
    ]
  },

  /** A fan of wedges opening from the outer bottom corner. */
  rays: (colors, d) => {
    const wedges = colors.slice(0, d.int('ray-count', 4, colors.length))
    // 270deg puts the fan's zero on the left of the outer bottom corner, so the
    // box is one quadrant of it, and the tilt swings the fan off square. The
    // wedges are spread over 108deg rather than 90 so that whatever the tilt
    // the fan still overruns the quadrant: a wedge stopping short of the edge
    // leaves a hairline of paper down the trim, and it prints as a sawtooth.
    const tilt = d.span('ray-tilt', 0, 18)
    return [
      `conic-gradient(from ${(270 - tilt).toFixed(1)}deg at 100% 100%, ${bandStops(
        wedges,
        0,
        108,
        'deg',
      )})`,
    ]
  },

  /** Horizontal seams of unequal depth, one of them opened to the paper. */
  strata: (colors, d) => {
    const n = d.int('strata-count', 4, colors.length)
    const seam = { at: d.int('strata-seam', 0, n - 2), width: d.span('strata-seam-w', 2.4, 4.6) }
    return [
      `linear-gradient(to bottom, ${unevenStops(colors.slice(0, n), weights(d, 'strata', n), seam)})`,
    ]
  },

  /** Vertical columns of unequal width, crossed by a single rule. */
  columns: (colors, d) => {
    const n = d.int('col-count', 4, colors.length)
    const seam = { at: d.int('col-seam', 0, n - 2), width: d.span('col-seam-w', 2, 4) }
    const rule = d.span('col-rule', 52, 74)
    return [
      // Listed first, so the rule lies over the columns rather than under them,
      // and drawn in the paper so it reads against every column it crosses.
      `linear-gradient(to bottom, transparent 0 ${pc(rule)}, var(--paper) ${pc(rule)} ${pc(
        rule + 1.6,
      )}, transparent ${pc(rule + 1.6)})`,
      `linear-gradient(to right, ${unevenStops(colors.slice(0, n), weights(d, 'col', n), seam)})`,
    ]
  },

  /**
   * Two discs, the nearer one punched out of the further in paper, standing in
   * banded ground. The offset between them is held to a fraction of the radius
   * and the ground is set above the disc's foot, so the crescent is always cut
   * from a disc it overlaps and always stands on something.
   */
  eclipse: (colors, d) => {
    const r = d.span('ecl-r', 58, 76)
    const x = d.span('ecl-x', 30, 46)
    const y = d.span('ecl-y', 38, 50)
    return [
      disc('var(--paper)', x + d.span('ecl-dx', 9, 16), y - d.span('ecl-dy', 5, 11), r * 0.84),
      disc(colors[0], x, y, r),
      ground(colors.slice(1, 3), d.span('ecl-ground', 62, 72), weights(d, 'ecl', 2)),
    ]
  },

  /** A disc rising out of banded ground. */
  horizon: (colors, d) => {
    const line = d.span('hor-line', 46, 62)
    const n = d.int('hor-bands', 2, 4)
    return [
      // The ground is the front layer, so the disc is cut by the horizon.
      ground(colors.slice(1, 1 + n), line, weights(d, 'hor', n)),
      disc(colors[0], d.span('hor-x', 34, 66), line, d.span('hor-r', 46, 70)),
    ]
  },
}

export interface CoverArt {
  motif: CoverMotif
  /** A CSS `background-image` list, front layer first. */
  layers: string
}

/**
 * The figure for one issue: which motif, drawn with which numbers. Pure and
 * deterministic — the same issue always yields the same art.
 */
export function coverArt(
  issueNumber: number,
  issueName: string,
  colors: string[] = paletteFor(issueNumber),
): CoverArt {
  const motif = motifFor(issueNumber)
  const d = dialsFor(hash32(`${Math.trunc(issueNumber)} ${issueName}`))
  return { motif, layers: MOTIF_LAYERS[motif](colors.slice(), d).join(', ') }
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
 * Which figure it draws is the issue's own — see `coverArt`.
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

  const colors = paletteFor(opts.issueNumber)
  const art = coverArt(opts.issueNumber, opts.issueName, colors)

  const values: Record<string, string> = {
    ART_LAYERS: art.layers,
    // Not printed — it names the figure for anyone looking at the HTML, and
    // for the tests that check consecutive issues are not drawn alike.
    ART_MOTIF: art.motif,
    // The accent picks up the first colour of this issue's rotation, so the
    // rules and the spine numeral belong to the same palette as the art.
    ACCENT: colors[0],
    PALETTE_BAND: colors.map((c) => `<span style="background:${c}"></span>`).join(''),
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
export async function composeIssue(issue: PressIssue, deps: ComposeDeps = {}): Promise<ComposeResult> {
  const settings = deps.settings ?? loadSettings()
  const db = deps.db
  const now = deps.now ?? new Date()
  const nameFn = deps.nameIssueFn ?? nameIssue

  const items = await itemsForIssue(issue.id, db)
  const { entries, skipped } = await loadEntries(items, deps)
  if (entries.length === 0) throw new Error(`press/compose: issue ${issue.number} has nothing to print`)

  for (const s of skipped) {
    await updateItem(s.item.id, { state: 'failed', failure_reason: `not composable: ${s.reason}` }, db)
  }

  // 1. Measure each article at the current template version (KTD7).
  const pageCounts: number[] = []
  for (const entry of entries) {
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

  // 2. Name the issue from what is actually in it.
  const provisionalToc = computeToc(entries, pageCounts, 0)
  const name = await nameFn({
    issueNumber: issue.number,
    toc: provisionalToc,
    apiKey: settings.anthropicApiKey,
  })

  // 3. Render the front matter to learn how long it really is, then rebuild it
  //    with the page numbers that knowledge produces.
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

  const interior = await padToEven(await mergePdfs(parts))
  const pageCount = await pdfPageCount(interior)
  const preflight = await preflightInterior(interior)

  // 5. Cover, sized to the finished interior.
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
