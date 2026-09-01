/**
 * press — compile a real issue from a list of article URLs, with no Supabase,
 * no Raindrop, and no Lulu account.
 *
 * This is the U0 pilot path from the plan, done properly: it runs the actual
 * extraction ladder and the actual layout engine, so what comes out is what
 * the deployed pipeline would print — not a print-to-PDF approximation.
 *
 *   npx tsx scripts/press-compile.ts urls.txt
 *   npx tsx scripts/press-compile.ts urls.txt --out ./issue --name "Winter Light" --number 1
 *   npx tsx scripts/press-compile.ts urls.txt --html-only
 *
 * urls.txt is one URL per line; blank lines and `#` comments are ignored, and
 * anything after whitespace on a line is ignored too, so a pasted "URL — note"
 * list works as-is.
 *
 * Storage is the output directory rather than the `press` bucket, and the
 * issue is composed from the pure helpers in compose.ts, so nothing here
 * touches the database.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  articleImages,
  buildArticleSection,
  buildDocument,
  imageFileName,
  pdfPageCount,
  renderHtml,
  type ArticleEntry,
} from '../src/lib/press/layout/render'
import {
  buildCoverHtml,
  buildTocSection,
  computeToc,
  mergePdfs,
  padToEven,
  preflightInterior,
  type ComposeEntry,
} from '../src/lib/press/compose'
import { extractFromUrl, ExtractionError } from '../src/lib/press/extract'
import { fetchAndStoreImage, type CandidateImage, type StoredImage } from '../src/lib/press/images'
import { nameIssue } from '../src/lib/press/naming'
import { detectArticleLanguage, translateArticle } from '../src/lib/press/translate'
import type { Article, PressItem, TocEntry } from '../src/lib/press/types'

// ── Arguments ────────────────────────────────────────────────────────────────

interface Options {
  urlFile: string
  outDir: string
  issueName: string | null
  issueNumber: number
  htmlOnly: boolean
  translate: boolean
}

function parseArgs(argv: string[]): Options {
  const positional = argv.filter((a) => !a.startsWith('--'))
  const flag = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 ? null : (argv[i + 1] ?? null)
  }
  if (positional.length === 0) {
    throw new Error('usage: npx tsx scripts/press-compile.ts <urls.txt> [--out DIR] [--name NAME] [--number N] [--html-only] [--no-translate]')
  }
  return {
    urlFile: positional[0],
    outDir: flag('out') ?? path.join(os.tmpdir(), `press-issue-${Date.now()}`),
    issueName: flag('name'),
    issueNumber: Number.parseInt(flag('number') ?? '1', 10) || 1,
    htmlOnly: argv.includes('--html-only'),
    translate: !argv.includes('--no-translate'),
  }
}

export function parseUrlList(text: string): string[] {
  const seen = new Set<string>()
  const urls: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    // Tolerate "https://… — my note" and markdown list bullets.
    const match = line.match(/https?:\/\/\S+/)
    if (!match) continue
    const url = match[0].replace(/[),.]+$/, '')
    if (seen.has(url)) continue
    seen.add(url)
    urls.push(url)
  }
  return urls
}

// ── Local storage, standing in for the press bucket ──────────────────────────

function localStore(outDir: string) {
  const files = new Map<string, Uint8Array>()

  const store = async (storagePath: string, body: Uint8Array | string): Promise<string> => {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
    files.set(storagePath, bytes)
    return storagePath
  }

  const load = async (storagePath: string): Promise<Uint8Array> => {
    const bytes = files.get(storagePath)
    if (!bytes) throw new Error(`missing local object ${storagePath}`)
    return bytes
  }

  /** Write every image out next to the HTML, the way the renderer expects. */
  const flushImages = async (images: { path: string }[]): Promise<void> => {
    await mkdir(path.join(outDir, 'images'), { recursive: true })
    for (const image of images) {
      await writeFile(path.join(outDir, 'images', imageFileName(image.path)), await load(image.path))
    }
  }

  return { store, load, flushImages, files }
}

