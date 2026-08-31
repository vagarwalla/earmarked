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
 *
 * State is shared with the editor at /press, which may be open in a dev server
 * while this runs — so every write goes through `withStateLock`, and the long
 * steps (extraction, rendering) happen outside it.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRaindropClient, raindropToItem, type Raindrop } from '../src/lib/press/raindrop'
import { extractFromUrl, ExtractionError } from '../src/lib/press/extract'
import { fetchAndStoreImage, type CandidateImage, type StoredImage } from '../src/lib/press/images'
import {
  articleImages,
  buildArticleSection,
  buildDocument,
  imageFileName,
  renderHtml,
} from '../src/lib/press/layout/render'
import { buildIssue, BuildError } from '../src/lib/press/build'
import {
  PRESS_ROOT,
  ensureDraft,
  estimatePages,
  findDraft,
  readState,
  readyItems,
  selectForIssue,
  withStateLock,
  type PressState,
  type StateItem,
} from '../src/lib/press/issues'
import { archiveCollectionName, nameIssue } from '../src/lib/press/naming'
import { computeToc, type ComposeEntry } from '../src/lib/press/compose'
import { createLuluClient, formatQuote } from '../src/lib/press/lulu'
import { loadSettings } from '../src/lib/press/settings'
import { PRINT_SPEC, type Article, type PressItem } from '../src/lib/press/types'

const ROOT = PRESS_ROOT

const sum = (items: StateItem[]): number => items.reduce((n, i) => n + (i.pageCount ?? 0), 0)

const itemDir = (id: string) => path.join(ROOT, 'items', id)
const store = async (storagePath: string, body: Uint8Array | string): Promise<string> => {
  const full = path.join(ROOT, storagePath)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, typeof body === 'string' ? body : Buffer.from(body))
  return storagePath
}
const load = async (storagePath: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(path.join(ROOT, storagePath)))

// ── Steps ─────────────────────────────────────────────────────────────────────

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

async function poll(state: PressState): Promise<number> {
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

/** What extracting one item concluded, ready to be written back under the lock. */
type ItemOutcome = Pick<StateItem, 'title' | 'state' | 'pageCount' | 'reason'>

/**
 * Extract and measure everything queued.
 *
 * Each article is a network fetch and a Chromium render, so this runs on a
 * snapshot with no lock held and reports its conclusions per item id; the
 * caller writes them back. Holding the state lock across a 30-article backlog
 * would freeze the editor for the duration.
 */
async function processQueued(
  queued: StateItem[],
  issueNumber: number,
): Promise<Map<string, ItemOutcome>> {
  const outcomes = new Map<string, ItemOutcome>()

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
        issueNumber,
        startPage: 1,
        documentTitle: article.title,
      })
      const images = new Map<string, Uint8Array>()
      for (const image of articleImages(article)) {
        images.set(imageFileName(image.path), await load(image.path))
      }
      const { pageCount } = await renderHtml(html, images)

      if (isReferencePage(article.title)) {
        outcomes.set(item.id, {
          title: article.title,
          pageCount,
          state: 'skipped',
          reason: 'reference page, not an article',
        })
        console.log(`  – ${String(pageCount).padStart(3)}pp  ${article.title}  (skipped: reference page)`)
      } else {
        outcomes.set(item.id, { title: article.title, pageCount, state: 'laid_out' })
        console.log(`  ✓ ${String(pageCount).padStart(3)}pp  ${article.title}`)
      }
    } catch (err) {
      const reason = err instanceof ExtractionError ? err.message : (err as Error).message
      outcomes.set(item.id, { title: item.title, state: 'failed', reason })
      console.log(`  ✗        ${item.url}\n           ${reason}`)
    }
  }

  return outcomes
}

/**
 * The contents of the next issue, made durable.
 *
 * The first time round this is the selection this script would have made
 * anyway; after that it is whatever the editor at /press has left in
 * `state.json`. Written before anything is rendered, so a build that dies
 * halfway still leaves the decision recorded.
 */
