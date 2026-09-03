'use server'

/**
 * press — asking for a magic link.
 *
 * Open: any address gets one, and following it makes a press if there is not
 * one already. The account is created on the far side, in `attachAccount`,
 * rather than here — so a link that is never followed leaves nothing behind.
 *
 * `PRESS_INVITE_ONLY=1` closes it. Then the address is checked against
 * `press_accounts` *before* Supabase is asked to send anything, because doing
 * it the other way round — send the link, refuse at the door — would let
 * anybody who found this page have the app email an address of their choosing.
 *
 * "That address is not on the list" is deliberately plain rather than the usual
 * "if that address has an account, we have sent a link". Being coy at a handful
 * of people who know whether they were invited costs a support message every
 * time and protects nothing.
 */

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { accountByEmail } from '@/lib/press/accounts'
import { inviteOnly, sessionClient } from '@/lib/press/auth'

export interface SignInState {
  error?: string
  sent?: string
}

export async function requestLink(_prev: SignInState, form: FormData): Promise<SignInState> {
  const email = String(form.get('email') ?? '').trim()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { error: 'That does not look like an email address.' }
  }

  if (inviteOnly() && !(await accountByEmail(email))) {
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
      // A first sign-in is a new reader, so Supabase has to be allowed to
      // make them a user. What it does *not* do is make them a press — that
      // happens in `attachAccount` when the link is actually followed, so an
      // address someone typed by mistake leaves nothing behind.
      //
      // Closed mode still relies on the check above rather than on this: the
      // anon key is in the page, so anybody could send this request straight
      // to GoTrue. Turn signups off in the Supabase project as well as setting
      // PRESS_INVITE_ONLY if that ever matters.
      shouldCreateUser: true,
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
