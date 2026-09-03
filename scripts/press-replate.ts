/**
 * press — refetch the plates for articles already on disk.
 *
 * Extraction takes the `src` an article's markup displays, and for most of the
 * web that is a thumbnail: Substack lays its posts out at 424 pixels, and
 * idlewords.com shows 350-pixel slides that link to 1,920-pixel originals.
 * `largerVersionsOf` (extract.ts) and `largerImageUrls` (images.ts) now look
 * for the full-size copy, but only for articles ingested after they landed.
 * This is the same work for the ones already extracted.
 *
 *   npx tsx scripts/press-replate.ts            # every item, report only
 *   npx tsx scripts/press-replate.ts --write    # keep the bigger plates
 *   npx tsx scripts/press-replate.ts --write <item-id> [<item-id>…]
 *
 * Only the pictures are touched. The text, the footnotes and the linkpost
 * judgement are whatever they already were — a full re-extraction would rerun
 * a model call and could quietly rewrite an article V has already approved.
 *
 * An article whose page has since gone, changed, or started refusing us keeps
 * exactly the plates it has. Nothing here can make an issue worse.
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { parseHtml, stripCommentSections, toBlocks } from '../src/lib/press/extract'
import { safeFetch } from '../src/lib/press/fetch'
import { fetchAndStoreImage, imageIdentity, type CandidateImage } from '../src/lib/press/images'
import { PRESS_ROOT } from '../src/lib/press/issues'
import type { Article, ArticleImage } from '../src/lib/press/types'

const store = async (storagePath: string, body: Uint8Array | string): Promise<string> => {
  const full = path.join(PRESS_ROOT, storagePath)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, typeof body === 'string' ? body : Buffer.from(body))
  return storagePath
}

/** Every image in an article, paired with a setter that puts a new one back. */
function platesOf(article: Article): { image: ArticleImage; replace: (next: ArticleImage) => void }[] {
  const out: { image: ArticleImage; replace: (next: ArticleImage) => void }[] = []
  if (article.lead) {
    out.push({ image: article.lead, replace: (next) => void (article.lead = next) })
  }
  article.blocks.forEach((block, i) => {
    if (block.type !== 'figure') return
    out.push({
      image: block.image,
      replace: (next) => void (article.blocks[i] = { type: 'figure', image: next }),
    })
  })
  return out
}

/**
 * Which candidate in the live page is the plate we already have?
 *
 * Not a string comparison: an article ingested from its newsletter has plates
 * whose URLs ask Substack for 424 pixels, while the same pictures on the live
 * post ask for 1,456. `imageIdentity` throws away the size and leaves what
 * the two have in common, which is the photograph.
 */
function candidateFor(image: ArticleImage, candidates: CandidateImage[]): CandidateImage | null {
  const stored = (image as ArticleImage & { sourceUrl?: string }).sourceUrl
  if (!stored) return null
  const want = imageIdentity(stored)
  for (const c of candidates) {
    if (imageIdentity(c.url) === want) return c
    if (c.alternates?.some((a) => imageIdentity(a) === want)) return c
  }
  return null
}

async function replate(id: string, write: boolean): Promise<void> {
  const file = path.join(PRESS_ROOT, 'items', id, 'article.json')
  if (!existsSync(file)) return
  const article = JSON.parse(await readFile(file, 'utf8')) as Article

  const plates = platesOf(article)
  if (!plates.length) return

  const label = (article.title ?? id).slice(0, 44).padEnd(46)
  if (!article.url) return console.log(`${label} — no source URL`)

  let candidates: CandidateImage[]
  try {
    const res = await safeFetch(article.url)
    const doc = parseHtml(await res.text()).window.document
    stripCommentSections(doc)
    candidates = toBlocks(doc.body).images
  } catch (err) {
    return console.log(`${label} — page unavailable (${(err as Error).message.slice(0, 40)})`)
  }

  let improved = 0
  let n = 0
  for (const { image, replace } of plates) {
    const candidate = candidateFor(image, candidates)
    n++
    if (!candidate) continue

    // Written into a fresh number range rather than over the file this plate
    // already uses. The lead is lifted out of the blocks at extraction, so a
    // plate's position here is not its number on disk, and reusing the number
    // would overwrite the bytes some *other* plate is still pointing at.
    const next = await fetchAndStoreImage(id, candidate, 100 + n, {
      store: (write ? store : async (p: string) => p) as never,
    })
    if (!next?.width) continue
    // An image we could not measure before is worth replacing on principle:
    // we now know what it is, and the layout sizes plates by their pixels.
    if (image.width !== null && next.width <= image.width) continue
    improved++
    if (write) replace(next)
  }

  const summary = improved
    ? `${improved}/${plates.length} plate${improved === 1 ? '' : 's'} bigger`
    : `nothing bigger to be had`
  console.log(`${label} ${summary}`)

  if (write && improved) await writeFile(file, JSON.stringify(article))
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const write = argv.includes('--write')
  const only = argv.filter((a) => !a.startsWith('--'))

  const items = only.length
    ? only
    : (await readdir(path.join(PRESS_ROOT, 'items'), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)

  console.log(
    `${items.length} item${items.length === 1 ? '' : 's'}${write ? '' : ' — reporting only, pass --write to keep the bigger plates'}\n`,
  )

  for (const id of items) await replate(id, write)

  if (write) {
    console.log(
      '\nPlates changed size, so every issue built from these articles needs a rebuild before it is ordered.',
    )
  }
}

main()
