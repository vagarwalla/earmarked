import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { __setPressClient } from '../db'
import { attachAccount } from '../auth'

/**
 * A press_accounts table, in memory.
 *
 * `attachAccount` is three queries against one table and the interesting part
 * is which row each finds, so the fake tracks the filters and applies them
 * rather than returning a fixed answer.
 */
function accountsDb(rows: Record<string, unknown>[]) {
  const updates: Record<string, unknown>[] = []
  const client = {
    from() {
      const filters: [string, unknown][] = []
      const nulls: string[] = []
      let patch: Record<string, unknown> | null = null

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
  return { client: client as unknown as SupabaseClient, updates }
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

  it('returns null for somebody nobody invited', async () => {
    // Signed in as far as Supabase is concerned, and still not welcome. The
    // callback signs them back out rather than leaving a session every page
    // will refuse.
    const db = accountsDb([
      { id: 'acct-1', handle: 'someone', email: 'someone@example.com', auth_user_id: null },
    ])
    __setPressClient(db.client)
    expect(await attachAccount(user())).toBeNull()
  })

  it('will not take an invitation somebody else has already claimed', async () => {
    // Matched on email, so two people cannot end up on one press by one of
    // them being invited at an address the other also reaches.
    const db = accountsDb([
      { id: 'acct-1', handle: 'alex', email: 'alex@example.com', auth_user_id: 'someone-else' },
    ])
    __setPressClient(db.client)
    expect(await attachAccount(user())).toBeNull()
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
