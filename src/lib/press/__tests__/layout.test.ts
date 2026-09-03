import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import {
  buildArticleHtml,
  buildArticleSection,
  buildIssueHtml,
  articleImages,
  documentStyle,
  escapeHtml,
  formatSourceUrl,
  imageFileName,
  isWideFigure,
  loadImages,
  pdfPageCount,
  pressCss,
  renderArticle,
  renderArticles,
  renderHtml,
  sanitizeRichText,
  setPdfRenderer,
  TRIM_MARGIN_PT,
  type PdfRenderer,
  type RenderJob,
} from '../layout/render'
import {
  BLEED_PT,
  MEDIA_HEIGHT_PT,
  MEDIA_WIDTH_PT,
  type Article,
  type ArticleBlock,
  type ArticleImage,
} from '../types'

// ── Fixtures ─────────────────────────────────────────────────────────────────

function image(over: Partial<ArticleImage> = {}): ArticleImage {
  return {
    path: 'items/abc/images/plate.jpg',
    alt: 'A plate',
    caption: 'A caption.',
    width: 1600,
    height: 900,
    orientation: 'landscape',
    ...over,
  }
}

function article(over: Partial<Article> = {}): Article {
  return {
    title: 'The Long Way Round',
    byline: 'By A. Writer',
    sourceName: 'The Atlantic',
    url: 'https://www.theatlantic.com/magazine/the-long-way-round/',
    publishedAt: '2026-03-14T09:00:00.000Z',
    dek: 'A standfirst that explains the piece in one breath.',
    lead: null,
    blocks: [
      { type: 'para', html: 'First paragraph of the body copy.' },
      { type: 'heading', level: 2, text: 'A section' },
      { type: 'para', html: 'Second paragraph, with <em>emphasis</em>.' },
    ],
    ...over,
  }
}

function paragraphs(n: number): ArticleBlock[] {
  const blocks: ArticleBlock[] = []
  for (let i = 0; i < n; i++) {
    if (i % 8 === 0) blocks.push({ type: 'heading', level: 2, text: `Section ${i / 8 + 1}` })
    blocks.push({
      type: 'para',
      html: `Paragraph ${i + 1}. ${'Words that fill a column and then some. '.repeat(12)}`,
    })
  }
  return blocks
}

/** A renderer that produces a real, valid PDF of `pages` pages at media size. */
function stubRenderer(pages: number): { render: PdfRenderer; jobs: RenderJob[] } {
  const jobs: RenderJob[] = []
  const render: PdfRenderer = async (job) => {
    jobs.push(job)
    const doc = await PDFDocument.create()
    for (let i = 0; i < pages; i++) doc.addPage([MEDIA_WIDTH_PT, MEDIA_HEIGHT_PT])
    return await doc.save()
  }
  return { render, jobs }
}

const OPTS = { issueNumber: 4, startPage: 1 }

beforeEach(() => {
  setPdfRenderer(null)
})

afterEach(() => {
  setPdfRenderer(null)
  vi.restoreAllMocks()
})

// ── Text-only article ────────────────────────────────────────────────────────