async function resolveDraftItems(force: boolean): Promise<StateItem[]> {
  const settings = loadSettings()

  const itemIds = await withStateLock((state) => {
    const existing = findDraft(state, state.issueNumber)
    if (existing) return existing.itemIds

    const ready = readyItems(state)
    // --force builds early, so it takes everything waiting rather than
    // stopping at a threshold it is never going to reach.
    const seed = force && ready.length > 0 && sum(ready) < settings.pageThreshold
      ? ready
      : selectForIssue(state, settings.pageThreshold)
    return ensureDraft(state, state.issueNumber, seed.map((i) => i.id)).itemIds
  })

  const state = await readState()
  const byId = new Map((state?.items ?? []).map((i) => [i.id, i]))
  return itemIds.map((id) => byId.get(id)).filter((i): i is StateItem => Boolean(i))
}

async function compose(force: boolean): Promise<void> {
  const settings = loadSettings()
  const state = await readState()
  const issueNumber = state?.issueNumber ?? 1

  const chosen = await resolveDraftItems(force)
  const total = sum(chosen)
  const held = readyItems(state).length - chosen.length

  if (!force && total < settings.pageThreshold) return
  if (chosen.length === 0) return console.log('\nnothing to compose')
  if (total < PRINT_SPEC.minPages) {
    return console.log(`\n${total} pages — Lulu needs ${PRINT_SPEC.minPages} to perfect-bind. Save more.`)
  }

  console.log(
    `\ncomposing issue ${issueNumber} (${total} measured pages` +
      `${held > 0 ? `, ${held} articles held for the next issue` : ''})...`,
  )

  let built
  try {
    built = await buildIssue({
      number: issueNumber,
      items: chosen.map((i) => ({ id: i.id, title: i.title, url: i.url, pageCount: i.pageCount })),
      apiKey: settings.anthropicApiKey,
      onProgress: (message) => console.log(`   ${message}…`),
    })
  } catch (err) {
    if (err instanceof BuildError) return console.log(`\n${err.message}`)
    throw err
  }

  console.log(`\n── ${built.name} · Issue ${issueNumber} ──`)
  for (const e of built.toc) console.log(`   p.${String(e.startPage).padStart(3)}  ${e.title}`)
  console.log(
    `\n   ${built.pageCount} pages · preflight ` +
      `${built.preflight.length ? built.preflight.map((p) => p.code).join(', ') : 'clean'}`,
  )

  // Quote it, so the cost is known before anything is ordered.
  if (settings.luluClientKey && settings.shipping) {
    try {
      const quote = await createLuluClient({ settings }).quote(
        { title: built.name, packageId: settings.luluPackageId, pageCount: built.pageCount, quantity: 1 },
        settings.shipping,
      )
      console.log(`   ${formatQuote(quote)}`)
    } catch (err) {
      console.log(`   quote unavailable: ${(err as Error).message.slice(0, 90)}`)
    }
  } else {
    console.log('   (set PRESS_SHIP_* to get a live Lulu quote)')
  }

  console.log(`\n   ${path.join(built.outDir, 'interior.pdf')}`)
  console.log(`   ${path.join(built.outDir, 'cover.pdf')}`)
  console.log(`\n   Upload both at lulu.com to order, then run with --printed to archive.`)
  console.log(`   Archive collection would be: ${archiveCollectionName(new Date(), built.name)}`)
}

