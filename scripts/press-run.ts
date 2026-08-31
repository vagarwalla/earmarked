/**
 * press — the whole loop, run locally.
 *
 * The deployed design (Supabase + Vercel + a Fly worker) exists because the
 * approval pages and the worker are separate runtimes that must share state.
 * Run from one machine, none of that is needed: state is a JSON file, storage
 * is a directory, and the loop is the same code the worker would run.
 *
 *   npx tsx scripts/press-run.ts            # poll, extract, report
 *   npx tsx scripts/press-run.ts --compose  # also build the issue when it is ready
 *   npx tsx scripts/press-run.ts --compose --force   # build it early
 *
 * Everything lives in .press/ (gitignored). Reads credentials from .env.local:
 * run with `node --env-file=.env.local` or export them first.
 *
 * The one step this cannot do is place the order: Lulu fetches the interior
 * from a URL, so an API order needs the PDFs hosted somewhere public. It
 * prints the exact quote and the file to upload instead.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createRaindropClient, raindropToItem, type Raindrop } from '../src/lib/press/raindrop'
import { extractFromUrl, ExtractionError } from '../src/lib/press/extract'
import { fetchAndStoreImage, type CandidateImage, type StoredImage } from '../src/lib/press/images'
import {
  articleImages,
  buildArticleSection,
  buildDocument,
  imageFileName,
  pdfPageCount,
  renderHtml,
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
import { nameIssue, archiveCollectionName } from '../src/lib/press/naming'
import { createLuluClient, formatQuote } from '../src/lib/press/lulu'
import { loadSettings } from '../src/lib/press/settings'
import { PRINT_SPEC, type Article, type PressItem, type TocEntry } from '../src/lib/press/types'

const ROOT = path.join(process.cwd(), '.press')
const STATE_FILE = path.join(ROOT, 'state.json')

// ── State ────────────────────────────────────────────────────────────────────

interface Item {
  id: string
  url: string
  raindropId: string
  title: string | null
  state: 'queued' | 'laid_out' | 'printed' | 'failed' | 'skipped'
  pageCount?: number
  reason?: string
  savedAt: string
}

interface State {
  issueNumber: number
  items: Item[]
  /** Raindrop ids already seen, so a poll never re-ingests. */
  seen: string[]
  printed: { number: number; name: string; orderedAt: string; itemIds: string[] }[]
}

async function loadState(): Promise<State> {
  if (!existsSync(STATE_FILE)) return { issueNumber: 1, items: [], seen: [], printed: [] }
  return JSON.parse(await readFile(STATE_FILE, 'utf8')) as State
}

async function saveState(state: State): Promise<void> {
  await mkdir(ROOT, { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2))
}

const sum = (items: Item[]): number => items.reduce((n, i) => n + (i.pageCount ?? 0), 0)

const itemDir = (id: string) => path.join(ROOT, 'items', id)
const store = async (storagePath: string, body: Uint8Array | string): Promise<string> => {
  const full = path.join(ROOT, storagePath)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, typeof body === 'string' ? body : Buffer.from(body))
  return storagePath
}
const load = async (storagePath: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(path.join(ROOT, storagePath)))

// ── Steps ────────────────────────────────────────────────────────────────────

/**
 * The articles that make up the next issue: oldest saves first, accumulating
 * until the issue crosses the threshold. The deployed pipeline gets this for
 * free because saves trickle in over weeks; run against a backlog that all
 * arrived at once, the whole pile would otherwise become one 300-page brick.
 * The remainder simply rolls into the following issue.
 */
/**
 * Reference pages, not reading. An org's About page or a docs index extracts
 * into several plausible pages of prose, then gets a full magazine opener
 * headlined "About" — which reads as a mistake in a printed contents list.
 * The tell is a bare generic noun where a title should be.
 *
 * Marked `skipped` rather than dropped, and always reported: the call is V's,
 * and un-skipping is a one-word edit in .press/state.json.
 */
const GENERIC_TITLES = [
  /^about(\s+us)?$/i, /^home$/i, /^index$/i, /^untitled$/i, /^overview$/i,
  /^team$/i, /^our team$/i, /^contact(\s+us)?$/i, /^careers?$/i, /^jobs$/i,
  /^faq$/i, /^docs?$/i, /^documentation$/i, /^mission$/i, /^welcome$/i,
  /^getting started$/i, /^resources$/i,
]

export function isReferencePage(title: string | null): boolean {
  if (!title) return false
  return GENERIC_TITLES.some((re) => re.test(title.trim()))
}

function selectForIssue(items: Item[], threshold: number): Item[] {
  const ready = items
    .filter((i) => i.state === 'laid_out')
    .sort((a, b) => a.savedAt.localeCompare(b.savedAt))

  const chosen: Item[] = []
  let total = 0
  for (const item of ready) {
    chosen.push(item)
    total += item.pageCount ?? 0
    if (total >= threshold) break
  }
  return chosen
}

