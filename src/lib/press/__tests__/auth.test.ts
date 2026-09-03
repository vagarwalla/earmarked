import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { __setPressClient } from '../db'
import { attachAccount, handleFrom } from '../auth'

/**
 * A press_accounts table, in memory.
 *
 * `attachAccount` is three queries against one table and the interesting part
 * is which row each finds, so the fake tracks the filters and applies them
 * rather than returning a fixed answer.
 */
function accountsDb(rows: Record<string, unknown>[], takenHandles: string[] = []) {
  const updates: Record<string, unknown>[] = []
  const inserts: Record<string, unknown>[] = []
  const client = {
    from() {
      const filters: [string, unknown][] = []
      const nulls: string[] = []
      let patch: Record<string, unknown> | null = null
      let inserting: Record<string, unknown> | null = null

      const match = () =>
        rows.filter(
          (r) =>
            filters.every(([col, val]) =>
              typeof val === 'string' && typeof r[col] === 'string'
                ? (r[col] as string).toLowerCase() === val.toLowerCase()
                : r[col] === val,
            ) && nulls.every((col) => r[col] === null),
        )

      const b: Record<string, unknown> = {}
      b.select = () => b
      b.insert = (row: Record<string, unknown>) => {
        inserting = row
        return b
      }
      b.single = async () => {
        const row = inserting as Record<string, unknown> | null
        if (row && takenHandles.includes(String(row.handle))) {
          return { data: null, error: { code: '23505', message: 'duplicate key: handle' } }
        }
        if (row) {
          inserts.push(row)
          rows.push({ ...row, id: `acct-${rows.length + 1}` })
          return { data: rows[rows.length - 1], error: null }
        }
        return { data: null, error: null }
      }
      b.update = (p: Record<string, unknown>) => {
        patch = p
        return b
      }
      b.eq = (col: string, val: unknown) => {
        filters.push([col, val])
        return b
      }
      b.ilike = (col: string, val: unknown) => {
        filters.push([col, val])
        return b
      }
      b.is = (col: string) => {
        nulls.push(col)
        return b
      }
      b.maybeSingle = async () => {
        const found = match()[0] ?? null
        if (patch && found) {
          Object.assign(found, patch)
          updates.push(patch)
        }
        return { data: found, error: null }
      }
      return b
    },
  }
  return { client: client as unknown as SupabaseClient, updates, inserts, rows }
}

const user = (over: Partial<User> = {}): User =>
  ({ id: 'auth-1', email: 'alex@example.com', ...over }) as User

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
})

afterEach(() => {
  __setPressClient(null)
  vi.unstubAllEnvs()
})

describe('attachAccount', () => {
  it('claims the invitation waiting for that address', async () => {
    // The invitation names an address; signing in proves you read mail there.
    const db = accountsDb([
      { id: 'acct-1', handle: 'alex', email: 'alex@example.com', auth_user_id: null },
    ])
    __setPressClient(db.client)

    const account = await attachAccount(user())
    expect(account?.id).toBe('acct-1')
    expect(db.updates[0]).toMatchObject({ auth_user_id: 'auth-1' })
  })

  it('matches an address that was invited in a different case', async () => {
    const db = accountsDb([
      { id: 'acct-1', handle: 'alex', email: 'Alex@Example.com', auth_user_id: null },
    ])
    __setPressClient(db.client)
    expect((await attachAccount(user()))?.id).toBe('acct-1')
  })

  it('makes a press for somebody nobody has heard of', async () => {
    // Open by default: an address is what a magic link proves you can read,
    // and that is enough to have a press of your own.
    const db = accountsDb([])
    __setPressClient(db.client)

    const account = await attachAccount(user())
    expect(account?.handle).toBe('alex')
    expect(db.inserts[0]).toMatchObject({ auth_user_id: 'auth-1', email: 'alex@example.com' })
  })

  it('never hands a new press the right to spend money', async () => {
    // Ordering bills the one Lulu account on file. Not a parameter, so no
    // sign-in can reach it.
    const db = accountsDb([])
    __setPressClient(db.client)
    await attachAccount(user())
    expect(db.inserts[0].can_order).toBe(false)
  })

  it('takes the next handle when the obvious one is taken', async () => {
    // Two people called alex. Settled by the unique index and a retry rather
    // than by a check beforehand, which would be the same race with steps.
    const db = accountsDb([], ['alex'])
    __setPressClient(db.client)
    expect((await attachAccount(user()))?.handle).toBe('alex-2')
  })

  it('refuses somebody nobody invited when the door is closed', async () => {
    vi.stubEnv('PRESS_INVITE_ONLY', '1')
    const db = accountsDb([
      { id: 'acct-1', handle: 'someone', email: 'someone@example.com', auth_user_id: null },
    ])
    __setPressClient(db.client)
    expect(await attachAccount(user())).toBeNull()
    expect(db.inserts).toHaveLength(0)
  })

  it('does not take over an invitation somebody else has already claimed', async () => {
    // Matched on email, so two people cannot end up on one press by one of
    // them being invited at an address the other also reaches. They get their
    // own instead, under a handle that is free.
    const db = accountsDb([
      { id: 'acct-1', handle: 'alex', email: 'alex@example.com', auth_user_id: 'someone-else' },
    ], ['alex'])
    __setPressClient(db.client)
    const account = await attachAccount(user())
    expect(account?.id).not.toBe('acct-1')
    expect(account?.handle).toBe('alex-2')
  })

  it('is idempotent once attached', async () => {
    const db = accountsDb([
      { id: 'acct-1', handle: 'alex', email: 'alex@example.com', auth_user_id: 'auth-1' },
    ])
    __setPressClient(db.client)
    expect((await attachAccount(user()))?.id).toBe('acct-1')
    // Found by auth_user_id on the first query; nothing written.
    expect(db.updates).toHaveLength(0)
  })

  it('refuses a user with no email at all', async () => {
    const db = accountsDb([])
    __setPressClient(db.client)
    expect(await attachAccount(user({ email: undefined }))).toBeNull()
  })
})


describe('handleFrom', () => {
  it('is the person, not the address', () => {
    // It ends up in a URL anyone can open, so the domain goes — a handle is
    // not an email address and should not read like one.
    expect(handleFrom('alex.whitby@example.com')).toBe('alex-whitby')
  })

  it('drops a plus-tag, which is routing rather than identity', () => {
    expect(handleFrom('alex+reading@example.com')).toBe('alex')
  })

  it('keeps it short and URL-shaped', () => {
    expect(handleFrom('a_very_long_name_that_goes_on_and_on@example.com')).toMatch(
      /^[a-z0-9][a-z0-9-]{0,23}$/,
    )
  })

  it('still gives a press to an address that is all punctuation', () => {
    expect(handleFrom('...@example.com')).toMatch(/^[a-z0-9]/)
  })
})
