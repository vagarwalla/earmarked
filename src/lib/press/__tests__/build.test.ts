import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { BuildError, buildIssue, type IssueMeta } from '../build'
import { setPdfRenderer } from '../layout/render'
import { PRESS_ROOT } from '../issues'
import { MEDIA_HEIGHT_PT, MEDIA_WIDTH_PT, type Article } from '../types'

function article(over: Partial<Article> = {}): Article {
  return {
    title: 'A piece',
    byline: 'V',
    sourceName: 'Somewhere',
    url: 'https://example.com/a',
    publishedAt: null,
    dek: null,
    lead: null,
    blocks: [{ type: 'para', html: 'Some prose.' }],
    ...over,
  }
}

/**
 * A renderer producing real PDFs — the page arithmetic, merge and pad steps
 * are the point of a build, so they are exercised rather than stubbed. One
 * page per article section, one for the cover, one per eight TOC entries.
 */
function stubRenderer() {
  setPdfRenderer(async ({ html }) => {
    let pages: number
    if (html.includes('class="toc"')) {
      pages = Math.max(1, Math.ceil((html.match(/class="toc-entry"/g) ?? []).length / 8))
    } else if (html.includes('class="masthead"')) {
      pages = 1
    } else {
      pages = Math.max(1, (html.match(/<article/g) ?? []).length)
    }
    const doc = await PDFDocument.create()
    for (let i = 0; i < pages; i++) {
      doc.addPage([MEDIA_WIDTH_PT, MEDIA_HEIGHT_PT]).drawRectangle({ x: 5, y: 5, width: 9, height: 9 })
    }
    return doc.save()
  })
}

/** A `.press`-shaped directory holding extracted articles for `ids`. */
async function pressRoot(articles: Record<string, Article>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'press-build-'))
  for (const [id, body] of Object.entries(articles)) {
    await mkdir(path.join(dir, 'items', id), { recursive: true })
    await writeFile(path.join(dir, 'items', id, 'article.json'), JSON.stringify(body))
  }
  return dir
}

