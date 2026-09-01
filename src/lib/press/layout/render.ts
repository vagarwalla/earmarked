/**
 * press — magazine layout engine (U4).
 *
 * Article JSON (U3) → designed magazine pages. HTML templates plus one CSS
 * Paged Media stylesheet, rendered to PDF by the Vivliostyle CLI.
 *
 * Per KTD7 the same code path serves two jobs:
 *
 *   1. the *measurement* render at ingest — one article rendered on its own so
 *      its page count can be added to the issue total that drives the ≥100-page
 *      trigger. `renderArticle()` does this.
 *   2. the *single-pass compose* render at U5 — the whole issue rendered in one
 *      go, with a continuous page counter, the real issue number and TOC
 *      anchors read off actual page positions. U5 calls `buildArticleSection()`
 *      per item, concatenates, and hands the lot to `buildDocument()` +
 *      `renderHtml()` — one Chromium pass, one page counter.
 *
 * So the HTML-building step and the PDF step are separate exports, and the
 * Vivliostyle invocation itself is a single injectable seam (`setPdfRenderer`,
 * or `deps.render`) so unit tests never launch a browser.
 *
 * Security: everything interpolated here is attacker-influenced — it arrived
 * through the email door. Text goes through `escapeHtml`; the HTML-bearing
 * block fields go through `sanitizeRichText`, which keeps a short allowlist of
 * inline tags and drops every attribute, so no `src`/`href`/`style`/`on*` can
 * survive. The renderer must never resolve a network reference.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import {
  BLEED_PT,
  MEDIA_HEIGHT_PT,
  MEDIA_WIDTH_PT,
  type Article,
  type ArticleBlock,
  type ArticleImage,
  type RenderOptions,
  type RenderResult,
} from '../types'

// ── Page geometry ────────────────────────────────────────────────────────────
// The trim, bleed and media box live in types.ts (KTD1) and are used from
// there. What is stated here is only the typographic margin — how far the text
// block sits from the *trim* edge, which is a design decision, not a spec one.

/** Margins measured inward from the trim edge, in points. */
export const TRIM_MARGIN_PT = {
  top: 54,
  bottom: 54,
  /** Head/foot of the outside (thumb) edge. */
  outer: 54,
  /** Wider at the spine: perfect binding eats the gutter. */
  inner: 66,
} as const

/** Bottom margin reserved on full-bleed opener pages, so the folio still fits. */
const OPENER_FOOT_PT = 34

/** Name of the stylesheet as written next to the generated HTML. */
export const CSS_FILENAME = 'press.css'

/** Directory (relative to the HTML) that render assets are written into. */
export const IMAGE_DIR = 'images'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ── Escaping and sanitisation ────────────────────────────────────────────────

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Escape text for both element content and double-quoted attribute values. */
export function escapeHtml(value: string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c])
}

/**
 * Inline tags a paragraph may keep. Note what is missing: `a` (an href is a
 * network reference), `img`, `style`, `script`. Disallowed tags are dropped
 * but their text is kept, so an `<a>` becomes plain words.
 */
const ALLOWED_INLINE = new Set([
  'em',
  'i',
  'strong',
  'b',
  'code',
  'sup',
  'sub',
  'br',
  'span',
  'abbr',
  'cite',
  'q',
  'small',
  'mark',
  's',
  'u',
])

/** Elements whose *content* is dangerous or meaningless in print. */
const STRIP_WITH_CONTENT =
  /<\s*(script|style|iframe|object|embed|template|noscript|svg|math)\b[\s\S]*?<\s*\/\s*\1\s*>/gi

/**
 * Reduce extraction HTML to a safe inline subset: comments and script/style
 * subtrees removed, every remaining tag either normalised to a bare allowlisted
 * tag or dropped. All attributes are discarded, which is what makes this
 * airtight against `src=`, `href=`, `style=` and `on*=`.
 */
export function sanitizeRichText(html: string | null | undefined): string {
  if (!html) return ''
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(STRIP_WITH_CONTENT, '')
    .replace(/<[^>]*>/g, (tag) => {
      const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tag)
      if (!m) return ''
      const name = m[2].toLowerCase()
      if (!ALLOWED_INLINE.has(name)) return ''
      if (name === 'br') return '<br>'
      return m[1] ? `</${name}>` : `<${name}>`
    })
}

// ── Small formatters ─────────────────────────────────────────────────────────

