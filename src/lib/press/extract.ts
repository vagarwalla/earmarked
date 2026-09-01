/**
 * press — extraction and normalization (U3, KTD3).
 *
 * From a URL or a newsletter's HTML to the `Article` shape U4 lays out.
 *
 * The ladder, in order:
 *   1. defuddle    — multi-pass, strongest on messy pages
 *   2. Readability — conservative cross-check when defuddle comes back thin
 *   3. Raindrop's permanent copy — a server-side snapshot of the page, for
 *      hostile sites that will not serve the worker (Pro only, best effort)
 *
 * Newsletters skip the ladder entirely: the delivered email *is* the source.
 *
 * Everything here ends in a document with no external references at all. The
 * renderer runs Chromium over this output, so a surviving `https://` in a
 * background-image or an `@import` would be a live network call — and the
 * input arrived through a public email address.
 */

import { JSDOM, VirtualConsole } from 'jsdom'
import { Readability } from '@mozilla/readability'
import Defuddle from 'defuddle'
import { safeFetchText } from './fetch'
import { fetchAndStoreImages, type CandidateImage, type StoredImage } from './images'
import type { Article, ArticleBlock, ArticleFootnote, ArticleImage } from './types'

export type ExtractionRung = 'defuddle' | 'readability' | 'raindrop-cache' | 'newsletter'

export class ExtractionError extends Error {
  constructor(message: string, readonly attempted: ExtractionRung[]) {
    super(message)
    this.name = 'ExtractionError'
  }
}

/** Below this an extraction is a nav bar and a cookie banner, not an article. */
export const MIN_ARTICLE_CHARS = 600

// ── DOM helpers ──────────────────────────────────────────────────────────────

/** jsdom with scripts and remote resources off, and its console silenced. */
export function parseHtml(html: string, url?: string): JSDOM {
  const virtualConsole = new VirtualConsole()
  // Publisher CSS produces a torrent of parse errors nobody will ever read.
  virtualConsole.on('jsdomError', () => {})
  return new JSDOM(html, {
    url: url && /^https?:/.test(url) ? url : 'https://press.invalid/',
    contentType: 'text/html',
    virtualConsole,
  })
}

/** Elements that are never content and may carry network references. */
const STRIP_SELECTORS = [
  'script',
  'style',
  'link',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'source',
  'svg',
  'canvas',
  'form',
  'input',
  'button',
  'noscript',
  'template',
]

/**
 * Comment threads. A forum post and its replies are one page to the extractor,
 * and the replies can be several times the length of the piece — an EA Forum
 * post came through as 24 printed pages, 19 of them other people's comments.
 * Nobody saved the link for the comments, and they are expensive in print.
 */
const COMMENT_SELECTORS = [
  '#comments',
  '#comment',
  '#disqus_thread',
  '[class~="comments"]',
  '[class~="comment"]',
  // Real comment markup is hyphenated or camelCased far more often than it is
  // a bare `comment` class: the EA Forum wraps replies in `comment-body` and
  // `bg-comment-even`, and neither `.comment` nor `.comments` touches those.
  // Anchoring on the separator keeps this off words like "commentary".
  '[class*="comment-"]',
  '[class*="-comment"]',
  '[class*="comment_"]',
  '[class*="Comment"]',
  '[id*="comment-"]',
  '[data-testid*="omment"]',
  '.giscus',
  '.utterances',
  'section[aria-label*="omment"]',
]