describe('text-only article', () => {
  it('renders at least one page through the render seam', async () => {
    const { render, jobs } = stubRenderer(3)
    const result = await renderArticle(article(), { ...OPTS, measurement: true }, { render })

    expect(result.pageCount).toBe(3)
    expect(result.pageCount).toBeGreaterThanOrEqual(1)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].css).toBe(pressCss())
    expect(jobs[0].images.size).toBe(0)
    expect(jobs[0].html).toContain('The Long Way Round')
  })

  it('keeps headings with the text that follows them', () => {
    const css = pressCss()
    // No heading may be orphaned at the foot of a column or page. Asserted on
    // the rule rather than by measuring pixels.
    const headingRule = /h2,\s*\n?h3\s*\{[^}]*\}/m.exec(css)?.[0] ?? ''
    expect(headingRule).toContain('break-after: avoid')
    expect(headingRule).toContain('break-inside: avoid')
    expect(headingRule).toContain('page-break-after: avoid')
    expect(css).toMatch(/orphans:\s*3/)
    expect(css).toMatch(/widows:\s*3/)
  })

  it('lays the body out in two justified, hyphenated columns', () => {
    const css = pressCss()
    const body = /\.article-body\s*\{[^}]*\}/m.exec(css)?.[0] ?? ''
    expect(body).toContain('column-count: 2')
    expect(body).toContain('text-align: justify')
    expect(body).toMatch(/(^|\s)hyphens:\s*auto/m)
    // A serif for reading, a sans for the furniture.
    expect(css).toMatch(/--serif:\s*Georgia/)
    expect(css).toMatch(/--sans:\s*"Helvetica Neue"/)
  })
})

// ── Images ───────────────────────────────────────────────────────────────────

describe('images', () => {
  it('places a portrait and a landscape image, each with its orientation class', () => {
    const portrait = image({
      path: 'items/abc/images/tall.jpg',
      orientation: 'portrait',
      caption: 'Standing up.',
    })
    const landscape = image({ path: 'items/abc/images/wide.jpg', caption: 'Lying down.' })
    const html = buildArticleHtml(
      article({ blocks: [{ type: 'figure', image: portrait }, { type: 'figure', image: landscape }] }),
      OPTS,
    )

    expect(html).toContain('figure--portrait')
    expect(html).toContain('figure--landscape')
    expect(html).toContain(`images/${imageFileName(portrait.path)}`)
    expect(html).toContain(`images/${imageFileName(landscape.path)}`)
    expect(html).toContain('<figcaption>Standing up.</figcaption>')
    expect(html).toContain('<figcaption>Lying down.</figcaption>')

    expect(articleImages(article({ lead: portrait, blocks: [{ type: 'figure', image: landscape }] })))
      .toHaveLength(2)
  })

  it('spans a wide figure across both columns, caption included', () => {
    const landscape = image({ caption: 'The valley at dusk.' })
    expect(isWideFigure(landscape)).toBe(true)
    expect(isWideFigure(image({ orientation: 'portrait' }))).toBe(false)

    const html = buildArticleHtml(article({ blocks: [{ type: 'figure', image: landscape }] }), OPTS)
    const figure = /<figure class="([^"]*)">([\s\S]*?)<\/figure>/.exec(html)
    expect(figure?.[1]).toContain('figure--wide')
    expect(figure?.[2]).toContain('<figcaption>The valley at dusk.</figcaption>')

    const wideRule = /\.figure--wide\s*\{[^}]*\}/m.exec(pressCss())?.[0] ?? ''
    expect(wideRule).toContain('column-span: all')
  })

  it('fetches image bytes by local filename through the injected loader', async () => {
    const lead = image({ path: 'items/abc/images/lead.jpg', orientation: 'landscape' })
    const inline = image({ path: 'items/abc/images/tall.jpg', orientation: 'portrait' })
    const seen: string[] = []
    const loadImage = async (p: string) => {
      seen.push(p)
      return new Uint8Array([1, 2, 3])
    }

    const images = await loadImages([lead, inline, lead], loadImage)
    expect(seen).toEqual([lead.path, inline.path])
    expect([...images.keys()]).toEqual([imageFileName(lead.path), imageFileName(inline.path)])

    const { render, jobs } = stubRenderer(2)
    await renderArticle(
      article({ lead, blocks: [{ type: 'figure', image: inline }] }),
      OPTS,
      { render, loadImage },
    )
    expect(jobs[0].images.size).toBe(2)
  })

  it('never lets an untrusted storage path escape the images directory', () => {
    for (const p of ['../../etc/passwd', 'items/a/../../x.jpg', '..', 'a b/c d.PNG']) {
      const name = imageFileName(p)
      expect(name).not.toContain('/')
      expect(name).not.toContain('..')
      expect(name).toMatch(/^[a-zA-Z0-9-]+\.[a-z0-9]+$/)
    }
    // Distinct paths, distinct files, even with the same basename.
    expect(imageFileName('items/a/images/x.jpg')).not.toBe(imageFileName('items/b/images/x.jpg'))
  })
})