/**
 * The article's canonical URL as printed at the end of the piece. The scheme
 * (and a `www.`) are dropped: they are noise on paper, and dropping them keeps
 * the guarantee that a generated document contains no `http` at all.
 */
export function formatSourceUrl(url: string | null | undefined): string {
  if (!url) return ''
  return String(url)
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '')
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
})

/** ISO date → "August 27, 2026". Unparseable input is passed through. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return DATE_FORMAT.format(d)
}

/** Clamp a caller-supplied number to a positive integer before it reaches CSS. */
function positiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const n = Math.trunc(value)
  return n >= 1 ? n : fallback
}

// ── Images ───────────────────────────────────────────────────────────────────

/**
 * Local filename for an image given its path in the `press` Storage bucket.
 * Deterministic (so the HTML can be built before the bytes are fetched) and
 * flat, with no path separators or `..` — the storage path is untrusted.
 */
export function imageFileName(storagePath: string): string {
  const base = storagePath.split('/').pop() ?? ''
  const ext = /\.([a-z0-9]{2,5})$/i.exec(base)?.[1]?.toLowerCase() ?? 'jpg'
  const stem =
    base
      .replace(/\.[^.]*$/, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'image'
  const hash = createHash('sha1').update(storagePath).digest('hex').slice(0, 12)
  return `${stem}-${hash}.${ext}`
}

/** Every image an article's HTML will reference, lead first, in document order. */
export function articleImages(article: Article): ArticleImage[] {
  const out: ArticleImage[] = []
  if (article.lead) out.push(article.lead)
  for (const block of article.blocks) {
    if (block.type === 'figure') out.push(block.image)
  }
  return out
}

/** A landscape plate is wide enough to run across both columns. */
export function isWideFigure(image: ArticleImage): boolean {
  return image.orientation === 'landscape'
}

// ── HTML building ────────────────────────────────────────────────────────────

export interface ArticleEntry {
  article: Article
  /**
   * Anchor id for the article's opener, so U5 can resolve TOC page numbers
   * from actual positions. Defaults to `article-<n>`.
   */
  id?: string
}

export interface DocumentOptions extends RenderOptions {
  /** `<title>` of the generated document. Defaults to the first article's title. */
  documentTitle?: string
  /** Drives hyphenation. Defaults to `en`. */
  lang?: string
}

let templateCache: string | null = null
let cssCache: string | null = null

/** The document shell, read from `templates/article.html`. */
export function articleTemplate(): string {
  if (templateCache === null) {
    templateCache = readFileSync(path.join(HERE, 'templates', 'article.html'), 'utf8')
  }
  return templateCache
}

/** The paged-media stylesheet, read from `press.css`. */
export function pressCss(): string {
  if (cssCache === null) {
    cssCache = readFileSync(path.join(HERE, CSS_FILENAME), 'utf8')
  }
  return cssCache
}

/** Test hook: forget the cached template/stylesheet. */
export function __resetAssetCache(): void {
  templateCache = null
  cssCache = null
}

function fill(template: string, values: Record<string, string>): string {
  // A function replacement, so `$&` and friends in the *values* stay literal.
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => values[key] ?? '')
}

/**
 * The per-render <style> block: the page box (derived from the print spec in
 * types.ts, stated nowhere else), where the page counter starts, and the
 * issue number in the folio.
 */
