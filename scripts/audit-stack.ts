/**
 * Audit a stack for the non-fiction duplicate-work problem.
 *
 * For every book in the stack it reports how many Open Library work records hold
 * that book, and how many editions the picker sees before vs. after merging them.
 * A book whose edition count jumps was previously showing you a partial list.
 *
 * Run with: npx tsx scripts/audit-stack.ts break-list
 *
 * Reads the stack over the deployed API by default; point BASE_URL at a local
 * dev server to audit unpublished changes.
 */

import { findSiblingWorkIds, getEditions } from '../src/lib/openLibrary'
import type { CartItem } from '../src/lib/types'

const BASE_URL = process.env.BASE_URL ?? 'https://earmarked.vaidehiagarwalla.com'
const slug = process.argv[2] ?? 'break-list'

async function main() {
  const res = await fetch(`${BASE_URL}/api/cart/${encodeURIComponent(slug)}/items`)
  if (!res.ok) {
    console.error(`Could not read stack "${slug}" from ${BASE_URL} — HTTP ${res.status}`)
    process.exit(1)
  }
  const items: CartItem[] = await res.json()
  console.log(`Stack "${slug}" — ${items.length} book${items.length === 1 ? '' : 's'}\n`)

  const rows: { title: string; works: number; before: number; after: number }[] = []

  for (const item of items) {
    if (!item.work_id) {
      console.log(`· ${item.title} — no work_id, skipped`)
      continue
    }
    const siblings = await findSiblingWorkIds(item.work_id, item.title, item.author ?? '')
    const [before, after] = await Promise.all([
      getEditions(item.work_id),
      getEditions(siblings),
    ])
    rows.push({ title: item.title, works: siblings.length, before: before.length, after: after.length })

    const gained = after.length - before.length
    const marker = gained > 0 ? `  ← +${gained} editions` : ''
    console.log(
      `· ${item.title}\n`
      + `    works: ${siblings.length}  editions: ${before.length} → ${after.length}${marker}`
    )
    if (siblings.length > 1) console.log(`    ${siblings.join(' ')}`)
  }

  const improved = rows.filter((r) => r.after > r.before)
  const totalGained = rows.reduce((sum, r) => sum + (r.after - r.before), 0)
  console.log(
    `\n${improved.length}/${rows.length} books were seeing a partial edition list`
    + ` — ${totalGained} editions recovered in total.`
  )
  if (improved.length === 0 && rows.length > 0) {
    console.log('No book gained editions. Either these works are already consolidated on Open Library,')
    console.log('or the merge rules are too strict for this stack — worth checking the titles by hand.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
