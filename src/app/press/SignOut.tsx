'use client'

import { signOut } from './sign-in/actions'
import { Button } from '@/components/ui/button'

/** One button. The session lives in a cookie, so ending it is a server action. */
export default function SignOut() {
  return (
    <form action={signOut}>
      <Button type="submit" variant="ghost" size="sm" className="text-muted-foreground">
        Sign out
      </Button>
    </form>
  )
}
