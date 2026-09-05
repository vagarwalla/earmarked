/**
 * press — build one issue's PDFs from an explicit list of articles.
 *
 * This was the back half of `scripts/press-run.ts --compose`. It moved out
 * because there are now two callers: the runner, and the "Rebuild" button in
 * the editor at /press. Both need to render exactly the articles they are
 * given, in exactly the order they are given them — the *selection* is
 * somebody else's decision (see `issues.ts`), and nothing here re-makes it.
 *
 * Server-only: it launches Chromium through Vivliostyle and writes into
 * `.press/`. A 100-page issue takes minutes, so `onProgress` reports each
 * stage for the caller to show or log.
 */

import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  articleImages,
  buildArticleSection,
  buildDocument,
  imageFileName,
  pdfPageCount,
  renderHtml,
} from './layout/render'
import {
  buildCoverHtml,
  issueDateline,
  buildTocSection,
  computeToc,
  mergePdfs,
  padToEven,
  preflightInterior,
  type ComposeEntry,
} from './compose'
import { nameIssue } from './naming'
import { cleanTitle } from './title'
import { PRESS_ROOT, measuredPagesFor, recordMeasuredPages } from './issues'
import { measurementKey } from './measure'
import type { Article, PressItem, TocEntry } from './types'

/** The per-article facts a build needs; a subset of what state.json holds. */
export interface BuildItem {
  id: string
  title: string | null
  url: string
  pageCount?: number
}

/** What `press-run` records alongside a composed issue, and the UI reads back. */
export interface IssueMeta {
  number: number
  name: string
  pageCount: number
  builtAt: string
  preflight: { code: string; detail: string }[]
  articles: BuildItem[]
}

export interface BuildResult {
  name: string
  /** Real page count of the finished interior, padded to even. */
  pageCount: number
  /** Each article's measured length, in the order it was given. */
  pageCounts: number[]
  toc: TocEntry[]
  preflight: { code: string; detail: string }[]
  outDir: string
}

export interface BuildOptions {
  number: number
  /** In running order. Position here is position in the magazine. */
  items: BuildItem[]
  /** Names the issue with Claude when present; falls back to a date range. */
  apiKey?: string | null
  /**
   * Keep an existing name instead of naming the issue again. A rebuild is a
   * re-render of the same issue, and `nameIssue` is a model call: without this
   * the Rebuild button quietly retitles the magazine every time it is pressed.
   */
  name?: string
  root?: string
  onProgress?: (message: string) => void
}

/** An article whose extraction is missing from disk, named so it can be fixed. */
export class BuildError extends Error {}

/** A build is already running — the caller should wait, not queue a second. */
export class BuildBusyError extends Error {}

const BUILD_LOCK = path.join(PRESS_ROOT, 'build.lock')
/** Comfortably longer than the 15-minute Vivliostyle timeout in `vivliostyle.ts`. */
const BUILD_LOCK_STALE_MS = 30 * 60 * 1000

/**
 * One build at a time. Unlike the state lock this never waits: two concurrent
 * renders of the same issue would fight over `interior.pdf`, and the honest
 * answer to "rebuild" while a rebuild is running is that one is running.
 */
