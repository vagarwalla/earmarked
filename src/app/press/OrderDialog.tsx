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
 * One issue or several. Several is the interesting case: Lulu charges shipping
 * per job, not per book, so the same issues in one job pay for one parcel
 * rather than two. That saving is the reason for the feature and so it is
 * stated here, as the comparison it actually is, while it is still a choice —
 * once the email is sent the decision has already been made.
 *
 * Every reason the order cannot go ahead is listed rather than the button
 * simply being dead, and each one is fixable from somewhere named in it. A
 * bundle is refused entire if any issue in it is blocked: a Lulu job cannot be
 * placed half-way, and quietly ordering the rest would charge for a delivery
 * nobody asked for.
 *
 * See docs/plans/2026-08-31-003-feat-press-workbench-plan.md §6.
 */

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { readJson } from './readJson'
import type { PrintQuote } from '@/lib/press/types'
import type { ShippingAddress } from '@/lib/press/lulu'

interface PreviewIssue {
  number: number
  name: string | null
  state: string
  pages: number
  reorder: boolean
  blockers: string[]
}

interface Preview {
  issues: PreviewIssue[]
  reorder: boolean
  blockers: string[]
  quote: PrintQuote | null
  quoteError: string | null
  perIssueCents: number[] | null
  separateTotalCents: number | null
  savingCents: number | null
  quantity: number
  sandbox: boolean
  shipTo: ShippingAddress | null
  approveAt: string | null
  /** Resend is configured, so the link can be posted rather than handed over. */
  canEmail: boolean
}

const money = (cents: number | null, currency: string) =>
  cents === null ? '—' : `${(cents / 100).toFixed(2)} ${currency}`