// ── Openers ──────────────────────────────────────────────────────────────────

describe('article opener', () => {
  it('runs a full-bleed lead image when there is one', () => {
    const lead = image({ path: 'items/abc/images/lead.jpg', caption: 'On the road.' })
    const html = buildArticleHtml(article({ lead }), OPTS)

    expect(html).toContain('opener opener--photo')
    expect(html).toContain('class="opener-figure"')
    expect(html).toContain(`images/${imageFileName(lead.path)}`)
    expect(html).toContain('class="lead-caption"')
    // Title, byline, source and date all appear on the opener.
    expect(html).toContain('<h1 class="article-title">The Long Way Round</h1>')
    expect(html).toContain('class="kicker">The Atlantic<')
    expect(html).toContain('By A. Writer')
    expect(html).toContain('March 14, 2026')

    // Opener pages give up their margins so the photograph can bleed.
    const style = documentStyle(OPTS)
    expect(style).toContain('@page opener:left { margin: 0 0 ')
    expect(style).toContain('@page opener:right { margin: 0 0 ')
  })

  it('degrades to a text-only opener when the lead image is missing', () => {
    const html = buildArticleHtml(article({ lead: null }), OPTS)

    expect(html).toContain('opener opener--text')
    expect(html).not.toContain('opener-figure')
    expect(html).not.toContain('<img')
    expect(html).toContain('<h1 class="article-title">The Long Way Round</h1>')
    expect(html).toContain('class="dek">A standfirst')

    const rule = /\.opener--text \.opener-text\s*\{[^}]*\}/m.exec(pressCss())?.[0] ?? ''
    expect(rule).toContain('padding-top')
  })

  it('prints the source URL in small print at the article end', () => {
    const html = buildArticleHtml(article(), OPTS)
    expect(html).toContain('class="article-source"')
    expect(html).toContain('theatlantic.com/magazine/the-long-way-round')
    expect(formatSourceUrl('https://www.example.com/a/b/')).toBe('example.com/a/b')
    expect(formatSourceUrl(null)).toBe('')
  })
})

// ── Pagination bookkeeping ───────────────────────────────────────────────────

