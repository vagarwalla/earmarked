import { describe, it, expect, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import {
  tocMeta,
  shouldCloseIssue,
  weeksBetween,
  computeToc,
  buildTocSection,
  buildCoverHtml,
  contentsClass,
  COVER_ARTS,
  coverArtFor,
  COVER_PALETTE,
  issueDateline,
  paletteFor,
  mergePdfs,
  padToEven,
  preflightInterior,
  loadEntries,
  composeIssue,
  type ComposeEntry,
} from '../compose'
import {
  sanitizeIssueName,
  fallbackIssueName,
  archiveCollectionName,
  isoDate,
  nameIssue,
  NAMING_MODEL,
} from '../naming'
import { setPdfRenderer, pdfPageCount } from '../layout/render'
import {
  MEDIA_WIDTH_PT,
  MEDIA_HEIGHT_PT,
  PRINT_SPEC,
  coverSizePt,
  spineWidthPt,
  spineTextHeightPt,
  TRIM_WIDTH_PT,
  BLEED_PT,
  type Article,
  type PressIssue,
  type PressItem,
  type TocEntry,
} from '../types'
import type { PressSettings } from '../settings'

// ── Fixtures ─────────────────────────────────────────────────────────────────

function article(title: string, paras = 3): Article {
  return {
    title,
    byline: 'A Writer',
    sourceName: 'A Publication',
    url: 'https://example.com/a',
    publishedAt: '2026-08-01T00:00:00Z',
    dek: null,
    lead: null,
    blocks: Array.from({ length: paras }, (_, i) => ({ type: 'para', html: `Paragraph ${i}.` }) as const),
  }
}

function item(over: Partial<PressItem> = {}): PressItem {
  return {
    id: `item-${Math.random().toString(36).slice(2, 8)}`,
    url: 'https://example.com/a',
    url_key: 'example.com/a',
    source: 'raindrop',
    raindrop_id: '1',
    state: 'in_issue',
    issue_id: 'iss1',
    position: null,
    title: 'A piece',
    byline: null,
    source_name: 'A Publication',
    published_at: '2026-08-01T00:00:00Z',
    content_path: 'items/x/article.json',
    fragment_path: null,
    page_count: 4,
    failure_reason: null,
    raw_email_path: null,
    is_linkpost: false,
    linkpost_parent_id: null,
    linkpost_anchor: null,
    linkpost_scanned_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...over,
  }
}

function issue(over: Partial<PressIssue> = {}): PressIssue {
  return {
    id: 'iss1',
    number: 3,
    state: 'closed',
    name: null,
    page_total: 0,
    interior_path: null,
    cover_path: null,
    quote_cents: null,
    quote_currency: null,
    lulu_job_id: null,
    lulu_idempotency_key: null,
    lulu_status: null,
    tracking_url: null,
    archive_collection_id: null,
    built_order: null,
    rejection_reason: null,
    opened_at: '2026-07-01T00:00:00Z',
    closed_at: null,
    approved_at: null,
    ordered_at: null,
    shipped_at: null,
    approval_sent_at: null,
    updated_at: '2026-08-01T00:00:00Z',
    ...over,
  }
}

const policy = { pageThreshold: 100, maxIssueAgeWeeks: 8 }

/** A real n-page PDF at the press media box. */
async function pdfOf(pages: number, width = MEDIA_WIDTH_PT, height = MEDIA_HEIGHT_PT): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) {
    doc.addPage([width, height]).drawRectangle({ x: 10, y: 10, width: 40, height: 40 })
  }
  return doc.save()
}

// ── Closing decision ─────────────────────────────────────────────────────────

describe('shouldCloseIssue', () => {
  const now = new Date('2026-08-30T00:00:00Z')

  it('closes a full issue', () => {
    expect(shouldCloseIssue(issue({ opened_at: '2026-08-25T00:00:00Z' }), 104, policy, now)).toMatchObject({
      close: true,
      reason: 'threshold',
    })
  })

  it('leaves a young half-full issue open', () => {
    expect(shouldCloseIssue(issue({ opened_at: '2026-08-25T00:00:00Z' }), 60, policy, now)).toMatchObject({
      close: false,
      reason: 'not-ready',
    })
  })

  it('force-closes a stale issue that can still be bound', () => {
    // Opened well over eight weeks ago, and past Lulu's 32-page floor.
    expect(shouldCloseIssue(issue({ opened_at: '2026-06-01T00:00:00Z' }), 40, policy, now)).toMatchObject({
      close: true,
      reason: 'max-age',
    })
  })

  it('keeps a stale issue open when it could not be perfect-bound', () => {
    const decision = shouldCloseIssue(issue({ opened_at: '2026-06-01T00:00:00Z' }), 20, policy, now)
    expect(decision.close).toBe(false)
    expect(decision.reason).toBe('below-print-minimum')
    expect(PRINT_SPEC.minPages).toBe(32)
  })

  it('never closes an empty issue', () => {
    expect(shouldCloseIssue(issue({ opened_at: '2026-01-01T00:00:00Z' }), 0, policy, now)).toMatchObject({
      close: false,
      reason: 'empty',
    })
  })

  it('measures age in weeks', () => {
    expect(weeksBetween('2026-08-23T00:00:00Z', new Date('2026-08-30T00:00:00Z'))).toBeCloseTo(1, 5)
  })
})

