/**
 * press — find the linkposts already in the pool.
 *
 * `press-run` classifies everything it extracts, so anything saved from now on
 * is handled on the way in. This is the other half: the articles that were
 * extracted before linkposts existed, and are sitting in `.press/state.json`
 * as ordinary pieces when several of them are really roundups.
 *
 *   npx tsx scripts/press-linkposts.ts              # scan what has never been asked
 *   npx tsx scripts/press-linkposts.ts --dry-run    # say what it would do
 *   npx tsx scripts/press-linkposts.ts --force      # ask again about everything
 *   npx tsx scripts/press-linkposts.ts --limit 5
 *
 * Needs credentials: run with `node --env-file=.env.local`, or export them.
 *
 * The stored `article.json` cannot answer the question on its own — extraction
 * throws every href away, because print cannot follow one — so each article is
 * re-fetched and its links harvested afresh. Nothing is re-extracted and no
 * images are touched: the stored article is still what prints, and all this
 * changes is what is known about it.
 *
 * Pieces a linkpost names are queued, not extracted. The next `press-run`
 * picks them up along with everything else, through exactly one code path.
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { safeFetchText } from '../src/lib/press/fetch'
import { extractWithDefuddle, extractWithReadability } from '../src/lib/press/extract'
import { classifyLinkpost, MAX_TARGETS, type OutboundLink } from '../src/lib/press/linkpost'
import { normalizeUrl } from '../src/lib/press/db'
import { PRESS_ROOT, readState, withStateLock, type StateItem } from '../src/lib/press/issues'
import { loadSettings } from '../src/lib/press/settings'
import type { Article, LinkpostTarget } from '../src/lib/press/types'

const articlePath = (id: string) => path.join(PRESS_ROOT, 'items', id, 'article.json')

/** States worth asking about: something that is, or could still be, printed. */
const SCANNABLE = new Set<StateItem['state']>(['laid_out', 'printed', 'skipped'])

function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : (process.argv[i + 1] ?? null)
}

/**
 * Deterministic, and the same one `press-run` mints, so a roundup scanned here
 * and re-scanned there recognises its own children instead of doubling them.
 */
function linkpostChildId(url: string): string {
  const key = normalizeUrl(url) ?? url
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (Math.imul(31, hash) + key.charCodeAt(i)) | 0
  return `lp-${(hash >>> 0).toString(36)}-${key.length.toString(36)}`
}

/**
 * The outbound links of a page as it stands today.
 *
 * Deliberately not `extractFromUrl`: that would re-download every image and
 * rewrite the stored article, and the only thing wanted here is the hrefs.
 * Both rungs are tried for the same reason the ingest path tries both — a page
 * defuddle cannot read is often one Readability can.
 */
async function linksFor(url: string): Promise<OutboundLink[]> {
  const response = await safeFetchText(url)
  if (response.status >= 400) throw new Error(`HTTP ${response.status}`)
  const rung = extractWithDefuddle(response.text, url) ?? extractWithReadability(response.text, url)
  if (!rung) throw new Error('no rung could read the page')
  return rung.links
}

