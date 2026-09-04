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

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { accountByEmail } from '@/lib/press/accounts'
import {
  OWNER_COOKIE,
  OWNER_COOKIE_MAX_AGE,
  inviteOnly,
  keysMatch,
  ownerKey,
  sessionClient,
} from '@/lib/press/auth'

export interface SignInState {
  error?: string
  sent?: string
}

export interface OwnerState {
  error?: string
}

/**
 * The owner's key, pasted rather than followed as a link.
 *
 * The button that opens this field is on the sign-in page, and the key is
 * deliberately *not* in it. A link with the key in its href would put a
 * permanent credential — every article, the shipping address, the button that
 * spends money at Lulu — in the HTML of a page anybody can open, which would
 * make the sign-in page it sits on pointless. So: a field, pasted once per
 * browser, exchanged for the same year-long cookie `/press/enter` sets.
 *
 * A POST rather than a GET with `?key=`, so the secret does not end up in the
 * URL bar, in browser history, or in a referrer header on the way out.
 */
export async function enterAsOwner(_prev: OwnerState, form: FormData): Promise<OwnerState> {
  const expected = ownerKey()
  const given = String(form.get('key') ?? '').trim()

  // One message for a wrong key and for no key being configured, matching the
  // route's matching 404s: guessing here should say nothing about whether
  // there is anything to guess.
  if (!expected || !given || !keysMatch(given, expected)) {
    return { error: 'That key does not work.' }
  }

  const secure = (await headers()).get('x-forwarded-proto') === 'https'
  ;(await cookies()).set(OWNER_COOKIE, expected, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: OWNER_COOKIE_MAX_AGE,
  })

  redirect('/press')
}

/** Whether to render the owner button at all. */
export async function ownerDoorExists(): Promise<boolean> {
  return ownerKey() !== null
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

/**
 * End the session and go back to the door.
 *
 * The owner's cookie goes too. Without that, signing out on a browser that had
 * been through /press/enter would land straight back on the workbench — not a
 * bug anybody would enjoy diagnosing.
 */
export async function signOut(): Promise<void> {
  const supabase = await sessionClient()
  await supabase.auth.signOut()
  ;(await cookies()).delete(OWNER_COOKIE)
  redirect('/press/sign-in')
}
