/**
 * press — render a sample article with the U4 layout engine so the typography
 * can actually be looked at. Unit tests check the markup and the bookkeeping;
 * they cannot tell you that the dek is too tight or the folio sits wrong.
 *
 *   npx tsx scripts/press-preview.ts              # HTML + PDF into a temp dir
 *   npx tsx scripts/press-preview.ts --html-only  # skip Chromium, HTML only
 *   npx tsx scripts/press-preview.ts --out ./tmp/preview
 *
 * The PDF needs Chromium: Vivliostyle downloads its own Playwright build on
 * first run, or set PRESS_CHROMIUM_PATH to an existing binary. With
 * --html-only (or if no browser is available) you still get index.html +
 * press.css + images/, which open fine in a browser — page boxes will not be
 * paginated there, but the type is all real.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import {
  CSS_FILENAME,
  IMAGE_DIR,
  articleImages,
  buildArticleHtml,
  imageFileName,
  pressCss,
  renderArticle,
} from '../src/lib/press/layout/render'
import type { Article, ArticleImage } from '../src/lib/press/types'

// ── A sample article ─────────────────────────────────────────────────────────
// Deliberately generic filler: this repo is public, so no saved reading of V's
// goes in here. It exercises every block type the layout engine knows.

const LEAD: ArticleImage = {
  path: 'sample/lead.jpg',
  alt: 'A wide field of colour standing in for a lead photograph',
  caption: 'The lead plate runs to the trim on three sides; its caption sits with the title.',
  width: 2400,
  height: 1350,
  orientation: 'landscape',
}

const WIDE: ArticleImage = {
  path: 'sample/wide.jpg',
  alt: 'A landscape plate',
  caption: 'A landscape plate spans both columns — the rule that ruled out WeasyPrint.',
  width: 2000,
  height: 1200,
  orientation: 'landscape',
}

const TALL: ArticleImage = {
  path: 'sample/tall.jpg',
  alt: 'A portrait plate',
  caption: 'A portrait plate stays inside its column.',
  width: 900,
  height: 1400,
  orientation: 'portrait',
}

const FILLER = [
  'A page is a machine for holding attention still. Everything on it — the measure of the column, the leading, the width of the outer margin — exists to keep the eye moving forward without ever asking it where to go next.',
  'Set too wide and the eye loses the return; set too narrow and the words break badly and the rag turns into a picket fence. Two columns on a seven-by-ten page land close to the old rule of thumb: somewhere near sixty-six characters, hyphenated and justified, with enough air at the foot that nothing feels crowded.',
  'The furniture — running heads, folios, captions — is set in a sans, small and quiet, so that it reads as apparatus rather than as text. It should be findable when wanted and invisible otherwise.',
  'What remains is restraint. A single serif for reading, one accent used once, generous white space around the title, and photographs given enough room to be worth reproducing at all.',
]

function sampleArticle(): Article {
  const blocks: Article['blocks'] = [
    { type: 'para', html: FILLER[0] },
    { type: 'para', html: FILLER[1] },
    { type: 'figure', image: WIDE },
    { type: 'heading', level: 2, text: 'On the measure of a column' },
    { type: 'para', html: `${FILLER[2]} Emphasis reads as <em>italic</em>, and a term of art as <strong>bold</strong>.` },
    { type: 'quote', html: 'Typography exists to honour content.', attribution: 'Robert Bringhurst' },
    { type: 'figure', image: TALL },
    { type: 'para', html: FILLER[3] },
    { type: 'heading', level: 3, text: 'A subhead' },
    { type: 'list', ordered: false, items: ['Generous margins.', 'One serif, one sans.', 'Captions that earn their place.'] },
    { type: 'rule' },
    ...FILLER.map((html) => ({ type: 'para' as const, html })),
    ...FILLER.map((html) => ({ type: 'para' as const, html })),
  ]

  return {
    title: 'What a Page Is For',
    byline: 'By A. Compositor',
    sourceName: 'Sample Quarterly',
    url: 'https://example.com/what-a-page-is-for',
    publishedAt: '2026-08-27T00:00:00.000Z',
    dek: 'Notes on setting long-form reading in two columns, and on leaving things out.',
    lead: LEAD,
    blocks,
  }
}

// ── Stand-in photographs, generated locally (no network, no fixtures) ─────────

async function plate(image: ArticleImage, rgb: [number, number, number]): Promise<Uint8Array> {
  const buf = await sharp({
    create: {
      width: Math.round((image.width ?? 1200) / 2),
      height: Math.round((image.height ?? 800) / 2),
      channels: 3,
      background: { r: rgb[0], g: rgb[1], b: rgb[2] },
    },
  })
    .jpeg({ quality: 82 })
    .toBuffer()
  return new Uint8Array(buf)
}

const PLATES: Record<string, [number, number, number]> = {
  'sample/lead.jpg': [58, 74, 88],
  'sample/wide.jpg': [120, 106, 82],
  'sample/tall.jpg': [86, 96, 74],
}

async function loadImage(storagePath: string): Promise<Uint8Array> {
  const image = [LEAD, WIDE, TALL].find((i) => i.path === storagePath)
  if (!image) throw new Error(`press-preview: unknown sample image ${storagePath}`)
  return plate(image, PLATES[storagePath] ?? [128, 128, 128])
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const htmlOnly = argv.includes('--html-only')
  const outFlag = argv.indexOf('--out')
  const outDir =
    outFlag >= 0 && argv[outFlag + 1]
      ? path.resolve(argv[outFlag + 1])
      : path.join(os.tmpdir(), `press-preview-${Date.now()}`)

  const article = sampleArticle()
  const options = { issueNumber: 1, startPage: 1 }

  await mkdir(path.join(outDir, IMAGE_DIR), { recursive: true })
  await writeFile(path.join(outDir, 'index.html'), buildArticleHtml(article, options), 'utf8')
  await writeFile(path.join(outDir, CSS_FILENAME), pressCss(), 'utf8')
  for (const image of articleImages(article)) {
    await writeFile(path.join(outDir, IMAGE_DIR, imageFileName(image.path)), await loadImage(image.path))
  }
  console.log(`HTML  ${path.join(outDir, 'index.html')}`)

  if (htmlOnly) return

  try {
    const { pdf, pageCount } = await renderArticle(article, options, { loadImage })
    const pdfPath = path.join(outDir, 'preview.pdf')
    await writeFile(pdfPath, pdf)
    console.log(`PDF   ${pdfPath}  (${pageCount} pages)`)
  } catch (error) {
    console.error(`\nPDF render failed: ${error instanceof Error ? error.message : String(error)}`)
    console.error(
      'Vivliostyle needs a Chromium build. Install one (npx playwright install chromium)\n' +
        'or point PRESS_CHROMIUM_PATH at an existing binary. The HTML above is still usable.',
    )
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