/** After a copy has actually been ordered: move the raindrops and open the next issue. */
async function markPrinted(): Promise<void> {
  const settings = loadSettings()
  const chosen = await resolveDraftItems(true)
  if (chosen.length === 0) return console.log('nothing to archive')

  const entries: ComposeEntry[] = chosen.map((item) => ({
    kind: 'article',
    item: { id: item.id, title: item.title } as PressItem,
    article: {} as Article,
  }))
  const name = await nameIssue({
    issueNumber: (await readState())?.issueNumber ?? 1,
    toc: computeToc(entries, chosen.map((i) => i.pageCount ?? 1), 0).map((t, i) => ({
      ...t,
      title: chosen[i].title ?? t.title,
    })),
    apiKey: settings.anthropicApiKey,
  })

  const client = createRaindropClient({ token: settings.raindropToken })
  const collectionName = archiveCollectionName(new Date(), name)
  const collection = await client.createCollection(collectionName)
  const moved = await client.moveRaindrops(chosen.map((i) => i.raindropId), String(collection._id))

  const nextNumber = await withStateLock((state) => {
    const ids = new Set(chosen.map((i) => i.id))
    for (const item of state.items) if (ids.has(item.id)) item.state = 'printed'

    // The draft is kept and sealed rather than deleted: a printed issue's
    // contents stay inspectable, and its articles stay visibly spoken for.
    const draft = ensureDraft(state, state.issueNumber, [...ids])
    draft.state = 'ordered'

    state.printed.push({
      number: state.issueNumber,
      name,
      orderedAt: new Date().toISOString(),
      itemIds: draft.itemIds,
    })
    state.issueNumber += 1
    return state.issueNumber
  })

  console.log(`archived ${moved} raindrops → "${collectionName}"`)
  console.log(`next issue is number ${nextNumber}`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const settings = loadSettings()

  if (argv.includes('--printed')) {
    await markPrinted()
    return
  }

  console.log('polling hw…')
  const added = await withStateLock((state) => poll(state))
  console.log(`${added} new save${added === 1 ? '' : 's'}\n`)

  const queued = (await readState())?.items.filter((i) => i.state === 'queued') ?? []
  if (queued.length > 0) {
    console.log('extracting…')
    const outcomes = await processQueued(queued, (await readState())?.issueNumber ?? 1)
    await withStateLock((state) => {
      for (const item of state.items) {
        const outcome = outcomes.get(item.id)
        if (outcome) Object.assign(item, outcome)
      }
    })
  }

  const state = await readState()
  const draft = findDraft(state, state?.issueNumber ?? 1)
  const ready = readyItems(state)
  const failed = state?.items.filter((i) => i.state === 'failed') ?? []

  // Once a draft exists it, not the page threshold, decides what gets built.
  const inIssue = draft ? draft.itemIds : selectForIssue(state, settings.pageThreshold).map((i) => i.id)
  const total = estimatePages(state, inIssue)

  console.log(
    `\nissue ${state?.issueNumber ?? 1}: ${inIssue.length} articles, ` +
      `${total} pages of ${settings.pageThreshold}${draft ? ' (edited draft)' : ''}`,
  )
  const byId = new Map((state?.items ?? []).map((i) => [i.id, i]))
  for (const id of inIssue) {
    const item = byId.get(id)
    if (item) console.log(`   ${String(item.pageCount).padStart(3)}pp  ${item.title ?? item.url}`)
  }

  const waiting = ready.filter((i) => !inIssue.includes(i.id))
  if (waiting.length > 0) {
    console.log(`\n${waiting.length} more waiting for the next issue`)
  }

  const skipped = state?.items.filter((i) => i.state === 'skipped') ?? []
  if (skipped.length) {
    console.log(`\n${skipped.length} skipped as reference pages (edit .press/state.json to include one):`)
    for (const item of skipped) console.log(`   ${item.title} — ${item.url}`)
  }
  if (failed.length) {
    console.log(`\n${failed.length} failed:`)
    for (const item of failed) console.log(`   ${item.url}\n      ${item.reason}`)
  }

  if (argv.includes('--compose')) {
    await compose(argv.includes('--force'))
  } else if (total >= settings.pageThreshold) {
    console.log(`\nready to print — run with --compose`)
  } else {
    console.log(`\n${settings.pageThreshold - total} more pages to go`)
  }
}

main().catch((err) => {
  console.error(`\npress: ${(err as Error).message}`)
  process.exit(1)
})
