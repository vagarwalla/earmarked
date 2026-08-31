'use client'

/**
 * The only thing on the confirmation page that changes state, and it does it
 * with a POST. See the note in page.tsx for why the GET must stay inert.
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'

type Status = 'idle' | 'working' | 'done' | 'error'

export default function ConfirmButton({ token, label }: { token: string; label: string }) {
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState<string>('')

  async function submit() {
    setStatus('working')
    try {
      const res = await fetch(`/api/press/action/${encodeURIComponent(token)}`, { method: 'POST' })
      const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string }
      if (!res.ok) {
        setStatus('error')
        setMessage(body.error ?? `Something went wrong (${res.status}).`)
        return
      }
      setStatus('done')
      setMessage(
        body.status === 'already-ordered'
          ? 'Already ordered — nothing was charged twice.'
          : 'Done. You can close this page.',
      )
    } catch {
      setStatus('error')
      setMessage('Could not reach the server. Try again in a moment.')
    }
  }

  if (status === 'done') return <p className="text-sm">{message}</p>

  return (
    <div>
      <Button onClick={submit} disabled={status === 'working'}>
        {status === 'working' ? 'Working…' : label}
      </Button>
      {status === 'error' && <p className="text-destructive mt-3 text-sm">{message}</p>}
    </div>
  )
}
