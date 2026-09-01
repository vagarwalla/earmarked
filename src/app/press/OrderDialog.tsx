'use client'

/**
 * press — the order dialog.
 *
 * This is where you catch a wrong address or a stale email. It spends nothing:
 * the button at the bottom sends an email, and it is the link in that email
 * that creates a Lulu job. Two deliberate acts, in two places, with the price
 * shown before either — because the failure this is designed against is not a
 * bug, it is pressing the wrong button quickly.
 *
 * Every reason the order cannot go ahead is listed rather than the button
 * simply being dead, and each one is fixable from somewhere named in it.
 *
 * See docs/plans/2026-08-31-003-feat-press-workbench-plan.md §6.
 */

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { readJson } from './readJson'
import type { PrintQuote } from '@/lib/press/types'
import type { ShippingAddress } from '@/lib/press/lulu'

interface Preview {
  issue: { number: number; name: string | null; state: string; pages: number }
  reorder: boolean
  blockers: string[]
  quote: PrintQuote | null
  quoteError: string | null
  quantity: number
  sandbox: boolean
  shipTo: ShippingAddress | null
  approveAt: string | null
}

const money = (cents: number | null, currency: string) =>
  cents === null ? '—' : `${(cents / 100).toFixed(2)} ${currency}`

export function OrderDialog({
  issueNumber,
  onClose,
  onError,
  onNote,
}: {
  issueNumber: number
  onClose: () => void
  onError: (m: string | null) => void
  onNote: (m: string | null) => void
}) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const res = await fetch(`/api/press/issue/${issueNumber}/order`)
        const body = (await res.json()) as Preview & { error?: string }
        if (!live) return
        if (!res.ok) setFailure(body.error ?? 'Could not price this issue.')
        else setPreview(body)
      } catch (err) {
        if (live) setFailure((err as Error).message)
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => {
      live = false
    }
  }, [issueNumber])

  const send = async () => {
    setSending(true)
    onError(null)
    try {
      const res = await fetch(`/api/press/issue/${issueNumber}/order`, { method: 'POST' })
      const body = await readJson<{ sentTo: string }>(res)
      if (!res.ok) {
        setFailure(body.error ?? 'Could not send the approval email.')
        return
      }
      onNote(`Approval sent to ${body.sentTo ?? 'the address on file'}. Nothing is ordered until you follow it.`)
      onClose()
    } finally {
      setSending(false)
    }
  }

  const ready = preview && preview.blockers.length === 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="order-title"
    >
      <div className="bg-background w-full max-w-md rounded-lg border p-5 shadow-lg">
        <h3 id="order-title" className="font-serif text-lg">
          {preview?.reorder ? 'Order another copy' : `Order Issue ${issueNumber}`}
        </h3>

        {loading && <p className="text-muted-foreground mt-3 text-sm">Pricing…</p>}

        {failure && (
          <p className="text-destructive mt-3 text-sm" role="alert">
            {failure}
          </p>
        )}

        {preview && (
          <>
            <p className="mt-1 text-sm">
              {preview.issue.name ?? `Issue ${preview.issue.number}`} · {preview.issue.pages}pp
            </p>

            <dl className="mt-4 space-y-1.5 text-xs">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">
                  {preview.quantity} cop{preview.quantity === 1 ? 'y' : 'ies'}
                </dt>
                <dd className="tabular-nums">
                  {preview.quote
                    ? `${money(preview.quote.printCents, preview.quote.currency)} print` +
                      (preview.quote.shippingCents !== null
                        ? ` + ${money(preview.quote.shippingCents, preview.quote.currency)} shipping`
                        : '')
                    : '—'}
                </dd>
              </div>
              {preview.quote && (
                <div className="flex justify-between gap-4 border-t pt-1.5 font-medium">
                  <dt>Total</dt>
                  <dd className="tabular-nums">
                    {money(preview.quote.totalCents, preview.quote.currency)}
                  </dd>
                </div>
              )}
              {preview.shipTo && (
                <div className="flex justify-between gap-4 pt-1">
                  <dt className="text-muted-foreground shrink-0">Ship to</dt>
                  <dd className="text-right">
                    {[preview.shipTo.name, preview.shipTo.street1, preview.shipTo.city, preview.shipTo.postcode]
                      .filter(Boolean)
                      .join(' · ')}
                  </dd>
                </div>
              )}
              {preview.approveAt && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground shrink-0">Approve at</dt>
                  <dd className="text-right">{preview.approveAt}</dd>
                </div>
              )}
            </dl>

            {preview.quoteError && (
              <p className="text-muted-foreground mt-3 text-xs">
                Lulu would not quote just now ({preview.quoteError}). The approval email will carry the
                price.
              </p>
            )}

            {preview.blockers.length > 0 && (
              <ul className="text-destructive mt-4 space-y-1 text-xs">
                {preview.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}

            <p
              className={`mt-4 rounded-md border px-2.5 py-2 text-xs ${
                preview.sandbox ? '' : 'border-destructive text-destructive'
              }`}
            >
              {preview.sandbox
                ? '⚠ SANDBOX — no money will be spent.'
                : '⚠ LIVE — approving will charge the card on your Lulu account.'}
            </p>

            <p className="text-muted-foreground mt-3 text-xs">
              This sends an email. Nothing is ordered until you follow the link in it.
            </p>
          </>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!ready || sending} onClick={() => void send()}>
            {sending ? 'Sending…' : 'Send approval →'}
          </Button>
        </div>
      </div>
    </div>
  )
}
