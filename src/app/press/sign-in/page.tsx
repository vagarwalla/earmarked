/**
 * press — the door.
 *
 * Outside the middleware's matcher, necessarily: a sign-in page behind a
 * sign-in check is a redirect loop.
 */

import { notFound, redirect } from 'next/navigation'
import { pressUiEnabled } from '@/lib/press/local'
import { signedInAccount } from '@/lib/press/auth'
import { ThemeToggle } from '@/components/ThemeToggle'
import SignInForm from './SignInForm'

export const dynamic = 'force-dynamic'

const REFUSALS: Record<string, string> = {
  'no-code': 'That link was missing its code. Ask for a fresh one.',
  'link-expired': 'That link has expired or was already used. Ask for a fresh one.',
  'not-invited': 'That address is not on the list for this press.',
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  if (!pressUiEnabled()) notFound()

  const { error } = await searchParams
  const refusal = error ? (REFUSALS[error] ?? 'That sign-in did not work.') : null

  // Already in. Landing here from a bookmark should not mean typing an address
  // to be told you did not need to.
  if (await signedInAccount()) redirect('/press')

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8 flex items-baseline justify-between gap-4">
        <h1 className="font-serif text-2xl">press</h1>
        <ThemeToggle />
      </div>
      <p className="text-muted-foreground mb-6 text-sm">
        Saved reading, laid out for print. Invite only — sign in with the address you were
        invited at and a link will arrive.
      </p>
      {refusal && (
        <p className="text-destructive mb-4 text-sm" role="alert">
          {refusal}
        </p>
      )}
      <SignInForm />
    </main>
  )
}