export function OrderDialog({
  issueNumbers,
  onClose,
  onError,
  onNote,
}: {
  issueNumbers: number[]
  onClose: () => void
  onError: (m: string | null) => void
  onNote: (m: string | null) => void
}) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  /**
   * The approval link, when there was no mailer to carry it.
   *
   * Held rather than followed: this dialog priced the parcel, and opening the
   * confirm page for you would collapse the two acts into the one click the
   * whole flow is built to avoid.
   */
  const [approveUrl, setApproveUrl] = useState<string | null>(null)
  /** The same token, so the last act can happen here rather than in a new tab. */
  const [approveToken, setApproveToken] = useState<string | null>(null)
  const [printing, setPrinting] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)

  // The identity of the selection, not the array — a new array of the same
  // issues must not re-price the bundle, which is N+1 calls to Lulu.
  const key = issueNumbers.join(',')

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const res = await fetch(`/api/press/order?issues=${encodeURIComponent(key)}`)
        const body = (await res.json()) as Preview & { error?: string }
        if (!live) return
        if (!res.ok) setFailure(body.error ?? 'Could not price this.')
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
  }, [key])

  const send = async () => {
    setSending(true)
    onError(null)
    try {
      const res = await fetch('/api/press/order', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issues: issueNumbers }),
      })
      const body = await readJson<{
        sentTo: string | null
        approveUrl: string | null
        approveToken: string | null
      }>(res)
      if (!res.ok) {
        setFailure(body.error ?? 'Could not prepare the approval.')
        return
      }
      if (body.approveUrl) {
        // Nowhere to post it, so the last act happens here.
        setApproveUrl(body.approveUrl)
        setApproveToken(body.approveToken ?? null)
        return
      }
      onNote(
        `Approval sent to ${body.sentTo ?? 'the address on file'}. Nothing is ordered until you follow the link.`,
      )
      onClose()
    } finally {
      setSending(false)
    }
  }

  /**
   * Claim the token and place the job, without leaving the dialog.
   *
   * This used to be a link to /press/confirm/<token> in a new tab, which is
   * the right shape for an email — the reader is in their inbox and the page
   * has to reintroduce the whole decision. Reached from the dialog that just
   * priced it, a second tab is a worse version of the panel already on screen,
   * and it hid the outcome on a page nobody returns from.
   */
  const print = async () => {
    if (!approveToken) return
    setPrinting(true)
    setFailure(null)
    try {
      const res = await fetch(`/api/press/action/${encodeURIComponent(approveToken)}`, {
        method: 'POST',
      })
      const body = await readJson<{ status?: string; jobId?: string }>(res)
      if (!res.ok) {
        // The reason, in full. A refused job now says which field Lulu
        // objected to rather than "something went wrong (500)".
        setOutcome({ ok: false, text: body.error ?? `Lulu refused it (${res.status}).` })
        return
      }
      setOutcome({
        ok: true,
        text: `Ordered${body.jobId ? ` — Lulu job ${body.jobId}` : ''}. It is under Orders, with tracking once it ships.`,
      })
      onNote('Ordered. Tracking will appear under Orders.')
    } finally {
      setPrinting(false)
    }
  }

  const ready = preview && preview.blockers.length === 0
  const bundled = issueNumbers.length > 1
  const currency = preview?.quote?.currency ?? 'USD'

  const title = bundled
    ? `Order ${issueNumbers.length} issues together`
    : preview?.reorder
      ? 'Order another copy'
      : `Order Issue ${issueNumbers[0]}`

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="order-title"
    >
      <div className="bg-background w-full max-w-md rounded-lg border p-5 shadow-lg">
        <h3 id="order-title" className="font-serif text-lg">
          {title}
        </h3>

        {loading && <p className="text-muted-foreground mt-3 text-sm">Pricing…</p>}

        {failure && (
          <p className="text-destructive mt-3 text-sm" role="alert">
            {failure}
          </p>
        )}

        {preview && (
          <>
            <ul className="mt-1 space-y-0.5 text-sm">
              {preview.issues.map((issue, i) => (
                <li key={issue.number} className="flex justify-between gap-4">
                  <span className="min-w-0 truncate">
                    {issue.name ?? `Issue ${issue.number}`} · {issue.pages}pp
                  </span>
                  {/* Each issue's own share: its print cost plus an equal part
                      of the one parcel, which is what its order row records. */}
                  {preview.perIssueCents && (
                    <span className="text-muted-foreground shrink-0 tabular-nums">
                      {money(preview.perIssueCents[i] ?? null, currency)}
                    </span>
                  )}
                </li>
              ))}
            </ul>

            <dl className="mt-4 space-y-1.5 text-xs">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">
                  {preview.quantity} cop{preview.quantity === 1 ? 'y' : 'ies'}
                  {bundled ? ' of each' : ''}
                </dt>
                <dd className="tabular-nums">
                  {preview.quote
                    ? `${money(preview.quote.printCents, currency)} print` +
                      (preview.quote.shippingCents !== null
                        ? ` + ${money(preview.quote.shippingCents, currency)} shipping`
                        : '')
                    : '—'}
                </dd>
              </div>
              {preview.quote && (
                <div className="flex justify-between gap-4 border-t pt-1.5 font-medium">
                  <dt>Total</dt>
                  <dd className="tabular-nums">{money(preview.quote.totalCents, currency)}</dd>
                </div>
              )}
              {/* The whole argument for bundling, stated as the comparison it
                  is. Absent rather than zero where either side went unpriced —
                  "we could not work it out" is not a saving of nothing. */}
              {preview.savingCents !== null && preview.separateTotalCents !== null && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">
                    Separately {money(preview.separateTotalCents, currency)}
                  </dt>
                  <dd className="tabular-nums">
                    saves {money(preview.savingCents, currency)}
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
                Lulu could not price it just now ({preview.quoteError}). The approval email will
                carry the price.
              </p>
            )}

            {preview.blockers.length > 0 && (
              <>
                <ul className="text-destructive mt-4 space-y-1 text-xs">
                  {preview.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
                {bundled && (
                  <p className="text-muted-foreground mt-2 text-xs">
                    A print job cannot be placed in part, so none of these go until all of
                    them can.
                  </p>
                )}
              </>
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
              {preview.canEmail
                ? `This sends ${bundled ? 'one email covering all of them' : 'an email'}. Nothing is ordered until you follow the link.`
                : 'No mailer is set up here, so you get the approval link instead. Nothing is ordered until you open it and confirm.'}
            </p>
          </>
        )}

        {approveUrl && !outcome && (
          <div className="mt-4 rounded-md border p-3">
            <p className="text-sm font-medium">What Print does</p>
            <ol className="text-muted-foreground mt-2 list-decimal space-y-1 pl-4 text-xs">
              <li>Sends the interior and cover PDFs to Lulu as one print job.</li>
              <li>
                Charges {preview?.quote ? money(preview.quote.totalCents, currency) : 'the quoted amount'}{' '}
                to the card on your Lulu account.
              </li>
              <li>Moves the issue from “locked” to “ordered” and records the job against it.</li>
              <li>
                If Lulu refuses the files, nothing is charged, the reason appears here, and the
                issue can be ordered again.
              </li>
              <li>Orders then follows it, with status and tracking, until it ships.</li>
            </ol>
            <Button size="lg" className="mt-3 w-full" disabled={printing} onClick={() => void print()}>
              {printing
                ? 'Sending it to Lulu…'
                : `Print it${preview?.quote ? ` — ${money(preview.quote.totalCents, currency)}` : ''}`}
            </Button>
          </div>
        )}

        {outcome && (
          <div
            className={`mt-4 rounded-md border p-3 ${outcome.ok ? '' : 'border-destructive'}`}
            role="status"
          >
            <p className={`text-sm font-medium ${outcome.ok ? '' : 'text-destructive'}`}>
              {outcome.ok ? 'Printing.' : 'Lulu would not take it.'}
            </p>
            <p className="text-muted-foreground mt-1 text-xs break-words">{outcome.text}</p>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button size="lg" variant="outline" onClick={onClose}>
            {approveUrl ? 'Done' : 'Cancel'}
          </Button>
          {!approveUrl && (
            <Button size="lg" disabled={!ready || sending} onClick={() => void send()}>
              {sending
                ? preview?.canEmail
                  ? 'Sending…'
                  : 'Preparing…'
                : preview?.canEmail
                  ? 'Send approval →'
                  : 'Get the approval link →'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
