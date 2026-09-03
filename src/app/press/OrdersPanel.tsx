'use client'

/**
 * press — orders placed, newest first.
 *
 * An order is a row rather than four columns on the issue, which is what makes
 * this a list at all: the same issue can be printed more than once, to
 * different addresses, eventually by different people. Each row shows where
 * Lulu has got to and what it cost, and the address it shipped to is the one
 * snapshotted at order time — editing Settings must not rewrite the history of
 * what was already sent.
 *
 * Rows that went to Lulu in one job are shown as one entry. The charge is per
 * job — that is the whole reason for bundling — so a flat list would report a
 * parcel as two orders of about half the price each and leave the reader to
 * work out that one delivery is coming. The rows themselves are untouched:
 * everything downstream of an order is still per issue, and each issue keeps
 * its own status line inside the group, because Lulu validates each interior
 * separately and one refused line does not make the job a failure.
 *
 * Refresh is here as well as on the worker's poll, because most of this
 * pipeline has only ever run by hand.
 */

import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { readJson } from './readJson'
import { formatMoney, groupByBundle, isFinished, type OrderWithIssue } from '@/lib/press/orders'

/** Lulu's own words, softened into the reader's without losing the meaning. */
const STATUS_LABEL: Record<string, string> = {
  pending: 'Not sent yet',
  CREATED: 'Created',
  UNPAID: 'Waiting to be paid',
  PAYMENT_IN_PROGRESS: 'Paying',
  PRODUCTION_DELAYED: 'Delayed',
  PRODUCTION_READY: 'Ready to print',
  IN_PRODUCTION: 'Printing',
  SHIPPED: 'Shipped',
  REJECTED: 'Rejected',
  CANCELED: 'Cancelled',
}