describe('pagination', () => {
  it('paginates a long article with a running footer on every page', async () => {
    const long = article({ blocks: paragraphs(120) })
    const { render, jobs } = stubRenderer(11)
    const result = await renderArticle(long, OPTS, { render })

    expect(result.pageCount).toBe(11)
    expect(jobs[0].html).toContain('Paragraph 120.')

    // The folio is declared for both verso and recto, unconditionally: every
    // page of the flow gets one.
    const css = pressCss()
    const verso = /@page :left \{\s*@bottom-left \{[^}]*\}/m.exec(css)?.[0] ?? ''
    const recto = /@page :right \{\s*@bottom-right \{[^}]*\}/m.exec(css)?.[0] ?? ''
    expect(verso).toContain('content: counter(page)')
    expect(recto).toContain('content: counter(page)')

    // Openers keep a foot margin, so their folio has somewhere to sit.
    const style = documentStyle(OPTS)
    const openerMargin = /@page opener:left \{ margin: 0 0 ([\d.]+)pt 0; \}/.exec(style)
    expect(Number(openerMargin?.[1])).toBeGreaterThan(BLEED_PT)
  })

  it('reads the page count from the produced PDF rather than guessing', async () => {
    const doc = await PDFDocument.create()
    for (let i = 0; i < 7; i++) doc.addPage([MEDIA_WIDTH_PT, MEDIA_HEIGHT_PT])
    const bytes = await doc.save()

    expect(await pdfPageCount(bytes)).toBe(7)

    const measured = await renderHtml('<html></html>', new Map(), { render: async () => bytes })
    expect(measured.pageCount).toBe(7)
    expect(measured.pdf).toBe(bytes)
  })

  it('carries startPage and issue number into the output for U5s single pass', () => {
    const html = buildIssueHtml(
      [{ article: article(), id: 'item-1' }, { article: article({ title: 'Second Piece' }), id: 'item-2' }],
      { issueNumber: 12, startPage: 47 },
    )

    // Vivliostyle ignores a page-counter reset on the root element, so it has
    // to hang off the document's first child (verified against Chromium).
    expect(html).toContain('.press-doc > *:first-child { counter-reset: page 47; }')
    expect(html).not.toMatch(/\.press-doc\s*\{[^}]*counter-reset/)
    expect(html).toContain('data-start-page="47"')
    expect(html).toContain('data-issue="12"')
    expect(html).toContain('"Issue 12  ·  " counter(page)')
    // TOC anchors for U5.
    expect(html).toContain('id="item-1"')
    expect(html).toContain('id="item-2"')
    // Each article opens on a fresh page.
    expect(/\.article\s*\{[^}]*break-before: page/m.test(pressCss())).toBe(true)

    // A measurement render has no real issue number yet, so it carries no
    // issue furniture — only the page counter.
    const measurement = documentStyle({ issueNumber: 12, startPage: 1, measurement: true })
    expect(measurement).not.toContain('Issue 12')
    expect(measurement).toContain('counter-reset: page 1')
  })

  it('derives the page box from the print spec and refuses nonsense counters', () => {
    const style = documentStyle(OPTS)
    expect(style).toContain(`size: ${MEDIA_WIDTH_PT}pt ${MEDIA_HEIGHT_PT}pt`)
    // Margins are measured from trim, then pushed out by the bleed.
    expect(style).toContain(`margin: ${TRIM_MARGIN_PT.top + BLEED_PT}pt`)
    expect(style).toContain(`margin-right: ${TRIM_MARGIN_PT.inner + BLEED_PT}pt`)

    const junk = documentStyle({
      issueNumber: Number.NaN,
      startPage: -3 as number,
    })
    expect(junk).toContain('counter-reset: page 1')
    expect(junk).toContain('"Issue 1  ·  "')
    const injected = documentStyle({ issueNumber: 1.9, startPage: 2.7 })
    expect(injected).toContain('counter-reset: page 2')
    expect(injected).toContain('"Issue 1  ·  "')
  })

  it('renders many articles in a single pass with one continuous counter', async () => {
    const { render, jobs } = stubRenderer(9)
    const result = await renderArticles(
      [{ article: article() }, { article: article({ title: 'Second Piece' }) }],
      { issueNumber: 3, startPage: 5 },
      { render },
    )
    expect(result.pageCount).toBe(9)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].html).toContain('counter-reset: page 5')
    expect((jobs[0].html.match(/<article class="article"/g) ?? []).length).toBe(2)
  })
})

// ── Escaping ─────────────────────────────────────────────────────────────────

