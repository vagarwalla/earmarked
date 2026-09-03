import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { pressDb } from '../db'

/**
 * A client that records the calls made against it.
 *
 * Every builder method returns the builder, which is what the real PostgREST
 * one does; what these tests check is *which* calls the proxy adds and to
 * which tables, not what comes back.
 */
function recorder() {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const base = {
    from(table: string) {
      const b: Record<string, unknown> = {}
      for (const method of ['select', 'insert', 'upsert', 'update', 'delete', 'eq', 'in', 'order', 'limit']) {
        b[method] = (...args: unknown[]) => {
          calls.push({ table, method, args })
          return b
        }
      }
      b.maybeSingle = async () => ({ data: null, error: null })
      return b
    },
    rpc: async (name: string, args?: unknown) => {
      calls.push({ table: '', method: `rpc:${name}`, args: [args] })
      return { data: null, error: null }
    },
    storage: { from: () => ({}) },
  }
  return { base: base as unknown as SupabaseClient, calls }
}

const OWNER = 'acct-1'

describe('pressDb scoping', () => {
  it('carries the owner on every read of an owned table', async () => {
    const { base, calls } = recorder()
    await pressDb(OWNER, base).from('press_items').select('*').eq('state', 'laid_out')

    // The owner filter is applied by the proxy, before the caller's own — so
    // there is no way to write a query against these tables that omits it.
    expect(calls.filter((c) => c.method === 'eq')[0].args).toEqual(['owner_id', OWNER])
  })

  it('scopes updates and deletes too, not only reads', async () => {
    const { base, calls } = recorder()
    const db = pressDb(OWNER, base)
    await db.from('press_issues').update({ name: 'x' }).eq('id', 'iss1')
    await db.from('press_items').delete().eq('id', 'i1')

    const owners = calls.filter((c) => c.method === 'eq' && c.args[0] === 'owner_id')
    expect(owners).toHaveLength(2)
  })

  it('stamps the owner onto an insert, and onto every row of a bulk one', async () => {
    const { base, calls } = recorder()
    const db = pressDb(OWNER, base)
    await db.from('press_items').insert({ url: 'https://example.com/a' })
    await db.from('press_items').insert([{ url: 'https://example.com/b' }, { url: 'https://example.com/c' }])

    const [single, bulk] = calls.filter((c) => c.method === 'insert')
    expect(single.args[0]).toMatchObject({ owner_id: OWNER })
    expect(bulk.args[0]).toEqual([
      { url: 'https://example.com/b', owner_id: OWNER },
      { url: 'https://example.com/c', owner_id: OWNER },
    ])
  })

  it('leaves tables that are not press alone', async () => {
    // Carts, editions and cover hashes are the rest of earmarked and have no
    // owner_id at all — filtering on one would be an error, not a safeguard.
    const { base, calls } = recorder()
    await pressDb(OWNER, base).from('carts').select('*')
    expect(calls.some((c) => c.method === 'eq')).toBe(false)
  })

  it('leaves press_action_tokens alone, because a token is its own authority', async () => {
    // An approval link is opened by somebody who is not signed in. Scoping
    // this table would mean the link only worked inside a session, which is
    // exactly what it exists to avoid.
    const { base, calls } = recorder()
    await pressDb(OWNER, base).from('press_action_tokens').select('*')
    expect(calls.some((c) => c.method === 'eq')).toBe(false)
  })

  it('passes rpc through untouched', async () => {
    // The SQL functions take ids, and an id got that far by having been read
    // back through a scoped query. The exception is press_set_issue_order,
    // which takes an array straight from a drag and checks ownership itself.
    const { base, calls } = recorder()
    await pressDb(OWNER, base).rpc('press_close_issue', { p_issue_id: 'iss1' })
    expect(calls.find((c) => c.method === 'rpc:press_close_issue')?.args[0]).toEqual({
      p_issue_id: 'iss1',
    })
  })

  it('gives two owners two different views of the same table', async () => {
    const { base, calls } = recorder()
    await pressDb('a', base).from('press_issues').select('*')
    await pressDb('b', base).from('press_issues').select('*')
    expect(calls.filter((c) => c.method === 'eq').map((c) => c.args[1])).toEqual(['a', 'b'])
  })
})
