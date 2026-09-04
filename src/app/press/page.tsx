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

import { notFound, redirect } from 'next/navigation'
import { pressUiEnabled } from '@/lib/press/local'
import { NotInvitedError, NotSignedInError, currentAccount } from '@/lib/press/accounts'
import { signedInUser } from '@/lib/press/auth'
import { itemsForIssue, pressDb } from '@/lib/press/db'
import { itemsInState, listIssueRows, poolItems } from '@/lib/press/workbench'
import { loadEffectiveSettings, readSettingsRow, SETTINGS_DEFAULTS } from '@/lib/press/settings-db'
import { listOrders, type OrderWithIssue } from '@/lib/press/orders'
import { loadSettings } from '@/lib/press/settings'
import { ThemeToggle } from '@/components/ThemeToggle'
import SignOut from './SignOut'
import { Workbench, type PoolItem, type WorkbenchIssue } from './Workbench'
import { sameOrder, type PressItem } from '@/lib/press/types'

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

/**
 * How many times an issue has been printed.
 *
 * Orders, not copies: one order for three copies is one trip to the printer,
 * and the question the workbench is answering is "have I had this made
 * before?". Refusals and cancellations do not count — nothing was printed —
 * and an issue can legitimately have several, which is why `press_orders` is
 * a table rather than four columns on the issue.
 */
function printCounts(orders: OrderWithIssue[] | null): Map<number, number> {
  const counts = new Map<number, number>()
  for (const order of orders ?? []) {
    if (order.status === 'CANCELED' || order.status === 'REJECTED') continue
    if (order.line_item_status === 'REJECTED') continue
    counts.set(order.issue_number, (counts.get(order.issue_number) ?? 0) + 1)
  }
  return counts
}

export default async function PressPage() {
  if (!pressUiEnabled()) notFound()

  // Whose workbench this is. The middleware has already turned away anyone
  // with no session, but not everyone with a session has a press: an
  // invitation can be withdrawn while a tab is open, and that is a different
  // answer from "sign in".
  let account
  try {
    account = await currentAccount()
  } catch (err) {
    if (err instanceof NotSignedInError) redirect('/press/sign-in')
    if (err instanceof NotInvitedError) redirect('/press/sign-in?error=not-invited')
    throw err
  }
  const db = pressDb(account.id)
  // On a laptop there is no session, so there is nothing to sign out of and a
  // button offering it would put you on a sign-in page you cannot use.
  const signedIn = (await signedInUser()) !== null

  const rows = await listIssueRows(db)

  // Orders and the settings row live in tables migration 013 creates. Until it
  // is applied the rest of the workbench still works, and those two panels say
  // what is missing rather than taking the page down with them.
  let orders: OrderWithIssue[] | null = null
  try {
    orders = await listOrders(db)
  } catch {
    orders = null
  }
  const printed = printCounts(orders)

  const issues: WorkbenchIssue[] = []
  for (const row of rows) {
    const items = await itemsForIssue(row.id, db)
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
      shared: row.visibility === 'shared',
      // The PDFs on file were rendered from `built_order`; if the running
      // order has moved since, the page numbers in them belong to an
      // arrangement that no longer exists and the panel has to say so.
      dirty: !row.interior_path || !sameOrder(order, row.built_order ?? []),
      luluJobId: row.lulu_job_id,
      rejectionReason: row.rejection_reason,
      printCount: printed.get(row.number) ?? 0,
      updatedAt: row.updated_at,
    })
  }

  const [pool, queued, extracted, failed, skipped, dropped] = await Promise.all([
    poolItems(db),
    // The waiting room. Without it a paste of ten links leaves the pool
    // looking untouched for a couple of minutes, which is a paste somebody
    // makes twice.
    itemsInState('queued', db),
    itemsInState('extracted', db),
    itemsInState('failed', db),
    itemsInState('skipped', db),
    itemsInState('dropped', db).catch(() => []),
  ])

  const settings = await loadEffectiveSettings(db)
  const settingsRow = await readSettingsRow(db).catch(() => null)

  const env = loadSettings()

  return (
    <main className="mx-auto max-w-[1600px] px-4 py-6">
      <header className="mb-5 flex items-baseline justify-between gap-4">
        <h1 className="font-serif text-2xl">Saved reading, laid out for print.</h1>
        <div className="flex items-center gap-3">
          {/* Whose press this is, said out loud. With more than one account it
              is the difference between an empty pool and somebody else's. */}
          <span className="text-muted-foreground hidden text-sm sm:inline">
            {account.display_name ?? `@${account.handle}`}
          </span>
          {signedIn && <SignOut />}
          <ThemeToggle />
        </div>
      </header>

      <Workbench
        packageId={loadSettings().luluPackageId}
        // Read-only, and deliberately so. The flag lives in the environment
        // precisely so it cannot be flipped from the screen that presses the
        // button (see SettingsPanel) — but not saying whether it is on meant
        // the order button looked ready on a workbench where no order could
        // ever be placed.
        // Two gates, and both have to be open. The environment flag is V's
        // own safety catch on a button that spends money; `can_order` is the
        // account's — false for everybody who is not her, because ordering
        // bills the one Lulu account on file (plan §6).
        orderingEnabled={process.env.PRESS_ORDER_ENABLED === '1' && account.can_order}
        canOrder={account.can_order}
        issues={issues}
        pool={pool.map(toPoolItem)}
        arriving={[...queued, ...extracted].map(toPoolItem)}
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
        handle={account.handle}
      />
    </main>
  )
}