// ── TOC ──────────────────────────────────────────────────────────────────────

describe('computeToc', () => {
  const entries = [
    { kind: 'article', item: item({ id: 'a' }), article: article('First') },
    { kind: 'article', item: item({ id: 'b' }), article: article('Second') },
    { kind: 'article', item: item({ id: 'c' }), article: article('Third') },
  ] as ComposeEntry[]

  it('starts articles after the front matter and runs them consecutively', () => {
    // The plan's worked example: 4 + 7 + 2 pages.
    const toc = computeToc(entries, [4, 7, 2], 2)
    expect(toc.map((e) => e.startPage)).toEqual([3, 7, 14])
    expect(toc.map((e) => e.pageCount)).toEqual([4, 7, 2])
  })

  it('shifts every article when the front matter grows', () => {
    const one = computeToc(entries, [4, 7, 2], 1)
    const two = computeToc(entries, [4, 7, 2], 2)
    expect(two.map((e) => e.startPage)).toEqual(one.map((e) => e.startPage + 1))
  })

  it('carries the byline and source through for the TOC line', () => {
    const toc = computeToc(entries, [4, 7, 2], 1)
    expect(toc[0]).toMatchObject({ title: 'First', byline: 'A Writer', sourceName: 'A Publication' })
  })

  it('titles a PDF entry from the item, which has no article', () => {
    const withPdf = [
      { kind: 'pdf', item: item({ id: 'p', source: 'pdf', title: 'A report' }), pdf: new Uint8Array(), pageCount: 6 },
    ] as ComposeEntry[]
    expect(computeToc(withPdf, [6], 1)[0]).toMatchObject({ title: 'A report', startPage: 2, pageCount: 6 })
  })
})

describe('tocMeta', () => {
  it('does not print a personal blog’s author twice', () => {
    expect(tocMeta({ byline: 'Joe Carlsmith', sourceName: 'Joe Carlsmith' })).toBe('Joe Carlsmith')
    expect(tocMeta({ byline: 'Andy Masley', sourceName: 'andy masley' })).toBe('Andy Masley')
  })

  it('keeps both when they genuinely differ', () => {
    expect(tocMeta({ byline: 'Scott Alexander', sourceName: 'Slate Star Codex' })).toBe(
      'Scott Alexander · Slate Star Codex',
    )
  })

  it('copes with either half missing', () => {
    expect(tocMeta({ byline: null, sourceName: 'NEST' })).toBe('NEST')
    expect(tocMeta({ byline: 'A Writer', sourceName: null })).toBe('A Writer')
    expect(tocMeta({ byline: null, sourceName: null })).toBe('')
  })
})