export async function withBuildLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(PRESS_ROOT, { recursive: true })

  try {
    const handle = await open(BUILD_LOCK, 'wx')
    await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`)
    await handle.close()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const age = await stat(BUILD_LOCK)
      .then((s) => Date.now() - s.mtimeMs)
      .catch(() => null)
    // A run killed mid-render would otherwise block every future rebuild.
    if (age === null || age <= BUILD_LOCK_STALE_MS) {
      throw new BuildBusyError('A build is already running. Wait for it to finish.')
    }
    await rm(BUILD_LOCK, { force: true })
    return withBuildLock(fn)
  }

  try {
    return await fn()
  } finally {
    await rm(BUILD_LOCK, { force: true })
  }
}

/**
 * Why the measurement pass below is a plain sequential loop.
 *
 * The obvious speed-up is to render the articles concurrently: they are
 * independent of each other and of everything else in the build. It does not
 * work. `vivliostyleRenderer` calls `@vivliostyle/cli`'s `build()` inside this
 * process, and two of those at once fail with
 *
 *   ProtocolError: Protocol error (Page.printToPDF): Printing failed
 *
 * — the CLI keeps state across a call and was not written to be re-entered.
 * Making it concurrent means one child process per render, which is a
 * different renderer rather than a flag. Worth doing if the cache below ever
 * stops being enough; not worth it while a warm build measures nothing at all.
 */

export async function buildIssue(opts: BuildOptions): Promise<BuildResult> {
  const { number, items, apiKey = null, root = PRESS_ROOT } = opts
  const progress = opts.onProgress ?? (() => {})

  if (items.length === 0) throw new BuildError('The issue is empty — add an article first.')

  const load = async (storagePath: string): Promise<Uint8Array> =>
    new Uint8Array(await readFile(path.join(root, storagePath)))

  progress(`Loading ${items.length} article${items.length === 1 ? '' : 's'}`)
  const entries: ComposeEntry[] = []
  for (const item of items) {
    let article: Article
    try {
      article = JSON.parse(
        new TextDecoder().decode(await load(`items/${item.id}/article.json`)),
      ) as Article
    } catch {
      throw new BuildError(
        `No extracted text for "${item.title ?? item.url}" — re-save the link and run press-run.`,
      )
    }
    // Cleaned here as well as at extraction: every article extracted before
    // `cleanTitle` existed still has its markup and its publication's name in
    // the title, and those go straight onto the cover and the contents page.
    article.title = cleanTitle(article.title, article.sourceName, article.url) || 'Untitled'

    entries.push({ kind: 'article', item: { id: item.id, title: item.title } as PressItem, article })
  }

  // Every image the issue references, read once and reused across the three
  // renders below; Vivliostyle resolves them from a scratch directory.
  const images = new Map<string, Uint8Array>()
  for (const entry of entries) {
    if (entry.kind !== 'article') continue
    for (const image of articleImages(entry.article)) {
      const name = imageFileName(image.path)
      if (!images.has(name)) images.set(name, await load(image.path))
    }
  }
  const render = (html: string) => renderHtml(html, images)

  // The contents page is built from these numbers, so a stale one prints a
  // magazine whose page references are wrong. What decides whether a recorded
  // number is stale is `measurementKey` — the stylesheet, the template and the
  // article itself — so a count taken under the same three can be reused, and
  // one taken under anything else is measured again. This used to re-render
  // every article on every build, which for a nineteen-article issue was
  // nineteen Chromium launches to reproduce nineteen numbers already on disk.
  //
  // An article is rendered alone here and merged into a continuous document
  // below; both give it the same length, because every article starts on a
  // fresh page (KTD7). That is also what makes a cached measurement sound.
  const keys = entries.map((e) => measurementKey((e as { article: Article }).article))
  const known = await measuredPagesFor(items.map((i) => i.id))
  const pageCounts: number[] = entries.map((_, i) => {
    const hit = known.get(items[i].id)
    return hit && hit.key === keys[i] ? hit.pages : -1
  })
  const todo = pageCounts.flatMap((p, i) => (p === -1 ? [i] : []))

  if (todo.length === 0) {
    progress(`Measured already — ${items.length} article${items.length === 1 ? '' : 's'} unchanged`)
  } else {
    progress(
      `Measuring ${todo.length} article${todo.length === 1 ? '' : 's'}` +
        (todo.length < items.length ? ` (${items.length - todo.length} unchanged)` : ''),
    )
    for (const i of todo) {
      const measured = await render(
        buildDocument([buildArticleSection({ article: (entries[i] as { article: Article }).article }, i)], {
          issueNumber: number,
          startPage: 1,
          measurement: true,
        }),
      )
      pageCounts[i] = measured.pageCount
    }
  }

  let name = opts.name?.trim() ?? ''
  if (name) {
    progress(`Keeping the name "${name}"`)
  } else {
    progress('Naming the issue')
    name = await nameIssue({
      issueNumber: number,
      toc: computeToc(entries, pageCounts, 0),
      apiKey,
    })
  }

  // The contents page has to know its own length before it can state where
  // anything starts, so it is rendered once to measure and once for real.
  progress('Rendering the contents')
  let frontPages = 1
  let toc: TocEntry[] = computeToc(entries, pageCounts, frontPages)
  const renderFront = (t: TocEntry[]) =>
    render(
      buildDocument([buildTocSection(name, number, t)], {
        issueNumber: number,
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

  progress(`Rendering ${items.length} article${items.length === 1 ? '' : 's'} — this takes a while`)
  const prose = await render(
    buildDocument(
      entries.map((e, i) => buildArticleSection({ article: (e as { article: Article }).article }, i)),
      { issueNumber: number, startPage: toc[0].startPage, documentTitle: name },
    ),
  )

  const interior = await padToEven(await mergePdfs([front.pdf, prose.pdf]))
  const pageCount = await pdfPageCount(interior)

  progress('Preflighting')
  const preflight = await preflightInterior(interior)

  // The spine width depends on the finished page count, so the cover can only
  // be drawn once the interior is final.
  progress('Rendering the cover')
  const cover = await render(
    buildCoverHtml({
      issueName: name,
      issueNumber: number,
      pageCount,
      // The month the issue was made up. Deliberately not the span its
      // contents were published over — see `issueDateline`.
      dateRange: issueDateline(),
      toc,
    }),
  )

  progress('Writing the PDFs')
  const outDir = path.join(root, `issue-${number}`)
  await mkdir(outDir, { recursive: true })
  await writeFile(path.join(outDir, 'interior.pdf'), interior)
  await writeFile(path.join(outDir, 'cover.pdf'), cover.pdf)
  await writeFile(path.join(outDir, 'toc.json'), JSON.stringify(toc, null, 2))
  // The name only exists at build time; the review UI at /press reads it back,
  // and `articles` is what tells the UI which build the draft is compared to.
  const meta: IssueMeta = {
    number,
    name,
    pageCount,
    builtAt: new Date().toISOString(),
    preflight,
    // The freshly measured lengths, not the ones that came in: the caller's
    // copy is what the *previous* layout produced.
    articles: items.map((i, n) => ({ id: i.id, title: i.title, url: i.url, pageCount: pageCounts[n] })),
  }
  await writeFile(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2))

  // The lengths measured above are the only true ones; the state file is still
  // carrying whatever ingest recorded. Selection and the editor's running
  // total both read it, so leaving it stale under-fills the next issue.
  // Only for a real build: a test or a scratch render passes its own root and
  // has no business writing V's state.
  if (root === PRESS_ROOT) {
    await recordMeasuredPages(
      new Map(items.map((i, n) => [i.id, { pages: pageCounts[n], key: keys[n] }])),
    )
  }

  return { name, pageCount, pageCounts, toc, preflight, outDir }
}