export function documentStyle(options: RenderOptions): string {
  const startPage = positiveInt(options.startPage, 1)
  const issueNumber = positiveInt(options.issueNumber, 1)

  const top = TRIM_MARGIN_PT.top + BLEED_PT
  const bottom = TRIM_MARGIN_PT.bottom + BLEED_PT
  const outer = TRIM_MARGIN_PT.outer + BLEED_PT
  const inner = TRIM_MARGIN_PT.inner + BLEED_PT
  const openerFoot = OPENER_FOOT_PT + BLEED_PT

  const lines = [
    '/* Page box — derived from PRINT_SPEC in src/lib/press/types.ts. */',
    `@page { size: ${MEDIA_WIDTH_PT}pt ${MEDIA_HEIGHT_PT}pt; margin: ${top}pt ${outer}pt ${bottom}pt ${inner}pt; }`,
    `@page :left { margin-left: ${outer}pt; margin-right: ${inner}pt; }`,
    `@page :right { margin-left: ${inner}pt; margin-right: ${outer}pt; }`,
    '/* Openers run full bleed; only the foot is held back for the folio. */',
    `@page opener:left { margin: 0 0 ${openerFoot}pt 0; }`,
    `@page opener:right { margin: 0 0 ${openerFoot}pt 0; }`,
    '',
    '/* Continuous numbering across a single-pass issue render (KTD7).',
    '   The reset has to hang off the first article, not the body: Vivliostyle',
    '   ignores a page-counter reset on the root, and `@page :first` lands one',
    '   page late. Whatever U5 puts first (front matter or the first article)',
    '   carries it. Verified against Chromium by scripts/press-preview.ts. */',
    `.press-doc > *:first-child { counter-reset: page ${startPage}; }`,
  ]

  if (!options.measurement) {
    lines.push(
      '',
      '/* Running footer: issue no. · page no. */',
      `@page :left { @bottom-left { content: "Issue ${issueNumber}  ·  " counter(page); } }`,
      `@page :right { @bottom-right { content: "Issue ${issueNumber}  ·  " counter(page); } }`,
      '',
      '/* Openers zero their side margins so the plate can run full bleed, which',
      '   also drops the folio into the bleed for the guillotine to take half of.',
      '   Pad the margin boxes back to where the folio sits on an ordinary page —',
      '   inset from the *trim*, not from the media edge. */',
      `@page opener:left { @bottom-left { padding-left: ${outer}pt; padding-bottom: ${BLEED_PT}pt; } }`,
      `@page opener:right { @bottom-right { padding-right: ${outer}pt; padding-bottom: ${BLEED_PT}pt; } }`,
    )
  }

  return lines.join('\n')
}

function figureHtml(image: ArticleImage): string {
  const classes = ['figure', `figure--${image.orientation}`]
  if (isWideFigure(image)) classes.push('figure--wide')
  const caption = image.caption
    ? `<figcaption>${escapeHtml(image.caption)}</figcaption>`
    : ''
  return [
    `<figure class="${classes.join(' ')}">`,
    `<img src="${IMAGE_DIR}/${escapeHtml(imageFileName(image.path))}" alt="${escapeHtml(image.alt)}">`,
    caption,
    '</figure>',
  ].join('')
}

function blockHtml(block: ArticleBlock): string {
  switch (block.type) {
    case 'heading':
      return block.level === 3
        ? `<h3>${escapeHtml(block.text)}</h3>`
        : `<h2>${escapeHtml(block.text)}</h2>`
    case 'para': {
      const body = sanitizeRichText(block.html)
      return body.trim() ? `<p>${body}</p>` : ''
    }
    case 'quote': {
      const cite = block.attribution
        ? `<cite>${escapeHtml(block.attribution)}</cite>`
        : ''
      return `<blockquote><p>${sanitizeRichText(block.html)}</p>${cite}</blockquote>`
    }
    case 'figure':
      return figureHtml(block.image)
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul'
      const items = block.items.map((i) => `<li>${sanitizeRichText(i)}</li>`).join('')
      return `<${tag} class="list">${items}</${tag}>`
    }
    case 'rule':
      return '<hr class="rule">'
  }
}

function openerHtml(article: Article, anchorId: string): string {
  const hasLead = Boolean(article.lead)
  const classes = ['opener', hasLead ? 'opener--photo' : 'opener--text']

  const figure = article.lead
    ? `<figure class="opener-figure"><img src="${IMAGE_DIR}/${escapeHtml(
        imageFileName(article.lead.path),
      )}" alt="${escapeHtml(article.lead.alt)}"></figure>`
    : ''

  const kicker = article.sourceName
    ? `<p class="kicker">${escapeHtml(article.sourceName)}</p>`
    : ''
  const flag = flagHtml(article)
  const dek = article.dek ? `<p class="dek">${escapeHtml(article.dek)}</p>` : ''

  const bylineParts: string[] = []
  if (article.byline) bylineParts.push(escapeHtml(article.byline))
  const date = formatDate(article.publishedAt)
  if (date) bylineParts.push(escapeHtml(date))
  const byline = bylineParts.length
    ? `<p class="byline">${bylineParts.join('<span class="sep">·</span>')}</p>`
    : ''

  const leadCaption = article.lead?.caption
    ? `<p class="lead-caption">${escapeHtml(article.lead.caption)}</p>`
    : ''

  return [
    `<section class="${classes.join(' ')}" id="${escapeHtml(anchorId)}">`,
    figure,
    '<div class="opener-text">',
    flag,
    kicker,
    `<h1 class="article-title">${escapeHtml(article.title)}</h1>`,
    dek,
    byline,
    leadCaption,
    '</div>',
    '</section>',
  ].join('')
}