async function loadArticle(id: string): Promise<Article | null> {
  try {
    return JSON.parse(await readFile(articlePath(id), 'utf8')) as Article
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry-run')
  const force = process.argv.includes('--force')
  const limit = Number.parseInt(flag('limit') ?? '', 10) || Infinity
  const settings = loadSettings()

  if (!settings.anthropicApiKey) {
    console.log('no ANTHROPIC_API_KEY — falling back to the shape of the page alone, which is blunter\n')
  }

  const state = await readState()
  const all = state?.items ?? []
  const candidates = all
    .filter((i) => SCANNABLE.has(i.state))
    .filter((i) => Boolean(i.url))
    // A piece that arrived through a linkpost is not asked about: a roundup
    // reached through a roundup is a rabbit hole, not an issue.
    .filter((i) => !i.linkpostParentId)
    .filter((i) => force || !i.linkpostScannedAt)
    .slice(0, limit)

  if (candidates.length === 0) {
    console.log('nothing to scan — every article has been asked about (use --force to ask again)')
    return
  }

  console.log(`scanning ${candidates.length} article${candidates.length === 1 ? '' : 's'}…\n`)

  const scannedAt = new Date().toISOString()
  const decided = new Map<string, { isLinkpost: boolean }>()
  const discovered: StateItem[] = []
  /** Grows as we go, so two roundups naming the same piece produce one item. */
  const known = new Set(all.map((i) => normalizeUrl(i.url)).filter((k): k is string => Boolean(k)))

  let found = 0

  for (const [n, item] of candidates.entries()) {
    const label = `[${String(n + 1).padStart(2)}/${candidates.length}]`
    const name = item.title ?? item.url

    const article = await loadArticle(item.id)
    if (!article) {
      console.log(`${label} –  ${name}\n           no stored article; nothing to classify`)
      continue
    }

    let links: OutboundLink[]
    try {
      links = await linksFor(item.url)
    } catch (err) {
      // Answered "no" for now rather than left pending: a dead link would
      // otherwise be re-fetched on every run forever. `--force` re-asks.
      decided.set(item.id, { isLinkpost: false })
      console.log(`${label} ✗  ${name}\n           could not re-fetch: ${(err as Error).message}`)
      continue
    }

    const judgement = await classifyLinkpost({
      article,
      links,
      apiKey: settings.anthropicApiKey,
      maxTargets: MAX_TARGETS,
    })

    decided.set(item.id, { isLinkpost: judgement.isLinkpost })

    if (!judgement.isLinkpost) {
      console.log(`${label} ·  ${name}\n           not a linkpost (${judgement.reason})`)
      continue
    }

    found++
    const fresh: LinkpostTarget[] = []
    for (const target of judgement.targets) {
      const key = normalizeUrl(target.url)
      if (!key || known.has(key)) continue
      known.add(key)
      fresh.push(target)
      discovered.push({
        id: linkpostChildId(target.url),
        url: target.url,
        raindropId: '',
        title: target.anchor || null,
        state: 'queued',
        savedAt: item.savedAt,
        linkpostParentId: item.id,
        linkpostAnchor: target.anchor || undefined,
      })
    }

    console.log(
      `${label} ⇢  ${name}\n           linkpost: ${judgement.reason}` +
        `\n           ${judgement.targets.length} named, ${fresh.length} new`,
    )
    for (const target of judgement.targets) {
      const mark = fresh.includes(target) ? '+' : '·'
      console.log(`             ${mark} ${target.anchor || target.url}`)
    }

    if (!dry) {
      // The marker goes on the stored article, because that is what the
      // renderer reads: the flag on the opener and the "Linked here" list are
      // both built from it.
      article.linkpost = {
        kind: judgement.kind,
        reason: judgement.reason,
        targets: judgement.targets,
      }
      await writeFile(articlePath(item.id), JSON.stringify(article))
    }
  }

  if (dry) {
    console.log(`\n[dry] ${found} linkpost${found === 1 ? '' : 's'}, ${discovered.length} pieces would be queued`)
    console.log('[dry] nothing was written — drop --dry-run to apply')
    return
  }

  await withStateLock((s) => {
    for (const it of s.items) {
      const decision = decided.get(it.id)
      if (!decision) continue
      it.isLinkpost = decision.isLinkpost
      it.linkpostScannedAt = scannedAt
    }
    const ids = new Set(s.items.map((i) => i.id))
    for (const child of discovered) {
      if (!ids.has(child.id)) s.items.push(child)
    }
  })

  console.log(`\n${found} linkpost${found === 1 ? '' : 's'} found, ${discovered.length} pieces queued`)
  if (discovered.length > 0) {
    console.log('run `npx tsx scripts/press-run.ts` to extract them')
  }
}

main().catch((err) => {
  console.error(`\npress: ${(err as Error).message}`)
  process.exit(1)
})
