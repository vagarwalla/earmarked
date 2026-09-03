'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { requestLink, type SignInState } from './actions'

export default function SignInForm() {
  const [state, action, pending] = useActionState<SignInState, FormData>(requestLink, {})

  if (state.sent) {
    return (
      <div className="rounded-lg border p-4">
        <p className="text-sm">
          A link is on its way to <span className="font-medium">{state.sent}</span>. It works
          once and expires; open it on this device if you can.
        </p>
      </div>
    )
  }

  return (
    <form action={action} className="grid gap-3">
      <label className="grid gap-1.5 text-sm">
        <span className="text-muted-foreground">Email</span>
        <input
          type="email"
          name="email"
          required
          autoFocus
          autoComplete="email"
          className="border-input bg-background focus-visible:ring-ring rounded-md border px-3 py-2 text-sm focus-visible:ring-1 focus-visible:outline-none"
        />
      </label>
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? 'Sending…' : 'Send me a link'}
      </Button>
      {state.error && <p className="text-destructive text-sm">{state.error}</p>}
    </form>
  )
}