async function poll(state: State): Promise<number> {
  const settings = loadSettings()
  const client = createRaindropClient({ token: settings.raindropToken })
  const drops: Raindrop[] = await client.listRaindrops(settings.raindropCollectionId, { perPage: 50 })

  let added = 0
  for (const drop of drops) {
    const id = String(drop._id)
    if (state.seen.includes(id)) continue
    state.seen.push(id)
    const base = raindropToItem(drop) as Partial<PressItem>
    state.items.push({
      id,
      url: base.url ?? drop.link,
      raindropId: id,
      title: base.title ?? null,
      state: 'queued',
      savedAt: drop.created ?? new Date().toISOString(),
    })
    added++
  }
  return added
}

async function processQueued(state: State): Promise<void> {
  const queued = state.items.filter((i) => i.state === 'queued')
  if (queued.length === 0) return

  for (const item of queued) {
    try {
      const { article } = await extractFromUrl({
        itemId: item.id,
        url: item.url,
        raindropId: item.raindropId,
        deps: {
          storeImages: (async (itemId: string, candidates: CandidateImage[]) => {
            const out: StoredImage[] = []
            let n = 0
            for (const c of candidates) {
              const image = await fetchAndStoreImage(itemId, c, n, { store })
              if (image) {
                out.push(image)
                n++
              }
            }
            return out
          }) as never,
        },
      })

      await mkdir(itemDir(item.id), { recursive: true })
      await store(`items/${item.id}/article.json`, JSON.stringify(article))

      const html = buildDocument([buildArticleSection({ article })], {
        issueNumber: state.issueNumber,
        startPage: 1,
        documentTitle: article.title,
      })
      const images = new Map<string, Uint8Array>()
      for (const image of articleImages(article)) {
        images.set(imageFileName(image.path), await load(image.path))
      }
      const { pageCount } = await renderHtml(html, images)

      item.title = article.title
      item.pageCount = pageCount

      if (isReferencePage(article.title)) {
        item.state = 'skipped'
        item.reason = 'reference page, not an article'
        console.log(`  – ${String(pageCount).padStart(3)}pp  ${article.title}  (skipped: reference page)`)
      } else {
        item.state = 'laid_out'
        console.log(`  ✓ ${String(pageCount).padStart(3)}pp  ${article.title}`)
      }
    } catch (err) {
      item.state = 'failed'
      item.reason = err instanceof ExtractionError ? err.message : (err as Error).message
      console.log(`  ✗        ${item.url}\n           ${item.reason}`)
    }
  }
}