/**
 * The line above the title that says what kind of thing this is: a linkpost,
 * or a piece that is here because one pointed at it.
 *
 * It goes above the kicker rather than inside it because it answers a different
 * question — the kicker says where a piece came from, this says why it is here —
 * and because a reader flicking through needs to see the relationship before
 * they start reading, not after.
 */
function flagHtml(article: Article): string {
  if (article.linkpost) {
    const count = article.linkpost.targets.length
    const label =
      article.linkpost.kind === 'pointer'
        ? 'Linkpost'
        : count > 0
          ? `Linkpost · ${count} piece${count === 1 ? '' : 's'} follow${count === 1 ? 's' : ''}`
          : 'Linkpost'
    return `<p class="flag">${escapeHtml(label)}</p>`
  }
  if (article.linkpostOf) {
    const title = article.linkpostOf.title?.trim()
    return title
      ? `<p class="flag flag--via">Linkpost of <span class="flag-source">${escapeHtml(title)}</span></p>`
      : '<p class="flag flag--via">Linked from a linkpost</p>'
  }
  return ''
}

/**
 * What a linkpost named, set after its own text.
 *
 * The pieces that were fetched are printed immediately after this article, so
 * this is not a table of contents — it is the roundup's own list, kept so the
 * ones that could not be fetched (paywalled, dead, a video) are still visible
 * as something that was pointed at. Addresses are printed without a scheme,
 * like every other address in the magazine, so they can be typed.
 */
function linkedHtml(article: Article): string {
  const targets = article.linkpost?.targets ?? []
  if (!targets.length) return ''
  const items = targets
    .map((t) => {
      const anchor = t.anchor?.trim() || formatSourceUrl(t.url) || t.url
      const note = t.note ? `<span class="linked-note">${escapeHtml(t.note)}</span>` : ''
      const where = formatSourceUrl(t.url)
      const host = where ? `<span class="linked-host">${escapeHtml(where)}</span>` : ''
      return `<li class="linked-item"><span class="linked-anchor">${escapeHtml(anchor)}</span>${note}${host}</li>`
    })
    .join('')
  return `<section class="linked"><h2 class="linked-head">Linked here</h2><ol class="linked-list">${items}</ol></section>`
}

/**
 * The article's notes, set after the body and before the source line. The
 * markers are the ones extraction found, not a fresh 1..n count, so they still
 * match the <sup> markers standing in the prose.
 */
function footnotesHtml(article: Article): string {
  const notes = article.footnotes ?? []
  if (!notes.length) return ''
  const items = notes
    .map(
      (n) =>
        `<li class="footnote"><span class="footnote-marker">${escapeHtml(
          n.marker,
        )}</span><span class="footnote-text">${sanitizeRichText(n.html)}</span></li>`,
    )
    .join('')
  return `<section class="footnotes"><h2 class="footnotes-head">Notes</h2><ol class="footnote-list">${items}</ol></section>`
}

function sourceLineHtml(article: Article): string {
  const parts: string[] = []
  if (article.sourceName) parts.push(escapeHtml(article.sourceName))
  const url = formatSourceUrl(article.url)
  if (url) parts.push(escapeHtml(url))
  if (!parts.length) return ''
  return `<p class="article-source"><span class="end-mark">▪</span>${parts.join(
    '<span class="sep">·</span>',
  )}</p>`
}

/**
 * One article as a self-contained `<article>` fragment. U5 concatenates these
 * for the single-pass issue render; `buildDocument()` wraps them.
 */
export function buildArticleSection(entry: ArticleEntry, index = 0): string {
  const { article } = entry
  const anchorId = entry.id ?? `article-${index + 1}`
  const blocks = article.blocks.map(blockHtml).filter(Boolean).join('\n')
  return [
    `<article class="article" data-index="${index + 1}">`,
    openerHtml(article, anchorId),
    '<div class="article-body">',
    blocks,
    linkedHtml(article),
    footnotesHtml(article),
    sourceLineHtml(article),
    '</div>',
    '</article>',
  ].join('\n')
}

