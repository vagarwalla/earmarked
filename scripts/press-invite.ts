/**
 * press — add somebody to the press, or set the owner's own address.
 *
 *   npm run press:invite -- alex@example.com alex "Alex Whitby"
 *   npm run press:invite -- --owner me@example.com
 *   npm run press:invite -- --list
 *
 * This exists as a command rather than a form because addresses do not belong
 * in this repo — it is public, and migration 018 seeds the owner's account with
 * no email for that reason.
 *
 * An invitation is two things written together: a `press_accounts` row, and
 * the Supabase Auth user it will be signed in as. Creating the auth user here
 * rather than at first sign-in is what lets the project run with signups
 * disabled — otherwise anyone holding the anon key (it is in the page) could
 * ask GoTrue for a magic link to an address of their choosing, and have this
 * project send it. With signups off, only an address that has been through
 * this command can ever receive one.
 *
 * Nobody gets `can_order`. Ordering bills the one Lulu account on file, which
 * is V's; a friend's finish line is the two PDFs (plan §6).
 */

import { pressDbAsService } from '../src/lib/press/db'
import { OWNER_ACCOUNT_ID, accountByEmail, accountByHandle } from '../src/lib/press/accounts'

const HANDLE = /^[a-z0-9][a-z0-9-]{1,30}$/

function usage(message: string): never {
  console.error(`${message}\n`)
  console.error('  npm run press:invite -- <email> <handle> ["Display Name"]')
  console.error('  npm run press:invite -- --owner <email>')
  console.error('  npm run press:invite -- --list')
  process.exit(1)
}

async function list(): Promise<void> {
  const db = pressDbAsService()
  const { data, error } = await db
    .from('press_accounts')
    .select('handle,email,display_name,can_order,auth_user_id,created_at')
    .order('created_at')
  if (error) throw new Error(error.message)

  const rows = (data ?? []) as {
    handle: string
    email: string | null
    display_name: string | null
    can_order: boolean
    auth_user_id: string | null
  }[]
  if (rows.length === 0) {
    console.log('No accounts. Has 018_press_ownership.sql been applied?')
    return
  }
  for (const r of rows) {
    const flags = [r.can_order ? 'can order' : null, r.auth_user_id ? 'signed in' : 'not yet signed in']
      .filter(Boolean)
      .join(', ')
    console.log(`${r.handle.padEnd(16)} ${(r.email ?? '—').padEnd(32)} ${flags}`)
  }
}

async function setOwnerEmail(email: string): Promise<void> {
  const authUserId = await authUserFor(email.trim())
  const db = pressDbAsService()
  const { error } = await db
    .from('press_accounts')
    .update({
      email: email.trim(),
      auth_user_id: authUserId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', OWNER_ACCOUNT_ID)
  if (error) throw new Error(error.message)
  console.log(`The owner account will accept sign-ins from ${email}.`)
}

/**
 * The Supabase user an invitation will be signed in as.
 *
 * Confirmed on creation: the magic link is itself the proof they read mail at
 * the address, so a separate confirmation step would be a second email saying
 * the same thing. Returns the existing user's id when there already is one,
 * which is what makes re-running this safe.
 */
async function authUserFor(email: string): Promise<string> {
  const db = pressDbAsService()

  const { data: created, error } = await db.auth.admin.createUser({
    email,
    email_confirm: true,
  })
  if (!error && created.user) return created.user.id

  // Already registered — the owner signing in before being invited by name,
  // or this command run twice. Find them rather than failing.
  if (error && !/already been registered|already exists/i.test(error.message)) {
    throw new Error(`could not create the sign-in for ${email}: ${error.message}`)
  }
  const { data: list, error: listError } = await db.auth.admin.listUsers({ perPage: 200 })
  if (listError) throw new Error(listError.message)
  const found = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
  if (!found) throw new Error(`${email} is registered but could not be found`)
  return found.id
}

async function invite(email: string, handle: string, displayName: string | null): Promise<void> {
  if (!HANDLE.test(handle)) {
    usage(`"${handle}" is not a handle — lowercase letters, digits and dashes, 2–31 characters.`)
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) usage(`"${email}" is not an email address.`)

  // Both checked up front rather than left to the unique indexes: two
  // constraint violations look identical from here, and "that handle is taken"
  // and "you already invited them" are different things to be told.
  if (await accountByEmail(email)) usage(`${email} already has an account.`)
  if (await accountByHandle(handle)) usage(`The handle "${handle}" is taken.`)

  const authUserId = await authUserFor(email.trim())

  const db = pressDbAsService()
  const { error } = await db.from('press_accounts').insert({
    email: email.trim(),
    handle: handle.toLowerCase(),
    display_name: displayName,
    auth_user_id: authUserId,
    can_order: false,
  })
  if (error) throw new Error(error.message)

  console.log(`Invited ${email} as @${handle}.`)
  console.log('They sign in at /press with a magic link; nothing is sent from here.')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === '--help') usage('press — invite somebody.')
  if (args[0] === '--list') return list()
  if (args[0] === '--owner') {
    if (!args[1]) usage('--owner needs an email address.')
    return setOwnerEmail(args[1])
  }
  if (args.length < 2) usage('An invitation needs an email and a handle.')
  return invite(args[0], args[1], args[2] ?? null)
}

main().catch((err) => {
  console.error(`press/invite: ${(err as Error).message}`)
  process.exit(1)
})