async function compose(state: State, force: boolean): Promise<void> {
  const settings = loadSettings()
  const all = state.items.filter((i) => i.state === 'laid_out')
  const ready = force && all.length > 0 && sum(all) < settings.pageThreshold
    ? all
    : selectForIssue(state.items, settings.pageThreshold)
  const total = sum(ready)
  const held = all.length - ready.length

  if (!force && total < settings.pageThreshold) return
  if (ready.length === 0) return console.log('\nnothing to compose')
  if (total < PRINT_SPEC.minPages) {
    return console.log(`\n${total} pages — Lulu needs ${PRINT_SPEC.minPages} to perfect-bind. Save more.`)
  }

  console.log(`\ncomposing issue ${state.issueNumber} (${total} measured pages${held > 0 ? `, ${held} articles held for the next issue` : ''})…`)
  const outDir = path.join(ROOT, `issue-${state.issueNumber}`)
  await mkdir(outDir, { recursive: true })

  const entries: ComposeEntry[] = []
  for (const item of ready) {
    const article = JSON.parse(
      new TextDecoder().decode(await load(`items/${item.id}/article.json`)),
    ) as Article
    entries.push({ kind: 'article', item: { id: item.id, title: item.title } as PressItem, article })
  }

  const render = async (html: string) => {
    const images = new Map<string, Uint8Array>()
    for (const e of entries) {
      if (e.kind !== 'article') continue
      for (const image of articleImages(e.article)) {
        if (!images.has(imageFileName(image.path))) images.set(imageFileName(image.path), await load(image.path))
      }
    }
    return renderHtml(html, images)
  }

  const pageCounts = ready.map((i) => i.pageCount ?? 1)
  const name = await nameIssue({
    issueNumber: state.issueNumber,
    toc: computeToc(entries, pageCounts, 0),
    apiKey: settings.anthropicApiKey,
  })

  let frontPages = 1
  let toc: TocEntry[] = computeToc(entries, pageCounts, frontPages)
  const renderFront = async (t: TocEntry[]) =>
    render(
      buildDocument([buildTocSection(name, state.issueNumber, t)], {
        issueNumber: state.issueNumber,
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

  const prose = await render(
    buildDocument(
      entries.map((e, i) => buildArticleSection({ article: (e as { article: Article }).article }, i)),
      { issueNumber: state.issueNumber, startPage: toc[0].startPage, documentTitle: name },
    ),
  )

  const interior = await padToEven(await mergePdfs([front.pdf, prose.pdf]))
  const pages = await pdfPageCount(interior)
  const problems = await preflightInterior(interior)
  const cover = await render(
    buildCoverHtml({
      issueName: name,
      issueNumber: state.issueNumber,
      pageCount: pages,
      dateRange: '',
      toc,
    }),
  )

  await writeFile(path.join(outDir, 'interior.pdf'), interior)
  await writeFile(path.join(outDir, 'cover.pdf'), cover.pdf)
  await writeFile(path.join(outDir, 'toc.json'), JSON.stringify(toc, null, 2))
  // The name only exists at compose time; the review UI at /press reads it back.
  await writeFile(
    path.join(outDir, 'meta.json'),
    JSON.stringify(
      {
        number: state.issueNumber,
        name,
        pageCount: pages,
        builtAt: new Date().toISOString(),
        preflight: problems,
        articles: ready.map((i) => ({ id: i.id, title: i.title, url: i.url, pageCount: i.pageCount })),
      },
      null,
      2,
    ),
  )

  console.log(`\n── ${name} · Issue ${state.issueNumber} ──`)
  for (const e of toc) console.log(`   p.${String(e.startPage).padStart(3)}  ${e.title}`)
  console.log(`\n   ${pages} pages · preflight ${problems.length ? problems.map((p) => p.code).join(', ') : 'clean'}`)

  // Quote it, so the cost is known before anything is ordered.
  if (settings.luluClientKey && settings.shipping) {
    try {
      const quote = await createLuluClient({ settings }).quote(
        { title: name, packageId: settings.luluPackageId, pageCount: pages, quantity: 1 },
        settings.shipping,
      )
      console.log(`   ${formatQuote(quote)}`)
    } catch (err) {
      console.log(`   quote unavailable: ${(err as Error).message.slice(0, 90)}`)
    }
  } else {
    console.log('   (set PRESS_SHIP_* to get a live Lulu quote)')
  }

  console.log(`\n   ${path.join(outDir, 'interior.pdf')}`)
  console.log(`   ${path.join(outDir, 'cover.pdf')}`)
  console.log(`\n   Upload both at lulu.com to order, then run with --printed to archive.`)
  console.log(`   Archive collection would be: ${archiveCollectionName(new Date(), name)}`)
}

/** After a copy has actually been ordered: move the raindrops and open the next issue. */
async function markPrinted(state: State): Promise<void> {
  const settings = loadSettings()
  const ready = selectForIssue(state.items, settings.pageThreshold)
  if (ready.length === 0) return console.log('nothing to archive')

  const entries: ComposeEntry[] = []
  for (const item of ready) {
    entries.push({ kind: 'article', item: { id: item.id, title: item.title } as PressItem, article: {} as Article })
  }
  const name = await nameIssue({
    issueNumber: state.issueNumber,
    toc: computeToc(entries, ready.map((i) => i.pageCount ?? 1), 0).map((t, i) => ({
      ...t,
      title: ready[i].title ?? t.title,
    })),
    apiKey: settings.anthropicApiKey,
  })

  const client = createRaindropClient({ token: settings.raindropToken })
  const collectionName = archiveCollectionName(new Date(), name)
  const collection = await client.createCollection(collectionName)
  const moved = await client.moveRaindrops(ready.map((i) => i.raindropId), String(collection._id))

  for (const item of ready) item.state = 'printed'
  state.printed.push({
    number: state.issueNumber,
    name,
    orderedAt: new Date().toISOString(),
    itemIds: ready.map((i) => i.id),
  })
  state.issueNumber += 1

  console.log(`archived ${moved} raindrops → "${collectionName}"`)
  console.log(`next issue is number ${state.issueNumber}`)
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const state = await loadState()
  const settings = loadSettings()

  if (argv.includes('--printed')) {
    await markPrinted(state)
    await saveState(state)
    return
  }

  console.log('polling hw…')
  const added = await poll(state)
  console.log(`${added} new save${added === 1 ? '' : 's'}\n`)
  await saveState(state)

  if (added > 0) console.log('extracting…')
  await processQueued(state)
  await saveState(state)

  const ready = state.items.filter((i) => i.state === 'laid_out')
  const failed = state.items.filter((i) => i.state === 'failed')
  const total = ready.reduce((n, i) => n + (i.pageCount ?? 0), 0)

  console.log(`\nissue ${state.issueNumber}: ${ready.length} articles, ${total} pages of ${settings.pageThreshold}`)
  for (const item of ready) {
    console.log(`   ${String(item.pageCount).padStart(3)}pp  ${item.title ?? item.url}`)
  }
  const skipped = state.items.filter((i) => i.state === 'skipped')
  if (skipped.length) {
    console.log(`\n${skipped.length} skipped as reference pages (edit .press/state.json to include one):`)
    for (const item of skipped) console.log(`   ${item.title} — ${item.url}`)
  }
  if (failed.length) {
    console.log(`\n${failed.length} failed:`)
    for (const item of failed) console.log(`   ${item.url}\n      ${item.reason}`)
  }

  if (argv.includes('--compose')) {
    await compose(state, argv.includes('--force'))
  } else if (total >= settings.pageThreshold) {
    console.log(`\nready to print — run with --compose`)
  } else {
    console.log(`\n${settings.pageThreshold - total} more pages to go`)
  }

  await saveState(state)
}

main().catch((err) => {
  console.error(`\npress: ${(err as Error).message}`)
  process.exit(1)
})
