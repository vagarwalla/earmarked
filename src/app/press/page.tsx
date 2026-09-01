/**
 * press — the workbench.
 *
 * Three panels: every issue on the left, the one you are working on in the
 * middle, and on the right the three things that are not the issue itself —
 * the pool of unprinted articles, the orders you have placed, and the settings
 * those orders are made from.
 *
 * A server component, and everything it reads comes from Postgres. The
 * workbench is not one of the two sources `review.ts` chooses between: a pool
 * you can delete from, an address you can change and an order you can place
 * have no representation on disk at all. `press-run` and `press-sync` keep the
 * disk in step for the renderer, which is the one job that cannot move off
 * this machine.
 *
 * Off in production unless PRESS_UI_ENABLED=1, and behind a password either
 * way (src/middleware.ts) — it lists what V has been reading.
 *
 * See docs/plans/2026-08-31-003-feat-press-workbench-plan.md.
 */

import { notFound } from 'next/navigation'
import { pressUiEnabled } from '@/lib/press/local'
import { itemsForIssue } from '@/lib/press/db'
import { itemsInState, listIssueRows, poolItems } from '@/lib/press/workbench'
import { loadEffectiveSettings, readSettingsRow, SETTINGS_DEFAULTS } from '@/lib/press/settings-db'
import { listOrders, type OrderWithIssue } from '@/lib/press/orders'
import { loadSettings } from '@/lib/press/settings'
import { ThemeToggle } from '@/components/ThemeToggle'
import { Workbench, type PoolItem, type WorkbenchIssue } from './Workbench'
import type { PressItem } from '@/lib/press/types'

export const dynamic = 'force-dynamic'

function toPoolItem(item: PressItem): PoolItem {
  return {
    id: item.id,
    title: item.title ?? item.url ?? item.id,
    url: item.url,
    byline: item.byline,
    sourceName: item.source_name,
    pageCount: item.page_count ?? 0,
    reason: item.failure_reason,
  }
}

const sameOrder = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i])

export default async function PressPage() {
  if (!pressUiEnabled()) notFound()

  const rows = await listIssueRows()

  const issues: WorkbenchIssue[] = []
  for (const row of rows) {
    const items = await itemsForIssue(row.id)
    const order = items.map((i) => i.id)
    issues.push({
      id: row.id,
      number: row.number,
      name: row.name ?? `Issue ${row.number}`,
      state: row.state,
      contents: items.map(toPoolItem),
      pages: items.reduce((n, i) => n + (i.page_count ?? 0), 0),
      pageTotal: row.page_total,
      built: Boolean(row.interior_path),
      hasCover: Boolean(row.cover_path),
      // The PDFs on file were rendered from `built_order`; if the running
      // order has moved since, the page numbers in them belong to an
      // arrangement that no longer exists and the panel has to say so.
      dirty: !row.interior_path || !sameOrder(order, row.built_order ?? []),
      luluJobId: row.lulu_job_id,
      rejectionReason: row.rejection_reason,
    })
  }

  const [pool, failed, skipped, dropped] = await Promise.all([
    poolItems(),
    itemsInState('failed'),
    itemsInState('skipped'),
    itemsInState('dropped').catch(() => []),
  ])

  const settings = await loadEffectiveSettings()

  // Orders and the settings row live in tables migration 013 creates. Until it
  // is applied the rest of the workbench still works, and those two panels say
  // what is missing rather than taking the page down with them.
  let orders: OrderWithIssue[] | null = null
  try {
    orders = await listOrders()
  } catch {
    orders = null
  }
  const settingsRow = await readSettingsRow().catch(() => null)

  const env = loadSettings()

  return (
    <main className="mx-auto max-w-[1600px] px-4 py-6">
      <header className="mb-5 flex items-baseline justify-between gap-4">
        <h1 className="font-serif text-2xl">Saved reading, laid out for print.</h1>
        <ThemeToggle />
      </header>

      <Workbench
        issues={issues}
        pool={pool.map(toPoolItem)}
        failed={failed.map(toPoolItem)}
        skipped={skipped.map(toPoolItem)}
        dropped={dropped.map(toPoolItem)}
        orders={orders}
        settings={{
          row: settingsRow ?? SETTINGS_DEFAULTS,
          hasRow: settingsRow !== null,
          env: {
            hasShipping: Boolean(env.shipping),
            mailTo: env.mailTo || null,
            pageThreshold: env.pageThreshold,
            luluPackageId: env.luluPackageId || null,
            luluSandbox: env.luluSandbox,
          },
          effective: {
            hasShipping: Boolean(settings.shipping),
            mailTo: settings.mailTo || null,
            luluSandbox: settings.luluSandbox,
            copies: settings.copies,
          },
        }}
        threshold={settings.pageThreshold}
      />
    </main>
  )
}
