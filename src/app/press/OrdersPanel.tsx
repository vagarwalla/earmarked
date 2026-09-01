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
 * Refresh is here as well as on the worker's poll, because most of this
 * pipeline has only ever run by hand.
 */

import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatMoney, isFinished, type OrderWithIssue } from '@/lib/press/orders'

/** Lulu's own words, softened into the reader's without losing the meaning. */
const STATUS_LABEL: Record<string, string> = {
  pending: 'Not sent yet',
  CREATED: 'Created',
  UNPAID: 'Unpaid',
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
      const body = (await res.json()) as { error?: string; errors?: string[] }
      if (!res.ok) onError(body.error ?? 'Could not refresh.')
      // Partial failure: one job Lulu has forgotten must not read as total
      // failure, so the ones that did refresh still land.
      else if (body.errors?.length) onError(body.errors.join(' · '))
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

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-muted-foreground text-xs">
          {orders.length} order{orders.length === 1 ? '' : 's'}
        </span>
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void refresh()}>
          <RefreshCw data-icon="inline-start" />
          {busy ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <ul className="divide-y rounded-lg border">
        {orders.map((order) => (
          <li key={order.id} className="px-3 py-2.5">
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
              <span className={isFinished(order) ? '' : 'text-foreground'}>
                {STATUS_LABEL[order.status] ?? order.status}
              </span>
              {order.quantity > 1 && <span>{order.quantity} copies</span>}
              <span>{order.placed_at.slice(0, 10)}</span>
            </div>
            {order.message && <p className="text-muted-foreground mt-1 text-xs">{order.message}</p>}
            {order.tracking_urls.length > 0 && (
              <p className="mt-1 flex flex-wrap gap-2 text-xs">
                {order.tracking_urls.map((url, i) => (
                  <a key={url} href={url} target="_blank" rel="noreferrer" className="underline">
                    Track{order.tracking_urls.length > 1 ? ` ${i + 1}` : ''}
                  </a>
                ))}
              </p>
            )}
          </li>
        ))}
        {orders.length === 0 && (
          <li className="text-muted-foreground px-4 py-8 text-center text-xs">
            Nothing ordered yet.
          </li>
        )}
      </ul>
    </div>
  )
}