describe('buildIssue', () => {
  const roots: string[] = []
  afterEach(async () => {
    setPdfRenderer(null)
    await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })

  async function build(order: string[], number = 3) {
    stubRenderer()
    const root = await pressRoot({
      a: article({ title: 'On sincerity' }),
      b: article({ title: 'In favour of niceness' }),
      c: article({ title: 'Maximization is perilous' }),
    })
    roots.push(root)
    const result = await buildIssue({
      number,
      items: order.map((id) => ({ id, title: id.toUpperCase(), url: `https://x/${id}`, pageCount: 4 })),
      apiKey: null,
      root,
    })
    return { root, result }
  }

  it('lays the articles out in the order it is given, not the order they were saved', async () => {
    const { result } = await build(['c', 'a', 'b'])
    expect(result.toc.map((t) => t.itemId)).toEqual(['c', 'a', 'b'])
  })

  it('records that order in meta.json, which is what the editor compares against', async () => {
    const { root } = await build(['b', 'c', 'a'])
    const meta = JSON.parse(
      await readFile(path.join(root, 'issue-3', 'meta.json'), 'utf8'),
    ) as IssueMeta
    expect(meta.articles.map((a) => a.id)).toEqual(['b', 'c', 'a'])
    expect(meta.number).toBe(3)
  })

  it('measures the articles itself instead of trusting the count it was given', async () => {
    // Every item goes in claiming 4 pages; the stub renders 1 per article.
    const { root, result } = await build(['a', 'b', 'c'])
    expect(result.pageCounts).toEqual([1, 1, 1])
    expect(result.toc.map((t) => t.pageCount)).toEqual([1, 1, 1])
    const meta = JSON.parse(
      await readFile(path.join(root, 'issue-3', 'meta.json'), 'utf8'),
    ) as IssueMeta
    expect(meta.articles.map((a) => a.pageCount)).toEqual([1, 1, 1])
  })

  it('leaves the real state file alone when it is building into another root', async () => {
    // The measured lengths are written back to `.press/state.json`, which a
    // test root has no claim on: only a build of the real thing may touch it.
    const before = existsSync(PRESS_ROOT) ? await readdir(PRESS_ROOT) : null
    await build(['a', 'b'])
    const after = existsSync(PRESS_ROOT) ? await readdir(PRESS_ROOT) : null
    expect(after).toEqual(before)
  })

  it('writes both PDFs and the TOC beside them', async () => {
    const { root } = await build(['a', 'b'])
    for (const file of ['interior.pdf', 'cover.pdf', 'toc.json', 'meta.json']) {
      expect(existsSync(path.join(root, 'issue-3', file))).toBe(true)
    }
  })

  it('pads the interior to an even page count, because a sheet has two sides', async () => {
    const { result } = await build(['a', 'b', 'c'])
    expect(result.pageCount % 2).toBe(0)
  })

  it('starts the first article after the contents pages', async () => {
    const { result } = await build(['a', 'b'])
    expect(result.toc[0].startPage).toBeGreaterThan(1)
    // Running order is cumulative: each entry starts after the one before it.
    for (let i = 1; i < result.toc.length; i++) {
      expect(result.toc[i].startPage).toBeGreaterThan(result.toc[i - 1].startPage)
    }
  })

  it('names an issue without an API key rather than failing', async () => {
    const { result } = await build(['a'])
    expect(result.name).toBeTruthy()
  })

  it('refuses an empty issue', async () => {
    stubRenderer()
    const root = await pressRoot({})
    roots.push(root)
    await expect(buildIssue({ number: 1, items: [], root, apiKey: null })).rejects.toThrow(BuildError)
  })

  it('names the article whose extraction is missing, so it can be re-saved', async () => {
    stubRenderer()
    const root = await pressRoot({ a: article() })
    roots.push(root)
    await expect(
      buildIssue({
        number: 1,
        root,
        apiKey: null,
        items: [
          { id: 'a', title: 'A', url: 'https://x/a', pageCount: 4 },
          { id: 'gone', title: 'Vanished', url: 'https://x/gone', pageCount: 4 },
        ],
      }),
    ).rejects.toThrow(/Vanished/)
  })

  it('reports each stage, so a rebuild that takes minutes is not silent', async () => {
    stubRenderer()
    const root = await pressRoot({ a: article() })
    roots.push(root)
    const seen: string[] = []
    await buildIssue({
      number: 1,
      root,
      apiKey: null,
      items: [{ id: 'a', title: 'A', url: 'https://x/a', pageCount: 4 }],
      onProgress: (m) => seen.push(m),
    })
    expect(seen.length).toBeGreaterThan(3)
    expect(seen.join('\n')).toMatch(/cover/i)
  })
})

// ── The build lock ───────────────────────────────────────────────────────────

/** Like the state lock's tests: a second copy of the module over a temp root. */
async function inTempRoot() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'press-buildlock-'))
  const spy = vi.spyOn(process, 'cwd').mockReturnValue(dir)
  vi.resetModules()
  const mod = await import('../build')
  return {
    dir,
    mod,
    cleanup: async () => {
      spy.mockRestore()
      vi.resetModules()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

describe('withBuildLock', () => {
  let cleanup: (() => Promise<void>) | null = null
  afterEach(async () => {
    await cleanup?.()
    cleanup = null
  })

  it('refuses a second build rather than queueing one', async () => {
    const t = await inTempRoot()
    cleanup = t.cleanup

    let release: () => void = () => {}
    let started: () => void = () => {}
    const holding = new Promise<void>((r) => (started = r))
    const first = t.mod.withBuildLock(() => {
      // Only once `fn` runs is the lock actually on disk; racing the second
      // call against the first's `open()` would test nothing.
      started()
      return new Promise<void>((r) => (release = r))
    })
    await holding

    // Two Chromium renders of one issue would fight over interior.pdf, and
    // "already running" is the honest answer to a second Rebuild press.
    await expect(t.mod.withBuildLock(async () => {})).rejects.toThrow(t.mod.BuildBusyError)
    release()
    await first
  })

  it('lets the next build through once the first finishes', async () => {
    const t = await inTempRoot()
    cleanup = t.cleanup
    await t.mod.withBuildLock(async () => {})
    await expect(t.mod.withBuildLock(async () => 'ok')).resolves.toBe('ok')
  })

  it('releases the lock when the build throws', async () => {
    const t = await inTempRoot()
    cleanup = t.cleanup
    await expect(
      t.mod.withBuildLock(async () => {
        throw new Error('chromium died')
      }),
    ).rejects.toThrow('chromium died')
    await expect(t.mod.withBuildLock(async () => 'ok')).resolves.toBe('ok')
  })
})
