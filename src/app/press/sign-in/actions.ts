'use server'

/**
 * press — asking for a magic link.
 *
 * The invite check happens here, before Supabase is asked to send anything.
 * Doing it the other way round — send the link, refuse at the door — would
 * mean anybody who found the URL could have this app email an address of their
 * choosing, and would fill `auth.users` with people who have no press.
 *
 * "That address is not on the list" is deliberately plain rather than the
 * usual "if that address has an account, we have sent a link". The audience is
 * about six people who know whether they were invited; being coy at them would
 * cost a support message every time and protect nothing.
 */

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { accountByEmail } from '@/lib/press/accounts'
import { sessionClient } from '@/lib/press/auth'

export interface SignInState {
  error?: string
  sent?: string
}

export async function requestLink(_prev: SignInState, form: FormData): Promise<SignInState> {
  const email = String(form.get('email') ?? '').trim()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { error: 'That does not look like an email address.' }
  }

  const account = await accountByEmail(email)
  if (!account) {
    return {
      error: 'That address is not on the list for this press. Ask whoever runs it for an invite.',
    }
  }

  // The link has to come back to the origin the browser is actually on:
  // localhost while developing, the deployment otherwise. Supabase will only
  // honour redirects it has been told about, so both belong in the project's
  // allow-list (see docs/press-runbook.md).
  const origin = (await headers()).get('origin') ?? process.env.PRESS_APP_URL ?? ''

  const supabase = await sessionClient()
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/press/auth/callback`,
      // Never. `press:invite` creates the Supabase user alongside the account
      // row, and the project runs with signups disabled — so an address that
      // has not been invited cannot be made to receive a link, from here or
      // from anywhere else holding the anon key.
      shouldCreateUser: false,
    },
  })
  if (error) {
    // Rate limits are the one failure worth naming precisely: Supabase's
    // built-in mailer allows a few an hour, and "something went wrong" sends
    // you looking at the wrong thing entirely.
    return {
      error: /rate/i.test(error.message)
        ? 'Too many links requested. Wait a few minutes and try again.'
        : error.message,
    }
  }

  return { sent: email }
}

/** End the session and go back to the door. */
export async function signOut(): Promise<void> {
  const supabase = await sessionClient()
  await supabase.auth.signOut()
  redirect('/press/sign-in')
}