/**
 * Translate an article that did not arrive in English.
 *
 * Detection is a cheap call per article and it answers "English" for almost
 * all of them, which is the cost of not having to hand-label a URL list. When
 * the language cannot be established the piece is left exactly as extracted —
 * an uncertain detection must not start a translation.
 */
async function translateIfForeign(
  article: Article,
  apiKey: string | null,
  label: string,
): Promise<Article> {
  if (!apiKey) return article

  const language = await detectArticleLanguage({ article, apiKey })
  if (!language || /^english$/i.test(language)) return article

  console.log(`${label} … translating from the ${language}`)
  return translateArticle({ article, sourceLanguage: language, apiKey })
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const urls = parseUrlList(await readFile(opts.urlFile, 'utf8'))
  if (urls.length === 0) throw new Error(`no URLs found in ${opts.urlFile}`)

  await mkdir(opts.outDir, { recursive: true })
  const storage = localStore(opts.outDir)
  const apiKey = process.env.ANTHROPIC_API_KEY ?? null

  console.log(`press: compiling ${urls.length} article${urls.length === 1 ? '' : 's'}\n`)

  // ── Extract ───────────────────────────────────────────────────────────────
  const articles: { url: string; article: Article }[] = []
  const failures: { url: string; reason: string }[] = []

  for (const [i, url] of urls.entries()) {
    const label = `[${String(i + 1).padStart(2)}/${urls.length}]`
    try {
      const { article, rung } = await extractFromUrl({
        itemId: `a${String(i).padStart(3, '0')}`,
        url,
        deps: {
          // Images are stored locally instead of in the bucket.
          storeImages: (async (itemId: string, candidates: CandidateImage[]) => {
            const out: StoredImage[] = []
            let n = 0
            for (const candidate of candidates) {
              const image = await fetchAndStoreImage(itemId, candidate, n, { store: storage.store })
              if (image) {
                out.push(image)
                n++
              }
            }
            return out
          }) as never,
        },
      })
      // Translation happens here, before anything measures or names the
      // issue, so the rest of the pipeline never sees a language it cannot
      // set. A failure throws into the catch below and the piece is reported
      // as a failure rather than printed in a language nobody can read.
      const translated = opts.translate
        ? await translateIfForeign(article, apiKey, label)
        : article

      articles.push({ url, article: translated })
      const images = articleImages(translated).length + (translated.lead ? 1 : 0)
      console.log(`${label} ✓ ${translated.title}  (${rung}, ${images} image${images === 1 ? '' : 's'})`)
    } catch (err) {
      const reason = err instanceof ExtractionError ? `${err.message} [tried: ${err.attempted.join(' → ')}]` : (err as Error).message
      failures.push({ url, reason })
      console.log(`${label} ✗ ${url}\n         ${reason}`)
    }
  }

  if (articles.length === 0) throw new Error('nothing could be extracted — no issue to compile')

  // ── Compose ───────────────────────────────────────────────────────────────
  console.log('')
  const entries: ComposeEntry[] = articles.map(({ article }, i) => ({
    kind: 'article',
    item: { id: `a${String(i).padStart(3, '0')}`, title: article.title } as PressItem,
    article,
  }))

  const render = async (html: string) => {
    const images = entries.flatMap((e) => (e.kind === 'article' ? articleImages(e.article) : []))
    const map = new Map<string, Uint8Array>()
    for (const image of images) {
      const name = imageFileName(image.path)
      if (!map.has(name)) map.set(name, await storage.load(image.path))
    }
    return renderHtml(html, map, { loadImage: storage.load })
  }

  // Measure each article at the current template version (KTD7).
  const pageCounts: number[] = []
  for (const [i, entry] of entries.entries()) {
    if (entry.kind !== 'article') continue
    const html = buildDocument([buildArticleSection({ article: entry.article })], {
      issueNumber: opts.issueNumber,
      startPage: 1,
      documentTitle: entry.article.title,
    })
    const { pageCount } = await render(html)
    pageCounts.push(pageCount)
    console.log(`   ${entry.article.title} — ${pageCount} page${pageCount === 1 ? '' : 's'}`)
    void i
  }

  const name =
    opts.issueName ??
    (await nameIssue({
      issueNumber: opts.issueNumber,
      toc: computeToc(entries, pageCounts, 0),
      apiKey,
    }))

  // Front matter, then the numbers it produces.
  let frontPages = 1
  let toc: TocEntry[] = computeToc(entries, pageCounts, frontPages)
  const renderFront = async (t: TocEntry[]) =>
    render(
      buildDocument([buildTocSection(name, opts.issueNumber, t)], {
        issueNumber: opts.issueNumber,
        startPage: 1,
        measurement: true,
        documentTitle: name,
      }),
    )
  let front = await renderFront(toc)
  if (front.pageCount !== frontPages) {
    frontPages = front.pageCount
    toc = computeToc(entries, pageCounts, frontPages)
    front = await renderFront(toc)
  }

  // The prose, in a single pass with one continuous counter.
  const articleEntries: ArticleEntry[] = entries
    .filter((e): e is Extract<ComposeEntry, { kind: 'article' }> => e.kind === 'article')
    .map((e) => ({ article: e.article, id: `article-${e.item.id}` }))
  const proseHtml = buildDocument(
    articleEntries.map((e, i) => buildArticleSection(e, i)),
    { issueNumber: opts.issueNumber, startPage: toc[0].startPage, documentTitle: name },
  )
  const prose = await render(proseHtml)

  const interior = await padToEven(await mergePdfs([front.pdf, prose.pdf]))
  const pageCount = await pdfPageCount(interior)
  const problems = await preflightInterior(interior)

  const coverHtml = buildCoverHtml({
    issueName: name,
    issueNumber: opts.issueNumber,
    pageCount,
    dateRange: dateRange(articles.map((a) => a.article.publishedAt)),
    toc,
  })
  const cover = await render(coverHtml)

  // ── Write ─────────────────────────────────────────────────────────────────
  await storage.flushImages(entries.flatMap((e) => (e.kind === 'article' ? articleImages(e.article) : [])))
  await writeFile(path.join(opts.outDir, 'interior.html'), proseHtml)
  await writeFile(path.join(opts.outDir, 'cover.html'), coverHtml)
  await writeFile(path.join(opts.outDir, 'toc.json'), JSON.stringify(toc, null, 2))
  if (!opts.htmlOnly) {
    await writeFile(path.join(opts.outDir, 'interior.pdf'), interior)
    await writeFile(path.join(opts.outDir, 'cover.pdf'), cover.pdf)
  }

  console.log(`\n── ${name} · Issue ${opts.issueNumber} ──`)
  for (const entry of toc) console.log(`   p.${String(entry.startPage).padStart(3)}  ${entry.title}`)
  console.log(`\n   ${pageCount} pages${pageCount % 2 === 0 ? '' : ' (odd!)'}`)
  if (problems.length) {
    console.log('\n   preflight:')
    for (const p of problems.slice(0, 6)) console.log(`     ${p.code}: ${p.detail}`)
    if (pageCount < 32) console.log('     → Lulu needs 32+ pages to perfect-bind; add more articles.')
  } else {
    console.log('   preflight: clean')
  }
  if (failures.length) {
    console.log(`\n   ${failures.length} could not be extracted:`)
    for (const f of failures) console.log(`     ${f.url}`)
  }
  console.log(`\n   ${opts.outDir}`)
}

function dateRange(dates: (string | null)[]): string {
  const parsed = dates
    .filter((d): d is string => Boolean(d))
    .map((d) => new Date(d))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime())
  if (parsed.length === 0) return ''
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return fmt(parsed[0]) === fmt(parsed[parsed.length - 1])
    ? fmt(parsed[0])
    : `${fmt(parsed[0])} – ${fmt(parsed[parsed.length - 1])}`
}

// Guarded: press-links.ts imports parseUrlList from here, and an unguarded
// main() would start compiling an issue as a side effect of that import.
if (process.argv[1]?.endsWith('press-compile.ts')) {
  main().catch((err) => {
    console.error(`\npress: ${(err as Error).message}`)
    process.exit(1)
  })
}