export function OrdersPanel({
  orders,
  onError,
  onRefresh,
}: {
  orders: OrderWithIssue[] | null
  onError: (m: string | null) => void
  onRefresh: () => void
}) {
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    setBusy(true)
    onError(null)
    try {
      const res = await fetch('/api/press/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'refresh' }),
      })
      const body = await readJson<{ errors: string[] }>(res)
      if (!res.ok) onError(body.error ?? 'Could not refresh.')
      // Partial failure: one job Lulu has forgotten must not read as total
      // failure, so the ones that did refresh still land.
      else if (body.errors?.length) onError(body.errors.join(' · '))
      onRefresh()
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (orderId: string) => {
    setBusy(true)
    onError(null)
    try {
      const res = await fetch('/api/press/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', orderId }),
      })
      const body = await readJson(res)
      if (!res.ok) onError(body.error ?? 'Could not cancel it.')
      onRefresh()
    } finally {
      setBusy(false)
    }
  }

  const release = async (orderId: string) => {
    setBusy(true)
    onError(null)
    try {
      const res = await fetch('/api/press/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'release', orderId }),
      })
      const body = await readJson(res)
      if (!res.ok) onError(body.error ?? 'Could not release it.')
      onRefresh()
    } finally {
      setBusy(false)
    }
  }

  if (orders === null) {
    return (
      <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-xs">
        No orders table yet — apply migration 013 with
        <br />
        <code className="bg-muted mt-1 inline-block rounded px-1.5 py-0.5">
          npm run db:apply -- 013_press_workbench.sql
        </code>
      </p>
    )
  }

  const groups = groupByBundle(orders)

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-muted-foreground text-xs">
          {orders.length} order{orders.length === 1 ? '' : 's'}
          {groups.length !== orders.length && ` in ${groups.length} job${groups.length === 1 ? '' : 's'}`}
        </span>
        <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
          <RefreshCw data-icon="inline-start" />
          {busy ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <ul className="divide-y rounded-lg border">
        {groups.map((group) => {
          const bundled = group.orders.length > 1
          // One parcel, so one set of tracking links however many issues are
          // in it; a line that carries its own is preferred where it does.
          const tracking = [...new Set(group.orders.flatMap((o) => o.tracking_urls))]
          return (
            <li key={group.key} className="px-3 py-2.5">
              {bundled && (
                <div className="mb-1.5 flex items-baseline gap-2">
                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                    One job · {group.orders.length} issues · one parcel
                  </span>
                  <span className="shrink-0 text-xs tabular-nums">
                    {formatMoney(group.totalCents, group.currency)}
                  </span>
                </div>
              )}
              <ul className={bundled ? 'space-y-1.5 border-l pl-2.5' : ''}>
                {group.orders.map((order) => (
                  <li key={order.id}>
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate font-serif text-sm">
                        {order.issue_name ?? `Issue ${order.issue_number}`}
                      </span>
                      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                        {formatMoney(order.cost_cents, order.currency)}
                      </span>
                    </div>
                    <div className="text-muted-foreground mt-0.5 flex flex-wrap items-baseline gap-x-2 text-xs">
                      <span>#{order.issue_number}</span>
                      {/* The job's status, except where this issue's own line
                          was refused: a bundle's job status covers the parcel
                          and says nothing about which interior Lulu rejected,
                          and a refused issue must not read as "Printing"
                          because the issue beside it is. */}
                      <span className={isFinished(order) ? '' : 'text-foreground'}>
                        {order.line_item_status === 'REJECTED'
                          ? STATUS_LABEL.REJECTED
                          : (STATUS_LABEL[order.status] ?? order.status)}
                      </span>
                      {order.quantity > 1 && <span>{order.quantity} copies</span>}
                      <span>{order.placed_at.slice(0, 10)}</span>
                    </div>
                    {order.message && (
                      <p className="text-muted-foreground mt-1 text-xs">{order.message}</p>
                    )}
                    {/* Lulu took the files and is waiting for the money. Not a
                        failure and not done: the book does not print until this
                        is paid, and paying is the one step that cannot happen
                        from here — no card number goes anywhere near this app. */}
                    {order.status === 'UNPAID' && order.lulu_job_id && (
                      <div className="mt-1.5 rounded-md border px-2.5 py-2">
                        <p className="text-xs">
                          Lulu accepted it and is waiting to be paid. It does not print until then.
                        </p>
                        <a
                          className="mt-1.5 inline-block text-xs underline"
                          href="https://developers.lulu.com/print-jobs"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Pay print job {order.lulu_job_id} at Lulu →
                        </a>
                        {/* The other way out, and the reason it is offered
                            here: several issues in ONE job pay for one parcel,
                            and that choice is made when the job is created.
                            Lulu cannot merge two jobs afterwards, so an unpaid
                            job for one issue is the thing standing between
                            this and a cheaper parcel holding it and the next
                            one. Cancelling is how you change your mind. */}
                        <div className="mt-2 flex items-baseline gap-2 border-t pt-2">
                          <p className="text-muted-foreground min-w-0 flex-1 text-xs">
                            Want it in one parcel with another issue? Cancel this, then tick both in
                            the rail — one job, one shipping charge.
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void cancel(order.id)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* A row claimed before Lulu was called and never given a
                        job: the issue counts it as an order in progress and
                        cannot be ordered again until it is let go. Offered only
                        here, because a row that names a job is a real order and
                        releasing it would allow a second one. */}
                    {!order.lulu_job_id && !isFinished(order) && (
                      <div className="mt-1.5 flex items-baseline gap-2">
                        <p className="text-muted-foreground min-w-0 flex-1 text-xs">
                          Held, but Lulu never took it — this is blocking a new order for #
                          {order.issue_number}.
                        </p>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void release(order.id)}
                        >
                          Release
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {tracking.length > 0 && (
                <p className="mt-1 flex flex-wrap gap-2 text-xs">
                  {tracking.map((url, i) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer" className="underline">
                      Track{tracking.length > 1 ? ` ${i + 1}` : ''}
                    </a>
                  ))}
                </p>
              )}
            </li>
          )
        })}
        {orders.length === 0 && (
          <li className="text-muted-foreground px-4 py-8 text-center text-xs">
            Nothing ordered yet.
          </li>
        )}
      </ul>
    </div>
  )
}
