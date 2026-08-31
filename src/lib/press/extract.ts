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
import type { Article, ArticleBlock, ArticleImage } from './types'

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

  for (const selector of STRIP_SELECTORS) {
    for (const el of Array.from(scope.querySelectorAll(selector))) el.remove()
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

function inlineHtml(el: Element): string {
  const doc = el.ownerDocument
  const clone = el.cloneNode(true) as Element
  for (const node of Array.from(clone.querySelectorAll('*'))) {
    if (!INLINE_KEEP.has(node.tagName)) {
      // Unwrap: keep the words, drop the element.
      const parent = node.parentNode
      if (!parent) continue
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
  void doc
  return clone.innerHTML.replace(/\s+/g, ' ').trim()
}

function captionFor(figure: Element): string | null {
  const cap = figure.querySelector('figcaption')
  const text = cap ? textOf(cap) : ''
  return text || null
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
          const html = inlineHtml(child)
          if (html) blocks.push({ type: 'quote', html })
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
): RungResult | null {
  const root = contentRoot(html, url)
  if (!root) return null
  stripExternalReferences(root)
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
  }
}

export function extractWithDefuddle(html: string, url: string): RungResult | null {
  try {
    const dom = parseHtml(html, url)
    const result = new Defuddle(dom.window.document, { url }).parse()
    if (!result?.content) return null
    return buildRung(result.content, url, {
      title: result.title,
      byline: result.author,
      site: result.site || new URL(url).hostname.replace(/^www\./, ''),
      published: result.published,
      dek: result.description,
    })
  } catch (err) {
    console.warn(`press/extract: defuddle failed on ${url}: ${(err as Error).message}`)
    return null
  }
}

export function extractWithReadability(html: string, url: string): RungResult | null {
  try {
    const dom = parseHtml(html, url)
    const result = new Readability(dom.window.document).parse()
    if (!result?.content) return null
    return buildRung(result.content, url, {
      title: result.title,
      byline: result.byline,
      site: result.siteName || new URL(url).hostname.replace(/^www\./, ''),
      published: result.publishedTime ?? null,
      dek: result.excerpt ?? null,
    })
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
  try {
    html = (await fetchText(url)).text
  } catch (err) {
    // The page is unreachable, but Raindrop may have kept a copy.
    console.warn(`press/extract: fetch failed for ${url}: ${(err as Error).message}`)
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
    throw new ExtractionError(
      `no rung produced at least ${MIN_ARTICLE_CHARS} characters of article`,
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
  }
}