describe('escaping untrusted article content', () => {
  const hostile = article({
    title: '<script>alert("pwn")</script> "quoted" & <b>bold</b>',
    byline: 'By "Anon" <script>x</script>',
    sourceName: '<img src=x onerror=alert(1)>',
    dek: 'She said "no" & left',
    url: 'https://example.com/"onload="alert(1)',
    lead: image({ alt: '" onerror="alert(1)', caption: '<script>c</script>' }),
    blocks: [
      { type: 'para', html: '<p>ok <em>keep</em> <a href="https://evil.test">link text</a></p>' },
      { type: 'para', html: '<script>fetch("https://evil.test")</script>after' },
      { type: 'para', html: '<img src="https://evil.test/pixel.gif" onerror="alert(1)">text' },
      { type: 'heading', level: 2, text: '</h2><script>alert(1)</script>' },
      { type: 'quote', html: '<b>quoted</b>', attribution: '"Someone"' },
      { type: 'list', ordered: false, items: ['<span onclick="x">one</span>', 'two'] },
    ],
  })

  it('cannot break out of the template', () => {
    const html = buildArticleHtml(hostile, OPTS)

    expect(html).not.toContain('<script')
    expect(html).not.toContain('</script>')
    expect(html).not.toMatch(/javascript:/i)
    // Every attribute on every real tag is one this template puts there — so
    // no event handler and no injected `src` survived. (The *escaped text* of
    // one, sitting harmlessly inside a quoted value or a text node, is fine.)
    const allowed = new Set(['class', 'id', 'src', 'alt', 'href', 'lang', 'charset', 'rel'])
    for (const tag of html.match(/<[a-z][^>]*>/gi) ?? []) {
      // Blank out the quoted values first: escaped content inside them is inert.
      const bare = tag.replace(/"[^"]*"/g, '""')
      expect(bare).not.toMatch(/=\s*[^"\s>]/) // every value is double-quoted
      for (const attr of bare.matchAll(/\s([a-zA-Z-]+)\s*=/g)) {
        expect(allowed.has(attr[1]) || attr[1].startsWith('data-')).toBe(true)
      }
    }
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&quot;quoted&quot;')
    // Attribute values stay inside their quotes.
    expect(html).toContain('alt="&quot; onerror=&quot;alert(1)"')
    // Only one <h1>, one opener, one body: nothing spliced in an extra element.
    expect((html.match(/<h1/g) ?? []).length).toBe(1)
    expect((html.match(/<article/g) ?? []).length).toBe(1)
    expect((html.match(/<h2/g) ?? []).length).toBe(1)
  })

  it('keeps the inline tags print needs and drops everything else', () => {
    expect(sanitizeRichText('a <em>b</em> c')).toBe('a <em>b</em> c')
    expect(sanitizeRichText('<em class="x" onclick="y">b</em>')).toBe('<em>b</em>')
    expect(sanitizeRichText('<a href="https://evil.test">words</a>')).toBe('words')
    expect(sanitizeRichText('<script>alert(1)</script>keep')).toBe('keep')
    expect(sanitizeRichText('<style>body{x}</style>keep')).toBe('keep')
    expect(sanitizeRichText('<img src="https://evil.test/x.gif">keep')).toBe('keep')
    expect(sanitizeRichText('line<BR/>break')).toBe('line<br>break')
    expect(sanitizeRichText(null)).toBe('')
    expect(escapeHtml('<&">\'')).toBe('&lt;&amp;&quot;&gt;&#39;')
    expect(escapeHtml(null)).toBe('')
  })

  it('renders template placeholders in content literally', () => {
    const html = buildArticleHtml(article({ title: '{{ARTICLES}} $& $1 {{RENDER_STYLE}}' }), OPTS)
    expect(html).toContain('{{ARTICLES}} $&amp; $1 {{RENDER_STYLE}}')
    // The placeholder in the title did not re-expand into a second body.
    expect((html.match(/<div class="article-body">/g) ?? []).length).toBe(1)
  })
})

// ── No network, ever ─────────────────────────────────────────────────────────

describe('offline guarantee', () => {
  const rich = article({
    lead: image({ path: 'items/abc/images/lead.jpg' }),
    blocks: [
      { type: 'figure', image: image({ path: 'items/abc/images/wide.jpg' }) },
      { type: 'figure', image: image({ path: 'items/abc/images/tall.jpg', orientation: 'portrait' }) },
      { type: 'para', html: 'Body copy with <em>emphasis</em>.' },
      { type: 'quote', html: 'A pull quote.', attribution: 'Someone' },
      { type: 'list', ordered: true, items: ['one', 'two'] },
      { type: 'rule' },
    ],
  })

  it('generates HTML with zero external resource references', () => {
    const html = buildArticleHtml(rich, OPTS)

    expect(html).not.toMatch(/https?:/i)
    expect(html).not.toMatch(/@import/i)
    expect(html).not.toMatch(/(src|href|srcset|poster|data)\s*=\s*["']?(https?:)?\/\//i)
    expect(html).not.toMatch(/url\(\s*["']?(https?:|\/\/)/i)
    expect(html).not.toMatch(/@font-face/i)
    // The only external file it points at is the stylesheet beside it.
    expect([...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1])).toEqual([
      'press.css',
      `images/${imageFileName('items/abc/images/lead.jpg')}`,
      `images/${imageFileName('items/abc/images/wide.jpg')}`,
      `images/${imageFileName('items/abc/images/tall.jpg')}`,
    ])
  })

  it('keeps a URL that appears in body text out of any attribute', () => {
    const html = buildArticleHtml(
      article({ blocks: [{ type: 'para', html: 'See https://evil.test/x for more.' }] }),
      OPTS,
    )
    expect(html).toContain('See https://evil.test/x for more.')
    expect(html).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//i)
  })

  it('ships a stylesheet that fetches nothing', () => {
    const css = pressCss()
    expect(css).not.toMatch(/@import/i)
    expect(css).not.toMatch(/@font-face/i)
    expect(css).not.toMatch(/url\(/i)
    expect(css).not.toMatch(/https?:/i)
  })

  it('sets nothing below the 10px type floor', () => {
    // 7.5pt is 10px exactly. Furniture — running heads, folios, flags, note
    // markers — used to run down to 6.5pt, which is too small to read on the
    // page and too small on screen in the workbench preview.
    const sizes = [...pressCss().matchAll(/font-size:\s*([\d.]+)pt/g)].map((m) => Number(m[1]))
    expect(sizes.length).toBeGreaterThan(0)
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(7.5)
  })
})

// ── Fragment API for U5 ──────────────────────────────────────────────────────

describe('article fragments', () => {
  it('exposes a section builder that U5 can concatenate', () => {
    const section = buildArticleSection({ article: article(), id: 'item-9' }, 3)
    expect(section.startsWith('<article class="article" data-index="4">')).toBe(true)
    expect(section.trimEnd().endsWith('</article>')).toBe(true)
    expect(section).toContain('id="item-9"')
    // A bare fragment, not a document.
    expect(section).not.toContain('<html')
    expect(section).not.toContain('<style')
  })
})

// ── Footnotes and the folio ──────────────────────────────────────────────────

describe('footnotes in the layout', () => {
  const withNotes = (footnotes: { marker: string; html: string }[]): Article => ({
    title: 'On sincerity',
    byline: 'Joe Carlsmith',
    sourceName: 'Joe Carlsmith',
    url: 'https://example.com/a',
    publishedAt: '2026-08-01T00:00:00Z',
    dek: null,
    lead: null,
    blocks: [{ type: 'para', html: 'Living amongst the Nazis.<sup>1</sup>' }],
    footnotes,
  })

  it('sets the notes after the body, under a heading', () => {
    const html = buildArticleHtml(withNotes([{ marker: '1', html: 'The note.' }]), {
      issueNumber: 1,
      startPage: 1,
    })
    expect(html).toContain('class="footnotes"')
    expect(html).toContain('Notes')
    expect(html).toContain('The note.')
    // The apparatus belongs before the source line, not after it.
    expect(html.indexOf('footnote-list')).toBeLessThan(html.indexOf('article-source'))
  })

  it('prints the source markers rather than renumbering from one', () => {
    // The body's <sup> markers are left alone, so the notes have to match them.
    const html = buildArticleHtml(
      withNotes([
        { marker: '4', html: 'Fourth.' },
        { marker: '5', html: 'Fifth.' },
      ]),
      { issueNumber: 1, startPage: 1 },
    )
    expect(html).toContain('>4</span>')
    expect(html).toContain('>5</span>')
  })

  it('emits no apparatus at all when there are none', () => {
    const html = buildArticleHtml(withNotes([]), { issueNumber: 1, startPage: 1 })
    expect(html).not.toContain('class="footnotes"')
    // An extraction stored before footnote support has no field whatsoever.
    const legacy = { ...withNotes([]) } as Article
    delete (legacy as { footnotes?: unknown }).footnotes
    expect(buildArticleHtml(legacy, { issueNumber: 1, startPage: 1 })).not.toContain('class="footnotes"')
  })

  it('sanitises a note the same way it sanitises the body', () => {
    const html = buildArticleHtml(
      withNotes([{ marker: '1', html: '<em>ok</em><script>x</script><a href="http://e.test">y</a>' }]),
      { issueNumber: 1, startPage: 1 },
    )
    // Scoped to the note: the document shell legitimately links press.css.
    const note = /<section class="footnotes">[\s\S]*?<\/section>/.exec(html)?.[0] ?? ''
    expect(note).toContain('<em>ok</em>')
    expect(note).not.toContain('<script>')
    expect(note).not.toContain('href')
    expect(note).toContain('y')
  })
})

// ── Linkposts ────────────────────────────────────────────────────────────────

describe('linkposts on the page', () => {
  const base: Article = {
    title: 'Monthly Roundup #14',
    byline: 'Zvi Mowshowitz',
    sourceName: 'Don\u2019t Worry About the Vase',
    url: 'https://thezvi.substack.com/p/roundup-14',
    publishedAt: '2026-08-01T00:00:00Z',
    dek: null,
    lead: null,
    blocks: [{ type: 'para', html: 'Everything worth reading this month.' }],
  }

  const roundup = (targets: { url: string; anchor: string; note: string | null }[]): Article => ({
    ...base,
    linkpost: { kind: 'roundup', reason: 'a monthly links roundup', targets },
  })

  const child = (): Article => ({
    ...base,
    title: 'On sincerity',
    linkpost: undefined,
    linkpostOf: {
      title: 'Monthly Roundup #14',
      url: 'https://thezvi.substack.com/p/roundup-14',
      anchor: 'On sincerity',
    },
  })

  it('flags a linkpost above its title and says how many follow', () => {
    const html = buildArticleHtml(
      roundup([
        { url: 'https://a.test/1', anchor: 'On sincerity', note: 'an essay on honesty' },
        { url: 'https://b.test/2', anchor: 'A second essay', note: null },
      ]),
      { issueNumber: 1, startPage: 1 },
    )
    expect(html).toContain('class="flag"')
    expect(html).toContain('Linkpost \u00b7 2 pieces follow')
    // Above the title, so the relationship is read before the piece is.
    expect(html.indexOf('class="flag"')).toBeLessThan(html.indexOf('article-title'))
  })

  it('says which linkpost brought a piece in', () => {
    const html = buildArticleHtml(child(), { issueNumber: 1, startPage: 1 })
    expect(html).toContain('flag--via')
    expect(html).toContain('Linkpost of')
    expect(html).toContain('Monthly Roundup #14')
  })

  it('credits a translation above the title, where a reader needs it', () => {
    const html = buildArticleHtml(
      article({
        translation: {
          sourceLanguage: 'Russian',
          model: 'claude-opus-5',
          translatedAt: '2026-09-01T00:00:00.000Z',
        },
      }),
      { issueNumber: 1, startPage: 1 },
    )
    expect(html).toContain('flag--translated')
    expect(html).toContain('Translated from the Russian')
    expect(html.indexOf('flag--translated')).toBeLessThan(html.indexOf('article-title'))
  })

  it('says nothing about translation on a piece written in English', () => {
    const html = buildArticleHtml(article(), { issueNumber: 1, startPage: 1 })
    expect(html).not.toContain('Translated from')
  })

  it('lists what the linkpost named, after the body and before the source line', () => {
    const html = buildArticleHtml(
      roundup([{ url: 'https://a.test/one', anchor: 'On sincerity', note: 'an essay on honesty' }]),
      { issueNumber: 1, startPage: 1 },
    )
    expect(html).toContain('class="linked"')
    expect(html).toContain('Linked here')
    expect(html).toContain('On sincerity')
    expect(html).toContain('an essay on honesty')
    expect(html.indexOf('linked-list')).toBeLessThan(html.indexOf('article-source'))
  })

  it('prints addresses without a scheme, like every other address in the magazine', () => {
    const html = buildArticleHtml(
      roundup([{ url: 'https://www.a.test/one/', anchor: 'On sincerity', note: null }]),
      { issueNumber: 1, startPage: 1 },
    )
    expect(html).toContain('a.test/one')
    expect(html).not.toMatch(/https?:/i)
  })

  it('escapes an anchor and a note exactly as it escapes a title', () => {
    const html = buildArticleHtml(
      roundup([
        { url: 'https://a.test/1', anchor: '<script>alert(1)</script>', note: '"quoted" & <b>bold</b>' },
      ]),
      { issueNumber: 1, startPage: 1 },
    )
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&quot;quoted&quot;')
  })

  it('emits nothing at all for an ordinary article', () => {
    const html = buildArticleHtml(base, { issueNumber: 1, startPage: 1 })
    expect(html).not.toContain('class="flag"')
    expect(html).not.toContain('class="linked"')
  })

  it('emits no list for a linkpost whose pointers all turned out to be noise', () => {
    const html = buildArticleHtml(roundup([]), { issueNumber: 1, startPage: 1 })
    // Still a linkpost, so still flagged — but with nothing to list.
    expect(html).toContain('class="flag"')
    expect(html).toContain('Linkpost')
    expect(html).not.toContain('class="linked"')
  })

  it('loads an extraction stored before linkposts existed', () => {
    const legacy = { ...base } as Article
    delete (legacy as { linkpost?: unknown }).linkpost
    delete (legacy as { linkpostOf?: unknown }).linkpostOf
    const html = buildArticleHtml(legacy, { issueNumber: 1, startPage: 1 })
    expect(html).toContain('article-title')
    expect(html).not.toContain('class="flag"')
  })

  it('keeps the stylesheet fetching nothing', () => {
    const css = pressCss()
    expect(css).toContain('.flag')
    expect(css).toContain('.linked')
    expect(css).not.toMatch(/url\(/)
    expect(css).not.toMatch(/https?:/i)
  })
})

describe('the folio on opener pages', () => {
  it('holds the page number inside the trim where the opener zeroes its margins', () => {
    // A full-bleed opener has margin: 0 on the sides, which would otherwise put
    // the folio in the 9pt bleed and let the guillotine cut it in half.
    const css = documentStyle({ issueNumber: 1, startPage: 1 })
    expect(css).toMatch(/@page opener:left \{ @bottom-left \{ padding-left: \d+(\.\d+)?pt/)
    expect(css).toMatch(/@page opener:right \{ @bottom-right \{ padding-right: \d+(\.\d+)?pt/)

    const pad = Number(/@page opener:right \{ @bottom-right \{ padding-right: ([\d.]+)pt/.exec(css)?.[1])
    // Inset from the trim, so it lines up with the folio on an ordinary page.
    expect(pad).toBe(TRIM_MARGIN_PT.outer + BLEED_PT)
  })

  it('leaves the folio off a measurement render entirely', () => {
    const css = documentStyle({ issueNumber: 1, startPage: 1, measurement: true })
    expect(css).not.toContain('@bottom-right')
    expect(css).not.toContain('opener:right { @bottom-right')
  })
})