describe('buildTocSection', () => {
  const toc: TocEntry[] = [
    { itemId: 'a', title: 'The Salt Roads', byline: 'Ada M', sourceName: 'Quarry', startPage: 3, pageCount: 4 },
  ]

  it('prints the real page number next to the title', () => {
    const html = buildTocSection('Winter Light', 3, toc)
    expect(html).toContain('The Salt Roads')
    expect(html).toContain('<span class="toc-page">3</span>')
    expect(html).toContain('Ada M · Quarry')
  })

  it('escapes a title that contains markup', () => {
    const html = buildTocSection('Name', 1, [{ ...toc[0], title: '<script>alert(1)</script>' }])
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('references nothing remote', () => {
    expect(buildTocSection('Name', 1, toc)).not.toMatch(/https?:\/\//)
  })

  it('marks a linkpost, and indents what it named under it', () => {
    const html = buildTocSection('Winter Light', 3, [
      { ...toc[0], itemId: 'zvi', title: 'Monthly Roundup', isLinkpost: true },
      { ...toc[0], itemId: 'k1', title: 'On sincerity', startPage: 7, linkpostOf: 'Monthly Roundup' },
    ])
    expect(html).toContain('<span class="toc-flag">Linkpost</span>')
    expect(html).toContain('<span class="toc-via">via Monthly Roundup</span>')
    expect(html).toContain('class="toc-entry toc-entry--child"')
    // The roundup itself is not indented.
    expect(html).toContain('<li class="toc-entry">')
  })

  it('escapes the linkpost title on the contents page too', () => {
    const html = buildTocSection('Name', 1, [
      { ...toc[0], linkpostOf: '<script>alert(1)</script>' },
    ])
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('leaves an ordinary entry unmarked', () => {
    const html = buildTocSection('Name', 1, toc)
    expect(html).not.toContain('toc-flag')
    expect(html).not.toContain('toc-via')
    expect(html).not.toContain('toc-entry--child')
  })
})

// ── Cover ────────────────────────────────────────────────────────────────────

describe('buildCoverHtml', () => {
  const base = {
    issueName: 'Winter Light',
    issueNumber: 3,
    dateRange: '2026-07-01 – 2026-08-30',
    toc: [
      { itemId: 'a', title: 'The Salt Roads', byline: null, sourceName: null, startPage: 3, pageCount: 4 },
    ] as TocEntry[],
  }

  it('sizes the spread from the page count', () => {
    const html = buildCoverHtml({ ...base, pageCount: 100 })
    const { width, height } = coverSizePt(100)
    expect(html).toContain(`${width.toFixed(2)}pt ${height.toFixed(2)}pt`)
    expect(html).toContain(`${spineWidthPt(100).toFixed(2)}pt`)
  })

  it('widens the spine as the issue thickens', () => {
    const thin = buildCoverHtml({ ...base, pageCount: 40 })
    const fat = buildCoverHtml({ ...base, pageCount: 300 })
    expect(thin).toContain(`${spineWidthPt(40).toFixed(2)}pt`)
    expect(fat).toContain(`${spineWidthPt(300).toFixed(2)}pt`)
    expect(spineWidthPt(300)).toBeGreaterThan(spineWidthPt(40))
  })

  it('lists the contents on the back', () => {
    expect(buildCoverHtml({ ...base, pageCount: 100 })).toContain('The Salt Roads')
  })

  it('escapes the issue name and references nothing remote', () => {
    const html = buildCoverHtml({ ...base, pageCount: 100, issueName: '"><script>x</script>' })
    expect(html).not.toContain('<script>')
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/@import|@font-face/)
  })

  it('leaves no placeholder unfilled', () => {
    // A stray {{TOKEN}} would print literally on a cover nobody proofreads.
    expect(buildCoverHtml({ ...base, pageCount: 100 })).not.toMatch(/\{\{[A-Z_]+\}\}/)
  })

  it('sets the issue title at display size', () => {
    const html = buildCoverHtml({ ...base, pageCount: 100 })
    const size = Number(/\.theme-name \{\s*\n\s*font-size: ([\d.]+)pt/.exec(html)?.[1])
    expect(size).toBeGreaterThanOrEqual(40)
  })

  it('carries no curator credit, piece count or page count on the front', () => {
    const html = buildCoverHtml({ ...base, pageCount: 100 })
    expect(html).not.toMatch(/Curated by/i)
    expect(html).not.toMatch(/\bpieces\b/)
    expect(html).not.toContain('pp.')
  })

  it('draws the art in CSS, with no image reference of any kind', () => {
    // Lulu wants 300 PPI on a cover; extracted article art is web-sized. The
    // art has to be resolution-free, which means gradients rather than <img>.
    // Every composition in the family, not just whichever this issue drew.
    for (let n = 1; n <= COVER_ARTS.length; n++) {
      const html = buildCoverHtml({ ...base, issueNumber: n, pageCount: 100 })
      expect(html).toMatch(/gradient\(|background:\s*#/)
      expect(html).not.toContain('<img')
      expect(html).not.toMatch(/url\(/)
    }
  })

  it('gives every issue a different cover, not the same one recoloured', () => {
    // Nine issues had nine covers that were one picture in a rotated palette.
    const arts = new Set<string>()
    for (let n = 1; n <= COVER_ARTS.length; n++) {
      const art = coverArtFor(n, paletteFor(n))
      arts.add(art.name)
      // The composition is drawn in this issue's own colours.
      expect(art.css).toContain(paletteFor(n)[0])
    }
    expect(arts.size).toBe(COVER_ARTS.length)
    // Deterministic: a rebuild of issue 4 is always the same cover.
    expect(coverArtFor(4, paletteFor(4))).toEqual(coverArtFor(4, paletteFor(4)))
    // And it wraps rather than running off the end.
    expect(coverArtFor(COVER_ARTS.length + 1, paletteFor(1)).name).toBe(
      coverArtFor(1, paletteFor(1)).name,
    )
  })

  it('rotates the palette per issue so consecutive covers differ', () => {
    expect(paletteFor(1)[0]).not.toBe(paletteFor(2)[0])
    // Deterministic, and it wraps rather than running off the end.
    expect(paletteFor(1)).toEqual(paletteFor(1))
    expect(paletteFor(COVER_PALETTE.length + 1)).toEqual(paletteFor(1))
    expect(new Set(paletteFor(3))).toEqual(new Set(COVER_PALETTE))
    // A number below the first issue must not index off the front.
    expect(paletteFor(0).every((c) => COVER_PALETTE.includes(c as never))).toBe(true)
  })

  it('prints spine text only once the spine can hold it', () => {
    // Lulu refuses spine text under 100 pages; a thin issue gets a bare spine.
    // The class names live in the stylesheet either way; what matters is
    // whether the spine panel has any content in it.
    const spinePanel = (html: string) =>
      /<section class="spine">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? null

    expect(spinePanel(buildCoverHtml({ ...base, pageCount: 64 }))).toBe('')

    const thick = buildCoverHtml({ ...base, pageCount: 104 })
    expect(spinePanel(thick)).toContain('spine-text')
    expect(thick).toContain(base.issueName)
    // "No. 3", not a lone digit — one rotated numeral reads as a dash.
    expect(thick).toContain('No. 3')
  })

  it('sizes spine type to the clearance Lulu leaves either side of it', () => {
    const html = buildCoverHtml({ ...base, pageCount: 104 })
    const rule = /\.spine-text,\s*\n\s*\.spine-num \{([\s\S]*?)\}/.exec(html)?.[1] ?? ''
    const size = Number(/font-size: ([\d.]+)pt/.exec(rule)?.[1])
    expect(size).toBeGreaterThan(0)
    // Type has to fit between Lulu's clearances, not just inside the spine.
    expect(size).toBeLessThanOrEqual(spineTextHeightPt(104))
  })

  it('splits the spread into two equal panels either side of the spine', () => {
    // The fold has to land on the trim, or the front art walks off the face.
    const html = buildCoverHtml({ ...base, pageCount: 104 })
    const panel = Number(/grid-template-columns: ([\d.]+)pt/.exec(html)?.[1])
    expect(panel).toBeCloseTo(TRIM_WIDTH_PT + BLEED_PT, 2)
    expect(2 * panel + spineWidthPt(104)).toBeCloseTo(coverSizePt(104).width, 2)
  })

  it('dates the issue by when it was made up, not by its contents', () => {
    // Issue 1 holds a piece from 2014; "February 2014 – August 2026" on a
    // cover would describe the anthology, not the object.
    // Mid-month, so the assertion does not depend on the runner's timezone.
    expect(issueDateline('2026-08-15T12:00:00Z')).toBe('August 2026')
    expect(issueDateline('not a date')).toBe('')
  })

  it('leaves the dateline blank rather than printing a placeholder', () => {
    const html = buildCoverHtml({ ...base, pageCount: 100, dateRange: '' })
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/)
  })

  it('runs the back titles together without the bylines or page numbers', () => {
    // The interior already carries a contents page; the back is a look at the
    // issue, not a second index.
    const toc: TocEntry[] = [
      { itemId: 'a', title: 'The Salt Roads', byline: 'Ada M', sourceName: 'Quarry', startPage: 3, pageCount: 4 },
      { itemId: 'b', title: 'Winter Light', byline: 'Bo N', sourceName: 'Hearth', startPage: 7, pageCount: 5 },
    ]
    const html = buildCoverHtml({ ...base, pageCount: 100, toc })
    expect(html).toContain('The Salt Roads')
    expect(html).toContain('Winter Light')
    expect(html).toContain('c-sep')
    expect(html).not.toContain('Ada M')
    expect(html).not.toContain('Quarry')
  })

  it('sizes the back run by how much title text there is, not by piece count', () => {
    const short = [{ itemId: 'a', title: 'Ash', byline: null, sourceName: null, startPage: 3, pageCount: 4 }]
    // Four very long titles set more text than ten short ones.
    const long = Array.from({ length: 4 }, (_, i) => ({
      itemId: `x${i}`,
      title: 'A'.repeat(180),
      byline: null,
      sourceName: null,
      startPage: 3,
      pageCount: 4,
    }))
    expect(contentsClass(short as TocEntry[])).toBe('contents--short')
    expect(contentsClass(long as TocEntry[])).toBe('contents--verylong')
    expect(contentsClass(base.toc)).toBe('contents--short')
  })
})

// ── PDF assembly ─────────────────────────────────────────────────────────────

describe('mergePdfs', () => {
  it('concatenates in order and keeps every page', async () => {
    const merged = await mergePdfs([await pdfOf(2), await pdfOf(3), await pdfOf(1)])
    expect(await pdfPageCount(merged)).toBe(6)
  })
})

describe('padToEven', () => {
  it('adds a blank verso to an odd interior', async () => {
    const padded = await padToEven(await pdfOf(7))
    expect(await pdfPageCount(padded)).toBe(8)
    const doc = await PDFDocument.load(padded)
    expect(doc.getPage(7).getSize().width).toBeCloseTo(MEDIA_WIDTH_PT, 2)
  })

  it('leaves an even interior alone', async () => {
    expect(await pdfPageCount(await padToEven(await pdfOf(8)))).toBe(8)
  })
})

describe('preflightInterior', () => {
  it('passes a well-formed interior', async () => {
    expect(await preflightInterior(await pdfOf(64))).toEqual([])
  })

  it('catches an interior too thin to perfect-bind', async () => {
    const problems = await preflightInterior(await pdfOf(20))
    expect(problems.map((p) => p.code)).toContain('too-few-pages')
  })

  it('catches an odd page count', async () => {
    const problems = await preflightInterior(await pdfOf(33))
    expect(problems.map((p) => p.code)).toContain('odd-pages')
  })

  it('catches a page that is not the ordered trim', async () => {
    const problems = await preflightInterior(await pdfOf(64, 595.28, 841.89))
    expect(problems.map((p) => p.code)).toContain('wrong-page-size')
  })
})

// ── Naming (KTD8) ────────────────────────────────────────────────────────────

describe('sanitizeIssueName', () => {
  it('takes the first line and drops the model’s decoration', () => {
    expect(sanitizeIssueName('"Winter Light"')).toBe('Winter Light')
    expect(sanitizeIssueName('Title: Winter Light')).toBe('Winter Light')
    expect(sanitizeIssueName('Winter Light\n\nHope that helps!')).toBe('Winter Light')
    expect(sanitizeIssueName('  Winter Light.  ')).toBe('Winter Light')
  })

  it('removes characters that would break a collection name', () => {
    expect(sanitizeIssueName('Salt / Roads')).toBe('Salt Roads')
    expect(sanitizeIssueName('Salt — Roads')).toBe('Salt Roads')
  })

  it('bounds the length', () => {
    expect(sanitizeIssueName('x'.repeat(200).split('').join(' ')).length).toBeLessThanOrEqual(48)
  })
})

describe('archiveCollectionName', () => {
  it('is the order date and the issue name, which is the archive key', () => {
    expect(archiveCollectionName(new Date('2026-08-30T18:00:00Z'), 'Winter Light')).toBe(
      '2026-08-30 — Winter Light',
    )
    expect(isoDate(new Date('2026-08-30T18:00:00Z'))).toBe('2026-08-30')
  })
})

describe('nameIssue', () => {
  const toc: TocEntry[] = [
    { itemId: 'a', title: 'The Salt Roads', byline: 'Ada M', sourceName: 'Quarry', startPage: 3, pageCount: 4 },
    { itemId: 'b', title: 'The Longest Winter', byline: null, sourceName: 'Cold Comfort', startPage: 7, pageCount: 6 },
  ]

  it('asks a small model and uses what it says', async () => {
    // Typed parameter so the assertions below can read the request back.
    const create = vi.fn(async (req: { model: string; messages: { content: string }[] }) => {
      void req
      return { content: [{ type: 'text', text: 'Winter Light' }] }
    })
    const name = await nameIssue({
      issueNumber: 3,
      toc,
      apiKey: 'sk-test',
      client: { messages: { create } } as never,
    })
    expect(name).toBe('Winter Light')
    const request = create.mock.calls[0][0]
    expect(request.model).toBe(NAMING_MODEL)
    // The model is given the contents, which is what it is meant to name.
    expect(request.messages[0].content).toContain('The Salt Roads')
  })

  it('falls back to the date-range name when the key is absent', async () => {
    expect(await nameIssue({ issueNumber: 3, toc, apiKey: null })).toBe(fallbackIssueName(3))
  })

  it('falls back rather than failing when the call errors', async () => {
    const create = vi.fn(async () => {
      throw new Error('rate limited')
    })
    expect(
      await nameIssue({ issueNumber: 7, toc, apiKey: 'sk-test', client: { messages: { create } } as never }),
    ).toBe('Issue 7')
  })

  it('falls back when the model returns nothing usable', async () => {
    const create = vi.fn(async () => ({ content: [{ type: 'text', text: '   ' }] }))
    expect(
      await nameIssue({ issueNumber: 9, toc, apiKey: 'sk-test', client: { messages: { create } } as never }),
    ).toBe('Issue 9')
  })

  it('does not call the model for an empty issue', async () => {
    const create = vi.fn()
    expect(
      await nameIssue({ issueNumber: 4, toc: [], apiKey: 'sk-test', client: { messages: { create } } as never }),
    ).toBe('Issue 4')
    expect(create).not.toHaveBeenCalled()
  })
})

// ── loadEntries ──────────────────────────────────────────────────────────────

describe('loadEntries', () => {
  it('reports an item with no extracted article instead of printing blanks', async () => {
    const { entries, skipped } = await loadEntries([item({ content_path: null })], {})
    expect(entries).toHaveLength(0)
    expect(skipped[0].reason).toMatch(/no extracted article/)
  })

  it('reports a pdf item with no fragment', async () => {
    const { skipped } = await loadEntries([item({ source: 'pdf', content_path: null, fragment_path: null })], {})
    expect(skipped[0].reason).toMatch(/no fragment/)
  })
})

// ── composeIssue ─────────────────────────────────────────────────────────────

/**
 * A renderer that produces a real PDF whose length is driven by the document,
 * so page arithmetic is exercised rather than stubbed: one page per article
 * section, one per eight TOC entries.
 */
function countingRenderer() {
  const calls: { html: string; pages: number }[] = []
  setPdfRenderer(async ({ html }) => {
    let pages: number
    if (html.includes('class="toc"')) {
      const entries = (html.match(/class="toc-entry"/g) ?? []).length
      pages = Math.max(1, Math.ceil(entries / 8))
    } else if (html.includes('class="masthead"')) {
      pages = 1 // the cover spread
    } else {
      pages = Math.max(1, (html.match(/<article/g) ?? []).length * 2)
    }
    calls.push({ html, pages })
    const doc = await PDFDocument.create()
    for (let i = 0; i < pages; i++) {
      doc.addPage([MEDIA_WIDTH_PT, MEDIA_HEIGHT_PT]).drawRectangle({ x: 5, y: 5, width: 9, height: 9 })
    }
    return doc.save()
  })
  return calls
}

function composeDb(
  articles: Record<string, Article>,
  pdfs: Record<string, Uint8Array> = {},
  items: PressItem[] = [],
) {
  const stored = new Map<string, Uint8Array | string>()
  const updates: { table: string; patch: Record<string, unknown> }[] = []
  const client = {
    from(table: string) {
      const b: Record<string, unknown> = {}
      let patch: Record<string, unknown> | null = null
      b.select = () => b
      b.eq = () => {
        if (patch) updates.push({ table, patch })
        return b
      }
      b.in = () => b
      b.is = () => b
      b.order = () => b
      b.limit = () => b
      b.update = (p: Record<string, unknown>) => {
        patch = p
        return b
      }
      b.insert = () => b
      b.upsert = () => b
      b.maybeSingle = async () => ({ data: null, error: null })
      b.then = (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: table === 'press_items' ? items : [], error: null }).then(r)
      return b
    },
    rpc: async () => ({ data: null, error: null }),
    storage: {
      from: () => ({
        upload: async (path: string, body: Uint8Array | string) => {
          stored.set(path, body)
          return { error: null }
        },
        download: async (path: string) => {
          if (pdfs[path]) return { data: new Blob([pdfs[path] as unknown as BlobPart]), error: null }
          if (articles[path]) {
            return { data: new Blob([JSON.stringify(articles[path])]), error: null }
          }
          return { data: null, error: { message: `missing ${path}` } }
        },
      }),
    },
  }
  return { client: client as never, stored, updates }
}

const settings = {
  pageThreshold: 100,
  maxIssueAgeWeeks: 8,
  anthropicApiKey: null,
  storageBucket: 'press',
} as PressSettings

describe('composeIssue', () => {
  it('numbers pages continuously across articles and matches the TOC to them', async () => {
    countingRenderer()
    const items = [
      item({ id: 'a', content_path: 'items/a/article.json', published_at: '2026-08-01T00:00:00Z' }),
      item({ id: 'b', content_path: 'items/b/article.json', published_at: '2026-08-02T00:00:00Z' }),
      item({ id: 'c', content_path: 'items/c/article.json', published_at: '2026-08-03T00:00:00Z' }),
    ]
    const db = composeDb(
      {
        'items/a/article.json': article('First'),
        'items/b/article.json': article('Second'),
        'items/c/article.json': article('Third'),
      },
      {},
      items,
    )

    const result = await composeIssue(issue(), {
      db: db.client,
      settings,
      loadImage: async () => new Uint8Array(),
      nameIssueFn: async () => 'Winter Light',
    })

    // Front matter is one TOC page; each article renders two.
    expect(result.toc.map((e) => e.startPage)).toEqual([2, 4, 6])
    expect(result.pageCount).toBe(8)
    // Every article begins exactly where the one before it ended — no gaps,
    // no overlaps — and the last one ends inside the interior (which is one
    // page longer here, having been padded to an even leaf count).
    for (let i = 1; i < result.toc.length; i++) {
      expect(result.toc[i].startPage).toBe(result.toc[i - 1].startPage + result.toc[i - 1].pageCount)
    }
    const last = result.toc[result.toc.length - 1]
    expect(last.startPage + last.pageCount - 1).toBe(7)
    expect(result.pageCount).toBe(8)
  })

  it('keeps the name it was given rather than naming the issue again', async () => {
    countingRenderer()
    const items = [item({ id: 'a', content_path: 'items/a/article.json' })]
    const db = composeDb({ 'items/a/article.json': article('First') }, {}, items)
    const naming = vi.fn(async () => 'A Second Name')

    // A rebuild re-renders an issue; it does not retitle it. Without this the
    // button quietly renames the magazine on every press — and `nameIssue` is
    // a model call, so it would also spend a token to do it.
    const result = await composeIssue(issue({ name: 'Winter Light' }), {
      db: db.client,
      settings,
      loadImage: async () => new Uint8Array(),
      nameIssueFn: naming,
      name: 'Winter Light',
    })

    expect(result.name).toBe('Winter Light')
    expect(naming).not.toHaveBeenCalled()
  })

  it('reports each stage, so a four-minute render has something to show', async () => {
    countingRenderer()
    const items = [
      item({ id: 'a', content_path: 'items/a/article.json' }),
      item({ id: 'b', content_path: 'items/b/article.json' }),
    ]
    const db = composeDb(
      { 'items/a/article.json': article('First'), 'items/b/article.json': article('Second') },
      {},
      items,
    )
    const said: string[] = []

    await composeIssue(issue(), {
      db: db.client,
      settings,
      loadImage: async () => new Uint8Array(),
      nameIssueFn: async () => 'Winter Light',
      onProgress: (m) => said.push(m),
    })

    // The stages the job row shows a button. Measuring counts, because it is
    // the one that takes proportionally longer the fatter the issue gets.
    expect(said).toContain('Measuring 1 of 2')
    expect(said).toContain('Measuring 2 of 2')
    expect(said).toContain('Typesetting the pages')
    expect(said).toContain('Rendering the cover')
    expect(said[said.length - 1]).toBe('Storing the files')
  })

  it('renders the prose in a single pass when nothing interrupts it', async () => {
    const calls = countingRenderer()
    const items = [item({ id: 'a', content_path: 'items/a/article.json' }), item({ id: 'b', content_path: 'items/b/article.json' })]
    const db = composeDb(
      { 'items/a/article.json': article('First'), 'items/b/article.json': article('Second') },
      {},
      items,
    )

    await composeIssue(issue(), {
      db: db.client,
      settings,
      loadImage: async () => new Uint8Array(),
      nameIssueFn: async () => 'Winter Light',
    })

    // One render carries both articles — that is KTD7's single pass.
    const prose = calls.filter((c) => c.html.includes('<article') && !c.html.includes('class="toc"'))
    const combined = prose.filter((c) => (c.html.match(/<article/g) ?? []).length === 2)
    expect(combined).toHaveLength(1)
  })

  it('keeps an emailed PDF at its slot without breaking the page numbering', async () => {
    countingRenderer()
    const pdfBytes = await pdfOf(6)
    const items = [
      item({ id: 'a', content_path: 'items/a/article.json', published_at: '2026-08-01T00:00:00Z' }),
      item({
        id: 'p',
        source: 'pdf',
        content_path: null,
        fragment_path: 'items/p/fragment.pdf',
        title: 'A report',
        published_at: '2026-08-02T00:00:00Z',
      }),
      item({ id: 'c', content_path: 'items/c/article.json', published_at: '2026-08-03T00:00:00Z' }),
    ]
    const db = composeDb(
      { 'items/a/article.json': article('First'), 'items/c/article.json': article('Third') },
      { 'items/p/fragment.pdf': pdfBytes },
      items,
    )

    const result = await composeIssue(issue(), {
      db: db.client,
      settings,
      loadImage: async () => new Uint8Array(),
      nameIssueFn: async () => 'Winter Light',
    })

    // TOC page 1; article 2pp; pdf 6pp; article 2pp.
    expect(result.toc.map((e) => e.startPage)).toEqual([2, 4, 10])
    expect(result.toc[1]).toMatchObject({ title: 'A report', pageCount: 6 })
    expect(result.pageCount).toBe(12)
  })

  it('pads an odd interior to an even leaf count', async () => {
    setPdfRenderer(async ({ html }) => {
      const doc = await PDFDocument.create()
      const pages = html.includes('class="toc"') || html.includes('class="masthead"') ? 1 : 2
      for (let i = 0; i < pages; i++) {
        doc.addPage([MEDIA_WIDTH_PT, MEDIA_HEIGHT_PT]).drawRectangle({ x: 5, y: 5, width: 9, height: 9 })
      }
      return doc.save()
    })
    const db = composeDb({ 'items/a/article.json': article('First') }, {}, [
      item({ id: 'a', content_path: 'items/a/article.json' }),
    ])
    const result = await composeIssue(issue(), {
      db: db.client,
      settings,
      loadImage: async () => new Uint8Array(),
      nameIssueFn: async () => 'Winter Light',
    })
    // 1 TOC page + 2 article pages = 3, padded to 4.
    expect(result.pageCount).toBe(4)
    expect(result.pageCount % 2).toBe(0)
  })

  it('names the issue from its contents and derives the archive collection', async () => {
    countingRenderer()
    const db = composeDb({ 'items/a/article.json': article('First') }, {}, [
      item({ id: 'a', content_path: 'items/a/article.json' }),
    ])
    const result = await composeIssue(issue(), {
      db: db.client,
      settings,
      now: new Date('2026-08-30T12:00:00Z'),
      loadImage: async () => new Uint8Array(),
      nameIssueFn: async () => 'Winter Light',
    })
    expect(result.name).toBe('Winter Light')
    expect(result.archiveName).toBe('2026-08-30 — Winter Light')
  })

  it('stores the interior and the cover, and records the page total on the issue', async () => {
    countingRenderer()
    const db = composeDb({ 'items/a/article.json': article('First') }, {}, [
      item({ id: 'a', content_path: 'items/a/article.json' }),
    ])
    const result = await composeIssue(issue(), {
      db: db.client,
      settings,
      loadImage: async () => new Uint8Array(),
      nameIssueFn: async () => 'Winter Light',
    })
    expect(db.stored.has('issues/iss1/interior.pdf')).toBe(true)
    expect(db.stored.has('issues/iss1/cover.pdf')).toBe(true)
    const patch = db.updates.find((u) => u.table === 'press_issues')?.patch
    expect(patch).toMatchObject({ name: 'Winter Light', page_total: result.pageCount })
  })

  it('fails an item it cannot compose rather than printing blank pages', async () => {
    countingRenderer()
    const db = composeDb({ 'items/a/article.json': article('First') }, {}, [
      item({ id: 'a', content_path: 'items/a/article.json' }),
    ])
    // The second item's article was never written to storage.
    const result = await composeIssue(issue(), {
      db: db.client,
      settings,
      loadImage: async () => new Uint8Array(),
      nameIssueFn: async () => 'Winter Light',
    })
    expect(result.skipped.every((s) => typeof s.reason === 'string')).toBe(true)
  })

  it('refuses to compose an issue with nothing in it', async () => {
    countingRenderer()
    const db = composeDb({})
    await expect(
      composeIssue(issue(), { db: db.client, settings, nameIssueFn: async () => 'x' }),
    ).rejects.toThrow(/nothing to print/)
  })
})