/** Wrap already-built article sections in the document shell. */
export function buildDocument(sections: string | string[], options: DocumentOptions): string {
  const body = Array.isArray(sections) ? sections.join('\n') : sections
  return fill(articleTemplate(), {
    LANG: escapeHtml(options.lang ?? 'en'),
    DOC_TITLE: escapeHtml(options.documentTitle ?? 'press'),
    RENDER_STYLE: documentStyle(options),
    ARTICLES: body,
    ISSUE_NUMBER: String(positiveInt(options.issueNumber, 1)),
    START_PAGE: String(positiveInt(options.startPage, 1)),
    MEASUREMENT: options.measurement ? 'true' : 'false',
  })
}

/** Articles → a complete, standalone HTML document ready for the renderer. */
export function buildIssueHtml(entries: ArticleEntry[], options: DocumentOptions): string {
  const sections = entries.map((entry, i) => buildArticleSection(entry, i))
  return buildDocument(sections, {
    ...options,
    documentTitle: options.documentTitle ?? entries[0]?.article.title ?? 'press',
  })
}

/** One article → a complete HTML document. */
export function buildArticleHtml(article: Article, options: DocumentOptions): string {
  return buildIssueHtml([{ article }], options)
}

// ── The render seam ──────────────────────────────────────────────────────────
// Vivliostyle needs Chromium and a scratch directory. Everything above this
// line is pure string work; everything below goes through one function that
// tests replace.

export interface RenderJob {
  /** Complete HTML document; written as `index.html`. */
  html: string
  /** Written next to it as `press.css`. */
  css: string
  /** Local filename (see `imageFileName`) → bytes, written into `images/`. */
  images: Map<string, Uint8Array>
}

export type PdfRenderer = (job: RenderJob) => Promise<Uint8Array>

let injectedRenderer: PdfRenderer | null = null

/** Swap the PDF renderer. Pass null to restore the Vivliostyle CLI. */
export function setPdfRenderer(renderer: PdfRenderer | null): void {
  injectedRenderer = renderer
}

async function resolveRenderer(override?: PdfRenderer): Promise<PdfRenderer> {
  if (override) return override
  if (injectedRenderer) return injectedRenderer
  // Imported lazily so that merely importing this module — as every unit test
  // does — never pulls in the CLI or looks for a browser.
  const mod = await import('./vivliostyle')
  return mod.vivliostyleRenderer
}

export interface RenderDeps {
  /** Replaces the Vivliostyle CLI for this call. */
  render?: PdfRenderer
  /** Replaces Supabase Storage for this call. */
  loadImage?: (storagePath: string) => Promise<Uint8Array>
}

/** Page count of a rendered PDF, read from the file rather than guessed. */
export async function pdfPageCount(pdf: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false })
  return doc.getPageCount()
}

/**
 * Fetch the bytes for every referenced image, keyed by local filename.
 * Throws if one is missing: a silently absent plate would print as a hole.
 */
export async function loadImages(
  images: ArticleImage[],
  loadImage?: (storagePath: string) => Promise<Uint8Array>,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>()
  if (!images.length) return out
  const load = loadImage ?? (await import('../db')).getObject
  for (const image of images) {
    const name = imageFileName(image.path)
    if (out.has(name)) continue
    out.set(name, await load(image.path))
  }
  return out
}

/** Render a prepared document to PDF and report its true page count. */
export async function renderHtml(
  html: string,
  images: Map<string, Uint8Array> = new Map(),
  deps: RenderDeps = {},
): Promise<RenderResult> {
  const render = await resolveRenderer(deps.render)
  const pdf = await render({ html, css: pressCss(), images })
  return { pdf, pageCount: await pdfPageCount(pdf) }
}

/**
 * One article → its PDF fragment and page count. This is the ingest-time
 * measurement render (KTD7); pass `measurement: true` to drop the furniture
 * that only makes sense once the piece has an issue to belong to.
 */
export async function renderArticle(
  article: Article,
  options: RenderOptions,
  deps: RenderDeps = {},
): Promise<RenderResult> {
  const html = buildArticleHtml(article, options)
  const images = await loadImages(articleImages(article), deps.loadImage)
  return renderHtml(html, images, deps)
}

/**
 * Many articles → one PDF, rendered in a single Vivliostyle pass with one
 * continuous page counter. U5's compose step.
 */
export async function renderArticles(
  entries: ArticleEntry[],
  options: DocumentOptions,
  deps: RenderDeps = {},
): Promise<RenderResult> {
  const html = buildIssueHtml(entries, options)
  const all = entries.flatMap((e) => articleImages(e.article))
  const images = await loadImages(all, deps.loadImage)
  return renderHtml(html, images, deps)
}
