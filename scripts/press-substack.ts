/**
 * press — harvest a varied reading list out of Substack into Raindrop.
 *
 *   npx tsx scripts/press-substack.ts                      # dry run, prints the diff
 *   npx tsx scripts/press-substack.ts --apply              # write to Raindrop
 *   npx tsx scripts/press-substack.ts --collection 123456  # somewhere other than the default
 *
 * The method is written up in docs/press-substack.md; the selection logic and
 * its reasoning live in src/lib/press/substack.ts. This file is the plumbing:
 * page the archives, rank, reconcile.
 *
 * It reconciles rather than wiping and re-adding, so anything already opened,
 * tagged or annotated in the collection survives a re-run. Re-running after
 * editing the source list or the caps is therefore cheap and safe.
 */

import {
  DEFAULT_SELECTION,
  archiveUrl,
  excerptFor,
  selectPosts,
  tagsFor,
  type RankedPost,
  type SubstackPost,
} from '../src/lib/press/substack'
import {
  CAP_BY_SOURCE,
  EXCLUDE_SOURCES,
  FLOOR_BY_SOURCE,
  SOURCES,
  type ConfiguredSource,
} from '../src/lib/press/substack-sources'
import { RAINDROP_API } from '../src/lib/press/raindrop'
import { loadSettings } from '../src/lib/press/settings'

/** Substack 429s after roughly ten quick requests, so every page pauses. */
const PAGE_PAUSE_MS = 3_000
const RETRY_PAUSE_MS = 15_000
const MAX_RETRIES = 4
/** Deep enough for two years of even a daily publication. */
const MAX_PAGES = 16

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One archive page, with backoff. A 429 is expected rather than exceptional
 * here, so it is retried quietly; anything else is worth seeing.
 */
async function fetchPage(host: string, offset: number): Promise<SubstackPost[] | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(archiveUrl(host, offset), { headers: { 'user-agent': UA } })
    if (res.ok) return (await res.json()) as SubstackPost[]
    if (res.status !== 429) {
      console.warn(`  ${host} offset=${offset}: HTTP ${res.status}`)
      return null
    }
    await sleep(RETRY_PAUSE_MS * (attempt + 1))
  }
  console.warn(`  ${host} offset=${offset}: still rate-limited after ${MAX_RETRIES} tries`)
  return null
}

/** Every post back to the selection window, oldest page last. */
async function fetchArchive(source: ConfiguredSource, since: string): Promise<SubstackPost[]> {
  const posts: SubstackPost[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await fetchPage(source.host, page * 50)
    if (!batch?.length) break
    posts.push(...batch)
    // The archive is newest-first, so the last row of a page tells us whether
    // we have already walked past the window.
    if ((batch[batch.length - 1].post_date ?? '') < since) break
    await sleep(PAGE_PAUSE_MS)
  }
  return posts
}

interface RaindropItem {
  _id: number
  link: string
  tags?: string[]
}

/**
 * The collection also holds hand-picked items this harvester knows nothing
 * about — contest entries, essays off personal blogs, the classics. Every
 * harvested pick carries its tier as a tag, so that tag is what marks a
 * raindrop as ours to remove. Without this guard `--apply` would treat the
 * curated half as stale and delete it.
 */
const HARVESTED_TAGS = new Set(['landmark', 'key'])

function isHarvested(item: RaindropItem): boolean {
  return (item.tags ?? []).some((tag) => HARVESTED_TAGS.has(tag))
}

function raindrop(token: string) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${RAINDROP_API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`press/substack: ${init?.method ?? 'GET'} ${path} (${res.status}): ${body.slice(0, 200)}`)
    }
    return (await res.json()) as T
  }
  return {
    async listAll(collectionId: number) {
      const items: RaindropItem[] = []
      for (let page = 0; page < 40; page++) {
        const res = await request<{ items?: RaindropItem[] }>(
          `/raindrops/${collectionId}?perpage=50&page=${page}`,
        )
        if (!res.items?.length) break
        items.push(...res.items)
      }
      return items
    },
    // Raindrop's bulk create takes 100 an call; 50 keeps each request small
    // enough that a failure costs little to retry.
    async createMany(items: unknown[]) {
      for (let i = 0; i < items.length; i += 50) {
        await request('/raindrops', { method: 'POST', body: JSON.stringify({ items: items.slice(i, i + 50) }) })
      }
    },
    async removeMany(collectionId: number, ids: number[]) {
      if (!ids.length) return
      await request(`/raindrops/${collectionId}`, { method: 'DELETE', body: JSON.stringify({ ids }) })
    },
  }
}

/** Trailing slashes and http:// are not meaningful differences between saves. */
const normalize = (url: string) => (url ?? '').replace(/^http:\/\//, 'https://').replace(/\/+$/, '')

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const collectionId = Number(
    args[args.indexOf('--collection') + 1] || process.env.PRESS_SUBSTACK_COLLECTION_ID || 0,
  )
  if (!collectionId) {
    throw new Error('press/substack: pass --collection <id> or set PRESS_SUBSTACK_COLLECTION_ID')
  }

  const config = {
    ...DEFAULT_SELECTION,
    capBySource: CAP_BY_SOURCE,
    floorBySource: FLOOR_BY_SOURCE,
    excludeSources: EXCLUDE_SOURCES,
  }

  const harvested: Array<SubstackPost & { source: string; publication: string; topic: string }> = []
  for (const source of SOURCES) {
    if (config.excludeSources.has(source.host)) continue
    const posts = await fetchArchive(source, config.keyFrom)
    console.log(`${source.publication.padEnd(28)} ${String(posts.length).padStart(4)} posts`)
    harvested.push(
      ...posts.map((p) => ({ ...p, source: source.host, publication: source.publication, topic: source.topic })),
    )
    await sleep(PAGE_PAUSE_MS)
  }

  const { picks, rejected } = selectPosts(harvested, config)
  const byTopic = new Map<string, number>()
  for (const p of picks) byTopic.set(p.topic, (byTopic.get(p.topic) ?? 0) + 1)

  console.log(`\nharvested ${harvested.length}  picked ${picks.length}`)
  console.log('rejected:', rejected)
  console.log(
    'topics:',
    [...byTopic.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', '),
  )

  const client = raindrop(loadSettings().raindropToken)
  const existing = new Map<string, number>()
  const current = await client.listAll(collectionId)
  for (const item of current) existing.set(normalize(item.link), item._id)

  // Curated items are counted as kept, never as stale.
  const ours = current.filter(isHarvested)

  const wanted = new Map<string, RankedPost>()
  for (const p of picks) wanted.set(normalize(p.url), p)

  const stale = ours.filter((item) => !wanted.has(normalize(item.link))).map((item) => item._id)
  const fresh = [...wanted].filter(([url]) => !existing.has(url)).map(([, p]) => ({
    link: p.url,
    title: p.title,
    excerpt: excerptFor(p),
    tags: tagsFor(p),
    collection: { $id: collectionId },
    pleaseParse: {},
  }))

  console.log(
    `\ncollection ${collectionId}: ${current.length} present ` +
      `(${current.length - ours.length} curated, untouched), remove ${stale.length}, add ${fresh.length}`,
  )
  if (!apply) {
    console.log('dry run — pass --apply to write')
    return
  }
  await client.removeMany(collectionId, stale)
  await client.createMany(fresh)
  console.log('applied')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
