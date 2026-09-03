'use client'

/**
 * The only thing on the confirmation page that changes state, and it does it
 * with a POST. See the note in page.tsx for why the GET must stay inert.
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'

type Status = 'idle' | 'working' | 'done' | 'error'

/** One issue's verdict, as `performBundledApproval` reports it. */
interface IssueOutcome {
  ok: boolean
  status?: string
  issueNumber?: number
  detail?: string
}

interface ActionResult {
  status?: string
  error?: string
  /** Present when the link covered a bundle — one entry per issue in it. */
  issues?: IssueOutcome[]
}

const SAID: Record<string, string> = {
  ordered: 'ordered',
  'already-ordered': 'already ordered — nothing was charged twice',
  rejected: 'refused by Lulu',
  'not-composed': 'not built, so it was not sent',
  'not-configured': 'not sent — the order could not be set up',
}

export default function ConfirmButton({ token, label }: { token: string; label: string }) {
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState<string>('')
  /**
   * Kept as a list, never flattened to a sentence.
   *
   * Lulu validates each interior separately, so "issue 3 is printing and issue
   * 4 was refused" is an ordinary answer to one click. Collapsing that to
   * "done" or to "failed" would hide the half that needs acting on — and one
   * of those halves is a book already paid for.
   */
  const [outcomes, setOutcomes] = useState<IssueOutcome[]>([])

  async function submit() {
    setStatus('working')
    try {
      const res = await fetch(`/api/press/action/${encodeURIComponent(token)}`, { method: 'POST' })
      const body = (await res.json().catch(() => ({}))) as ActionResult
      if (!res.ok) {
        setStatus('error')
        setOutcomes(body.issues ?? [])
        setMessage(body.error ?? `Something went wrong (${res.status}).`)
        return
      }
      setStatus('done')
      setOutcomes(body.issues ?? [])
      setMessage(
        body.issues
          ? body.issues.every((i) => i.ok)
            ? 'Done. You can close this page.'
            : 'The parcel was sent, but not every issue in it was accepted:'
          : body.status === 'already-ordered'
            ? 'Already ordered — nothing was charged twice.'
            : 'Done. You can close this page.',
      )
    } catch {
      setStatus('error')
      setMessage('Could not reach the server. Try again in a moment.')
    }
  }

  // A bundle's per-issue verdicts, printed whether the overall answer was a
  // success or not.
  const detail = outcomes.length > 1 && (
    <ul className="text-muted-foreground mt-3 space-y-0.5 text-sm">
      {outcomes.map((o, i) => (
        <li key={o.issueNumber ?? i}>
          Issue {o.issueNumber ?? '—'}: {SAID[o.status ?? ''] ?? o.status ?? 'unknown'}
          {o.detail ? ` — ${o.detail}` : ''}
        </li>
      ))}
    </ul>
  )

  if (status === 'done') {
    return (
      <div>
        <p className="text-sm">{message}</p>
        {detail}
      </div>
    )
  }

  return (
    <div>
      <Button onClick={submit} disabled={status === 'working'}>
        {status === 'working' ? 'Working…' : label}
      </Button>
      {status === 'error' && (
        <>
          <p className="text-destructive mt-3 text-sm">{message}</p>
          {detail}
        </>
      )}
    </div>
  )
}
