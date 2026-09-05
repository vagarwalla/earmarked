/**
 * press — bring every draft issue inside a page range.
 *
 *   npx tsx scripts/press-balance.ts                   # say what it would do
 *   npx tsx scripts/press-balance.ts --write           # do it
 *   npx tsx scripts/press-balance.ts --write --min 100 --max 150
 *
 * Two passes, in this order:
 *
 *   1. **Shed.** An issue over the maximum gives up articles from its end
 *      until it fits, and they go back to the pool.
 *   2. **Fill.** An issue under the minimum takes from the pool until it fits.
 *
 * Every move goes through `applyIssueAction`, so a linkpost still travels with
 * the pieces it named and nothing is claimed by two issues at once.
 *
 * It moves articles; it does not rename issues. A name is generated from the
 * contents, so an issue whose contents changed enough is worth renaming — this
 * says which rather than doing it, because renaming is a model call and the
 * name is V's.
 */

import {
  balance,
  pagesOf,
  availableFor,
  DEFAULT_MIN,
  DEFAULT_MAX,
  FRONT_MATTER_PT,
} from '../src/lib/press/balance'
import { findDraft, withStateLock, type IssueDraft } from '../src/lib/press/issues'
import { costSummary, estimateCost, money } from '../src/lib/press/cost'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const write = argv.includes('--write')
  const num = (flag: string, fallback: number) => {
    const i = argv.indexOf(flag)
    return i === -1 ? fallback : Number(argv[i + 1]) || fallback
  }
  const min = num('--min', DEFAULT_MIN)
  const max = num('--max', DEFAULT_MAX)

  await withStateLock((state) => {
    const numbers = (state.issues ?? [])
      .filter((d) => d.state !== 'ordered')
      .map((d) => d.number)
      .sort((a, b) => a - b)
    const drafts = numbers.map((n) => findDraft(state, n)!).filter(Boolean)

    // `min`/`max` are the finished magazine's range; the passes below work in
    // article pages, which is `FRONT_MATTER_PT` fewer.
    const ceiling = max - FRONT_MATTER_PT
    const before = new Map(drafts.map((d) => [d.number, pagesOf(state, d)]))
    const moves = balance(state, drafts, min, ceiling)

    console.log(`target ${min}-${max}pp printed (${min}-${ceiling}pp of articles)\n`)
    for (const d of drafts) {
      const was = before.get(d.number) ?? 0
      const now = pagesOf(state, d)
      const flag = now < min ? '  UNDER' : now > ceiling ? '  OVER' : ''
      console.log(
        `issue ${String(d.number).padStart(2)}  ${String(was).padStart(4)}pp -> ${String(now).padStart(4)}pp` +
          `  (${d.itemIds.length} articles)${flag}  ${d.name ?? ''}`,
      )
    }

    if (moves.length) {
      console.log('\nmoves:')
      for (const m of moves) {
        console.log(`  issue ${String(m.issue).padStart(2)}  ${m.action === 'add' ? '+' : '-'}${String(m.pages).padStart(3)}pp  ${m.title}`)
      }
    } else {
      console.log('\nnothing to move.')
    }

    // What it costs, before and after. The page counts above are the argument
    // for a layout; this is the argument against it, and the two were never on
    // the same screen. Printed pages, not article pages — front matter is
    // bound and paid for like everything else.
    const beforeCost = estimateCost(drafts.map((d) => (before.get(d.number) ?? 0) + FRONT_MATTER_PT))
    const afterCost = estimateCost(drafts.map((d) => pagesOf(state, d) + FRONT_MATTER_PT))
    console.log('\ncost')
    console.log(`  now    ${costSummary(beforeCost)}`)
    if (afterCost.totalCents !== beforeCost.totalCents) {
      const delta = afterCost.totalCents - beforeCost.totalCents
      console.log(`  after  ${costSummary(afterCost)}`)
      console.log(`  change ${delta > 0 ? '+' : ''}${money(delta)}`)
    }
    // The shape, so the numbers above can be reasoned about without re-running
    // this: a book is expensive and a page is not.
    console.log(
      '  a book costs ~$2.35 + ~6.1c/page, and a parcel ~$4.90 + ~$0.78/book —' +
        ' so splitting an issue costs about $3, and moving pages between issues costs nothing.',
    )

    const pool = availableFor(state, { number: -1, itemIds: [], state: 'draft' } as IssueDraft)
    console.log(`\n${pool.length} articles left in the pool (${pool.reduce((n, i) => n + (i.pageCount ?? 0), 0)}pp)`)

    if (!write) {
      console.log('\nreporting only — pass --write to keep these moves, then rebuild.')
      // Throwing would be wrong (the lock writes on the way out), so undo by
      // putting the drafts back exactly as they were.
      for (const m of moves.slice().reverse()) {
        const d = findDraft(state, m.issue)!
        if (m.action === 'add') d.itemIds = d.itemIds.filter((id) => id !== m.id)
        else d.itemIds.push(m.id)
      }
      return
    }

    console.log('\nwritten. Every issue that changed needs a rebuild.')
  })
}

main()
