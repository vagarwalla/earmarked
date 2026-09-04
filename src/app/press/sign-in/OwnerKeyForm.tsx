'use client'

/**
 * press — the owner's button on the sign-in page.
 *
 * Shut by default, so the page reads as one thing — put in your email — to
 * everybody it is actually for. Opening it is a field and one paste.
 *
 * What is deliberately not here is the key. A button whose href carried it
 * would put a permanent credential in the HTML of a page anybody can open,
 * which is worse than having no sign-in page at all. Bookmarking
 * `/press/enter?key=…` still works and is one click; this is the same door
 * for a browser that does not have the bookmark.
 */

import { useActionState, useState } from 'react'
import { Button } from '@/components/ui/button'
import { enterAsOwner, type OwnerState } from './actions'

export default function OwnerKeyForm() {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState<OwnerState, FormData>(enterAsOwner, {})

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-muted-foreground hover:text-foreground mt-6 text-xs underline underline-offset-2"
      >
        I have an owner key
      </button>
    )
  }

  return (
    <form action={action} className="mt-6 grid gap-2 border-t pt-5">
      <label className="grid gap-1.5 text-sm">
        <span className="text-muted-foreground text-xs">Owner key</span>
        <input
          type="password"
          name="key"
          required
          autoFocus
          autoComplete="off"
          spellCheck={false}
          className="border-input bg-background focus-visible:ring-ring rounded-md border px-3 py-2 font-mono text-xs focus-visible:ring-1 focus-visible:outline-none"
        />
      </label>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? 'Opening…' : 'Open the workbench'}
      </Button>
      {state.error && <p className="text-destructive text-xs">{state.error}</p>}
      <p className="text-muted-foreground text-xs">
        Pasted once per browser, then remembered for a year.
      </p>
    </form>
  )
}