/** Newsletter chrome: the unsubscribe footer, the "view in browser" line, the share row. */
const NEWSLETTER_CRUFT = [
  /unsubscribe/i,
  /view (?:this )?(?:post|email|newsletter)? ?in (?:your )?browser/i,
  /^\s*(?:share|tweet|forward|like|comment|restack)\s*$/i,
  /update your profile/i,
  /you(?:'|’)?re receiving this/i,
  /©\s*\d{4}\s/,
  /^\s*sent to\s+\S+@\S+/i,
]

/** querySelectorAll that cannot take an extraction down over one bad selector. */
function safeQueryAll(scope: Element | Document, selector: string): Element[] {
  try {
    return Array.from(scope.querySelectorAll(selector))
  } catch {
    return []
  }
}

/**
 * Drop comment threads before either extractor chooses what the article is.
 *
 * This has to happen on the raw document, not on the extracted output: both
 * defuddle and Readability unwrap and re-wrap markup as they go, so by the
 * time we see their result the `<div class="CommentsList…">` is gone and its
 * paragraphs are indistinguishable from the article's own. Worse, a long
 * thread is a large block of prose, so leaving it in makes the extractors
 * *more* confident they have found the content.
 */
export function stripCommentSections(doc: Document): void {
  for (const selector of COMMENT_SELECTORS) {
    for (const el of safeQueryAll(doc, selector)) el.remove()
  }
}

/**
 * Remove every reference that would make the renderer touch the network, and
 * every attribute that could carry one. Mutates `root` in place.
 *
 * This is deliberately an allowlist on attributes: new HTML attributes that
 * fetch things keep being invented, and the renderer must be safe against the
 * ones that do not exist yet.
 */
export function stripExternalReferences(root: Element | Document): void {
  const doc = 'ownerDocument' in root && root.ownerDocument ? root.ownerDocument : (root as Document)
  const scope = 'querySelectorAll' in root ? root : doc

  for (const selector of [...STRIP_SELECTORS, ...COMMENT_SELECTORS]) {
    for (const el of safeQueryAll(scope, selector)) el.remove()
  }

  // Attributes worth keeping, per tag. Everything else goes.
  const KEEP: Record<string, readonly string[]> = {
    img: ['src', 'alt'],
    a: ['href'],
    blockquote: ['cite'],
    figure: [],
    figcaption: [],
  }

  for (const el of Array.from(scope.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase()
    const keep = KEEP[tag] ?? []
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (!keep.includes(name)) {
        el.removeAttribute(attr.name)
        continue
      }
      // A kept attribute can still smuggle a fetch: javascript:, data: URLs.
      if ((name === 'src' || name === 'href' || name === 'cite') && !/^https?:\/\//i.test(attr.value)) {
        if (!attr.value.startsWith('/') && !/^[\w.-]+\//.test(attr.value)) {
          el.removeAttribute(attr.name)
        }
      }
    }
  }
}

/**
 * True when `html` still contains something the renderer could fetch.
 * Used as a hard assertion in tests and as a last guard before layout.
 */
export function hasExternalReferences(html: string): boolean {
  if (/@import/i.test(html)) return true
  if (/@font-face/i.test(html)) return true
  if (/url\(\s*['"]?(?:https?:)?\/\//i.test(html)) return true
  if (/\b(?:src|href|srcset|poster|background|data|action)\s*=\s*['"]?(?:https?:)?\/\//i.test(html)) return true
  return false
}

// ── Block normalization ──────────────────────────────────────────────────────

function textOf(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** Inline markup we keep inside a paragraph; everything else is flattened to text. */
const INLINE_KEEP = new Set(['EM', 'I', 'STRONG', 'B', 'A', 'CODE', 'SUP', 'SUB', 'BR'])

/**
 * Elements whose contents are separate lines in the source. Unwrapping one
 * without putting a space back fuses the words either side of it — a
 * blockquote holding `<p>…God.</p><cite>Hildegard</cite>` renders as
 * "God.Hildegard", which is visible in print and easy to miss in a diff.
 */
const BLOCK_LEVEL = new Set([
  'P', 'DIV', 'SECTION', 'ASIDE', 'FOOTER', 'HEADER', 'CITE', 'LI', 'UL', 'OL',
  'BLOCKQUOTE', 'FIGCAPTION', 'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
])

function inlineHtml(el: Element): string {
  const doc = el.ownerDocument
  const clone = el.cloneNode(true) as Element
  for (const node of Array.from(clone.querySelectorAll('*'))) {
    if (!INLINE_KEEP.has(node.tagName)) {
      // Unwrap: keep the words, drop the element.
      const parent = node.parentNode
      if (!parent) continue
      if (BLOCK_LEVEL.has(node.tagName)) {
        parent.insertBefore(doc.createTextNode(' '), node)
      }
      while (node.firstChild) parent.insertBefore(node.firstChild, node)
      parent.removeChild(node)
    } else if (node.tagName === 'A') {
      // Print cannot follow a link; keep the words, lose the href.
      const parent = node.parentNode
      if (!parent) continue
      while (node.firstChild) parent.insertBefore(node.firstChild, node)
      parent.removeChild(node)
    }
  }
  return clone.innerHTML.replace(/\s+/g, ' ').trim()
}

function captionFor(figure: Element): string | null {
  const cap = figure.querySelector('figcaption')
  const text = cap ? textOf(cap) : ''
  return text || null
}

// ── Footnotes ────────────────────────────────────────────────────────────────
// The body keeps its <sup> markers (SUP is in INLINE_KEEP), so an article whose
// notes are thrown away prints orphan superscripts pointing at nothing. Every
// publisher marks its apparatus up differently, so the notes are found here and
// removed from the tree *before* toBlocks walks it — otherwise they also come
// out the far end as unnumbered paragraphs, which is what used to happen.

/**
 * Containers that hold a whole apparatus, or one note of it. Publishers split
 * roughly into two vocabularies — "footnote" (Substack, Pandoc, WordPress, the
 * EA Forum) and "reference" (joecarlsmith.com and other bespoke essay themes) —
 * so both are matched. The `reference` half is kept narrow, to `*-item` and
 * `reference-item*`, because a bare "reference" class is used for all sorts of
 * things that are not notes.
 */
const FOOTNOTE_CONTAINER =
  '[class*="footnote" i], [id*="footnote" i], [data-component-name*="footnote" i], ' +
  'ol.footnotes, section.footnotes, #footnotes, ' +
  '[class*="references-item" i], [class*="reference-item" i], [id^="reference-item" i], ' +
  '[class*="endnote" i]'

/** Elements holding a note's own number, rather than its text. */
const MARKER_ELEMENT =
  '[class*="footnote-number" i], [class*="footnote_number" i], ' +
  '[class*="reference__index" i], [class*="reference-index" i]'

/** Elements holding a note's text, when the source separates the two. */
const NOTE_BODY = '[class*="reference__text" i], [class*="footnote-content" i], [class*="footnote_content" i]'

/** Headings that introduce one, for sources that mark the section no other way. */
const NOTES_HEADING = /^(foot ?notes?|notes|references|endnotes)\s*:?$/i

/** Trailing back-to-text link, which is navigation and meaningless on paper. */
const BACKLINK = /\s*(?:↩︎?️?|↑|\^|back|return(?: to text)?)\s*$/i

/** Digits at the end of an id like `fn3`, `fn:3`, `footnote-3`. */
function markerFromId(el: Element): string | null {
  const id = el.getAttribute('id') ?? ''
  const m = /(\d+)\s*$/.exec(id)
  return m ? m[1] : null
}

/**
 * The number a note is labelled with. Publishers put it in a dedicated element
 * (Substack), in the id (Pandoc, WordPress), or nowhere at all — in which case
 * the position in the list is the only thing left.
 */
function footnoteMarker(el: Element, index: number): string {
  const labelled = el.querySelector(MARKER_ELEMENT)
  const label = labelled ? textOf(labelled).replace(/[^\w*†‡]/g, '') : ''
  if (label) return label
  // A bare leading link whose whole text is a number is the marker too.
  const first = el.querySelector('a')
  const asNumber = first ? textOf(first) : ''
  if (/^\d{1,4}$/.test(asNumber)) return asNumber
  return markerFromId(el) ?? String(index + 1)
}

/** The note's own text, with its back-link and repeated leading number removed. */
function footnoteBody(el: Element, marker: string): string {
  const clone = el.cloneNode(true) as Element
  for (const strip of Array.from(
    clone.querySelectorAll(`${MARKER_ELEMENT}, [class*="footnote-anchor" i]`),
  )) {
    strip.remove()
  }
  // Nested *notes* belong to themselves; without this an outer note prints its
  // own text followed by every note nested under it. Note *parts* — the text
  // wrapper especially — have to stay, or there is nothing left to print.
  for (const nested of safeQueryAll(clone, FOOTNOTE_CONTAINER)) {
    if (looksLikeOneNote(nested)) nested.remove()
  }
  // When the source separates number from text, take only the text — otherwise
  // the whole item, which is the common case.
  const body = clone.querySelector(NOTE_BODY) ?? clone
  let html = inlineHtml(body).replace(BACKLINK, '')
  // Some sources repeat the marker as the first characters of the note text.
  html = html.replace(new RegExp(`^\\s*${marker}\\s*[.)\\]]?\\s*`), '')
  return html.trim()
}

/**
 * A structural *part* of a note — its number, its text wrapper, its back-link.
 * These match the container selector too (they are all named after footnotes),
 * but treating one as a note in its own right splits a note in half.
 */
function isNotePart(el: Element): boolean {
  const cls = (el.getAttribute('class') ?? '').toLowerCase()
  return /(footnote|reference|endnote)[-_]{0,2}(content|text|number|index|anchor|marker|label|backlink)/.test(
    cls,
  )
}

/** Is this element one note, rather than the container holding all of them? */
function looksLikeOneNote(el: Element): boolean {
  if (isNotePart(el)) return false
  const id = (el.getAttribute('id') ?? '').toLowerCase()
  const cls = (el.getAttribute('class') ?? '').toLowerCase()
  if (el.tagName === 'LI') return true
  if (/(^|[^a-z])(fn|footnote|reference)[-_:]?item?[-_:]?\d*/.test(id)) return true
  return (
    /footnote(?![-_]?(s|list|section))/.test(cls) ||
    /references?[-_]item/.test(cls) ||
    /endnote/.test(cls)
  )
}

/**
 * Pull the footnote apparatus out of `root`, removing it from the tree.
 *
 * Returns the notes in document order. Markers are kept as the source wrote
 * them rather than renumbered, so they still match the `<sup>` markers left
 * behind in the body.
 */
export function extractFootnotes(root: Element): ArticleFootnote[] {
  const matches = safeQueryAll(root, FOOTNOTE_CONTAINER)

  if (matches.length) {
    // Some themes lay the apparatus out as a grid and the parse nests one note
    // inside another. Every note therefore has to be read *before* anything is
    // removed: taking the outermost out first disconnects the rest, which is
    // how a 58-note essay came out with 23.
    const outermost = matches.filter((m) => !matches.some((o) => o !== m && o.contains(m)))

    const notes: ArticleFootnote[] = []
    for (const container of outermost) {
      const lis = safeQueryAll(container, 'li')
      if (lis.length) {
        pushNotes(notes, lis)
        continue
      }
      // The container itself may be a note, and so may anything nested in it.
      const candidates = [container, ...safeQueryAll(container, FOOTNOTE_CONTAINER)].filter(
        looksLikeOneNote,
      )
      pushNotes(notes, candidates)
    }
    for (const container of outermost) container.remove()
    if (notes.length) return notes
  }

  // A "Notes" heading followed by an ordered list, for sources that mark the
  // apparatus no other way (the EA Forum does exactly this).
  for (const heading of safeQueryAll(root, 'h1, h2, h3, h4, h5, h6')) {
    if (!NOTES_HEADING.test(textOf(heading))) continue
    const list = heading.nextElementSibling
    if (!list || list.tagName !== 'OL') continue
    const notes: ArticleFootnote[] = []
    pushNotes(notes, safeQueryAll(list, ':scope > li'))
    heading.remove()
    list.remove()
    return notes
  }

  return []
}

/** Read a run of note elements into `notes`, skipping any that come out empty. */
function pushNotes(notes: ArticleFootnote[], items: Element[]): void {
  // Captured before the loop: `notes.length` grows as notes are pushed, so
  // reading it inside would skip a number on every positional fallback.
  const base = notes.length
  for (const [i, item] of items.entries()) {
    const marker = footnoteMarker(item, base + i)
    const html = footnoteBody(item, marker)
    if (html) notes.push({ marker, html })
  }
}

/**
 * Walk the extracted content into the small block vocabulary U4 renders.
 * Images are collected as candidates here and resolved to local paths later,
 * because downloading is IO and this walk is not.
 */
export function toBlocks(root: Element): { blocks: ArticleBlock[]; images: CandidateImage[] } {
  const blocks: ArticleBlock[] = []
  const images: CandidateImage[] = []
  const seenImages = new Set<string>()

  const pushImage = (img: Element, caption: string | null): number | null => {
    const src = img.getAttribute('src') ?? ''
    if (!/^https?:\/\//i.test(src) || seenImages.has(src)) return null
    seenImages.add(src)
    images.push({ url: src, alt: img.getAttribute('alt') || null, caption })
    return images.length - 1
  }

  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase()
      switch (tag) {
        case 'h1':
        case 'h2':
          if (textOf(child)) blocks.push({ type: 'heading', level: 2, text: textOf(child) })
          break
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6':
          if (textOf(child)) blocks.push({ type: 'heading', level: 3, text: textOf(child) })
          break
        case 'p': {
          const html = inlineHtml(child)
          // A paragraph that is only an image is a figure with no caption.
          const img = child.querySelector('img')
          if (img && !textOf(child)) {
            const idx = pushImage(img, null)
            if (idx !== null) blocks.push({ type: 'figure', image: placeholderImage(idx) })
            break
          }
          if (html) blocks.push({ type: 'para', html })
          break
        }
        case 'blockquote': {
          // A quotation's source usually sits in its own <cite> or <footer>.
          // Lifted out here so the layout can set it as an attribution line
          // rather than running it on as part of the quotation.
          const source = child.querySelector('cite, footer')
          const attribution = source ? textOf(source) : ''
          if (source) source.remove()
          const html = inlineHtml(child)
          if (html) blocks.push({ type: 'quote', html, ...(attribution ? { attribution } : {}) })
          break
        }
        case 'figure': {
          const img = child.querySelector('img')
          if (img) {
            const idx = pushImage(img, captionFor(child))
            if (idx !== null) blocks.push({ type: 'figure', image: placeholderImage(idx) })
          }
          break
        }
        case 'img': {
          const idx = pushImage(child, null)
          if (idx !== null) blocks.push({ type: 'figure', image: placeholderImage(idx) })
          break
        }
        case 'ul':
        case 'ol': {
          const items = Array.from(child.querySelectorAll(':scope > li'))
            .map((li) => inlineHtml(li))
            .filter(Boolean)
          if (items.length) blocks.push({ type: 'list', ordered: tag === 'ol', items })
          break
        }
        case 'hr':
          blocks.push({ type: 'rule' })
          break
        default:
          walk(child)
      }
    }
  }

  walk(root)
  return { blocks, images: images }
}

/**
 * A figure block needs an `ArticleImage`, but the real one only exists after
 * the download. We park the candidate's index in `path` and swap it out in
 * `attachImages`.
 */
function placeholderImage(index: number): ArticleImage {
  return { path: `#candidate-${index}`, alt: null, caption: null, width: null, height: null, orientation: 'landscape' }
}

/** Replace placeholder figures with stored images, dropping the ones that did not survive. */
export function attachImages(blocks: ArticleBlock[], stored: (StoredImage | null)[]): ArticleBlock[] {
  const out: ArticleBlock[] = []
  for (const block of blocks) {
    if (block.type !== 'figure') {
      out.push(block)
      continue
    }
    const match = /^#candidate-(\d+)$/.exec(block.image.path)
    if (!match) {
      out.push(block)
      continue
    }
    const image = stored[Number(match[1])]
    if (image) out.push({ type: 'figure', image })
  }
  return out
}

function stripNewsletterCruft(blocks: ArticleBlock[]): ArticleBlock[] {
  return blocks.filter((b) => {
    const text =
      b.type === 'para' || b.type === 'quote' ? b.html : b.type === 'heading' ? b.text : ''
    if (!text) return true
    const plain = text.replace(/<[^>]*>/g, ' ')
    return !NEWSLETTER_CRUFT.some((re) => re.test(plain))
  })
}

/** Total printable characters, used to judge whether a rung produced an article. */
export function articleLength(blocks: ArticleBlock[]): number {
  return blocks.reduce((n, b) => {
    if (b.type === 'para' || b.type === 'quote') return n + b.html.replace(/<[^>]*>/g, '').length
    if (b.type === 'heading') return n + b.text.length
    if (b.type === 'list') return n + b.items.join(' ').length
    return n
  }, 0)
}

// ── The rungs ────────────────────────────────────────────────────────────────

interface RungResult {
  title: string
  byline: string | null
  sourceName: string | null
  publishedAt: string | null
  dek: string | null
  blocks: ArticleBlock[]
  images: CandidateImage[]
  footnotes: ArticleFootnote[]
}

function contentRoot(html: string, url: string): Element | null {
  const dom = parseHtml(`<div id="press-root">${html}</div>`, url)
  return dom.window.document.getElementById('press-root')
}

function buildRung(
  html: string,
  url: string,
  meta: {
    title?: string | null
    byline?: string | null
    site?: string | null
    published?: string | null
    dek?: string | null
  },
  /**
   * Notes already lifted from the *original* document. The readability pass
   * flattens a footnote apparatus into unlabelled paragraphs, so by the time
   * its output reaches here there is usually nothing left to recognise — the
   * caller has to look before it runs. Scanning here too is the fallback for a
   * source that survived the pass with its markup intact.
   */
  footnotesFromSource: ArticleFootnote[] = [],
): RungResult | null {
  const root = contentRoot(html, url)
  if (!root) return null
  stripExternalReferences(root)
  // Still run here: whatever this finds has to leave the tree either way, or
  // toBlocks walks it into paragraphs at the end of the piece as well.
  const alsoHere = extractFootnotes(root)
  const footnotes = footnotesFromSource.length ? footnotesFromSource : alsoHere
  const { blocks, images } = toBlocks(root)
  if (articleLength(blocks) < MIN_ARTICLE_CHARS) return null
  return {
    title: meta.title?.trim() || 'Untitled',
    byline: meta.byline?.trim() || null,
    sourceName: meta.site?.trim() || null,
    publishedAt: meta.published || null,
    dek: meta.dek?.trim() || null,
    blocks,
    images,
    footnotes,
  }
}

export function extractWithDefuddle(html: string, url: string): RungResult | null {
  try {
    const dom = parseHtml(html, url)
    stripCommentSections(dom.window.document)
    // Lifted from the source document, before Defuddle rewrites it: Defuddle
    // keeps the note text but throws away the container, the ids and the
    // numbers, which is everything that makes a note a note.
    const footnotes = extractFootnotes(dom.window.document.body)
    const result = new Defuddle(dom.window.document, { url }).parse()
    if (!result?.content) return null
    return buildRung(
      result.content,
      url,
      {
        title: result.title,
        byline: result.author,
        site: result.site || new URL(url).hostname.replace(/^www\./, ''),
        published: result.published,
        dek: result.description,
      },
      footnotes,
    )
  } catch (err) {
    console.warn(`press/extract: defuddle failed on ${url}: ${(err as Error).message}`)
    return null
  }
}

export function extractWithReadability(html: string, url: string): RungResult | null {
  try {
    const dom = parseHtml(html, url)
    stripCommentSections(dom.window.document)
    // As in the Defuddle rung: read the apparatus off the source document,
    // because Readability strips it out of its own output entirely.
    const footnotes = extractFootnotes(dom.window.document.body)
    // Readability mutates the document it is given, so hand it a fresh parse
    // rather than the one the notes were just removed from.
    const result = new Readability(parseHtml(html, url).window.document).parse()
    if (!result?.content) return null
    return buildRung(
      result.content,
      url,
      {
        title: result.title,
        byline: result.byline,
        site: result.siteName || new URL(url).hostname.replace(/^www\./, ''),
        published: result.publishedTime ?? null,
        dek: result.excerpt ?? null,
      },
      footnotes,
    )
  } catch (err) {
    console.warn(`press/extract: readability failed on ${url}: ${(err as Error).message}`)
    return null
  }
}

// ── Entry points ─────────────────────────────────────────────────────────────

export interface ExtractDeps {
  fetchText?: typeof safeFetchText
  storeImages?: typeof fetchAndStoreImages
  /** Raindrop's permanent copy of the page (KTD3 rung 3). Best effort. */
  fetchRaindropCache?: (raindropId: string) => Promise<string | null>
}

export interface ExtractOptions {
  itemId: string
  url: string
  raindropId?: string | null
  deps?: ExtractDeps
}

export interface ExtractedArticle {
  article: Article
  rung: ExtractionRung
}

/**
 * Run the ladder over a URL. Throws `ExtractionError` when every rung comes
 * back short — the caller marks the item `failed` with the reason, which
 * surfaces in the weekly digest (U7) instead of vanishing.
 */
export async function extractFromUrl(opts: ExtractOptions): Promise<ExtractedArticle> {
  const { itemId, url, raindropId } = opts
  const fetchText = opts.deps?.fetchText ?? safeFetchText
  const storeImages = opts.deps?.storeImages ?? fetchAndStoreImages

  const attempted: ExtractionRung[] = []
  let html = ''
  /** Why the live fetch failed, kept so the digest can say something useful. */
  let fetchFailure: string | null = null
  try {
    const response = await fetchText(url)
    // A dead link must not become pages. Substack, and most publishers, answer
    // a missing post with a full soft-404 — their publication homepage, served
    // under a 404 status. It extracts perfectly well, which is the danger: the
    // ladder would hand back several pages of someone's archive index as if it
    // were the saved article, and nothing downstream would notice until it was
    // printed. The status line is the only reliable signal that this happened.
    if (response.status >= 400) {
      throw new ExtractionError(`fetch returned HTTP ${response.status}`, [])
    }
    html = response.text
  } catch (err) {
    // Unreachable or refused, but Raindrop may have kept a copy from when it
    // still worked — which is exactly the case the cache rung exists for.
    fetchFailure = (err as Error).message
    console.warn(`press/extract: fetch failed for ${url}: ${fetchFailure}`)
  }

  let result: RungResult | null = null
  let rung: ExtractionRung = 'defuddle'

  if (html) {
    attempted.push('defuddle')
    result = extractWithDefuddle(html, url)
    if (!result) {
      attempted.push('readability')
      result = extractWithReadability(html, url)
      if (result) rung = 'readability'
    }
  }

  if (!result && raindropId && opts.deps?.fetchRaindropCache) {
    attempted.push('raindrop-cache')
    try {
      const cached = await opts.deps.fetchRaindropCache(raindropId)
      if (cached) {
        result = extractWithDefuddle(cached, url) ?? extractWithReadability(cached, url)
        if (result) rung = 'raindrop-cache'
      }
    } catch (err) {
      console.warn(`press/extract: raindrop cache failed for ${url}: ${(err as Error).message}`)
    }
  }

  if (!result) {
    // "HTTP 404" is something the weekly digest can act on; "no rung produced"
    // is not, so the fetch failure wins when there was one.
    throw new ExtractionError(
      fetchFailure ?? `no rung produced at least ${MIN_ARTICLE_CHARS} characters of article`,
      attempted,
    )
  }

  const article = await finish(itemId, url, result, storeImages)
  return { article, rung }
}

/**
 * Newsletters skip the ladder: the delivered email carries the full text,
 * including for paid posts, which is the whole reason for the email door.
 */
export async function extractFromNewsletterHtml(
  opts: Omit<ExtractOptions, 'url'> & { html: string; url?: string | null; senderName?: string | null },
): Promise<ExtractedArticle> {
  const storeImages = opts.deps?.storeImages ?? fetchAndStoreImages
  const url = opts.url ?? ''
  const dom = parseHtml(opts.html, url || undefined)
  const doc = dom.window.document

  const title =
    doc.querySelector('h1')?.textContent?.trim() ||
    doc.title?.trim() ||
    'Untitled'

  const root = doc.body
  stripExternalReferences(root)
  const footnotes = extractFootnotes(root)
  const { blocks, images } = toBlocks(root)
  const cleaned = stripNewsletterCruft(blocks)

  if (articleLength(cleaned) < MIN_ARTICLE_CHARS) {
    throw new ExtractionError('newsletter body was too short to print', ['newsletter'])
  }

  // The <h1> becomes the title; drop it from the body so it is not printed twice.
  const body = cleaned.filter(
    (b, i) => !(i < 3 && b.type === 'heading' && b.text.trim() === title.trim()),
  )

  const article = await finish(
    opts.itemId,
    url,
    {
      title,
      byline: null,
      sourceName: opts.senderName ?? null,
      publishedAt: null,
      dek: null,
      blocks: body,
      images,
      footnotes,
    },
    storeImages,
  )
  return { article, rung: 'newsletter' }
}

async function finish(
  itemId: string,
  url: string,
  result: RungResult,
  storeImages: typeof fetchAndStoreImages,
): Promise<Article> {
  const stored = await storeImages(itemId, result.images)

  // fetchAndStoreImages drops what did not survive, so re-align by source URL.
  const byUrl = new Map(stored.map((s) => [s.sourceUrl, s]))
  const aligned = result.images.map((c) => byUrl.get(c.url) ?? null)

  const blocks = attachImages(result.blocks, aligned)

  // The first landscape figure becomes the opener's lead image (U4).
  let lead: ArticleImage | null = null
  const leadIndex = blocks.findIndex((b) => b.type === 'figure' && b.image.orientation !== 'portrait')
  if (leadIndex !== -1) {
    const block = blocks[leadIndex] as Extract<ArticleBlock, { type: 'figure' }>
    lead = block.image
    blocks.splice(leadIndex, 1)
  }

  return {
    title: result.title,
    byline: result.byline,
    sourceName: result.sourceName,
    url: url || null,
    publishedAt: result.publishedAt,
    dek: result.dek,
    lead,
    blocks,
    footnotes: result.footnotes,
  }
}
