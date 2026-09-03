import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sharedIssue, sharedShelf } from '../shared'

/**
 * A database that answers with whatever survives the filters asked of it.
 *
 * The point of these tests is which rows the queries can reach, so the fake
 * applies the filters rather than returning a fixed answer — a helper that
 * ignored `.eq('visibility', 'shared')` would pass every one of them while the
 * real thing leaked private issues.
 */
function sharedDb(tables: Record<string, Record<string, unknown>[]>) {
  const client = {
    from(table: string) {
      const eqs: [string, unknown][] = []
      const ilikes: [string, unknown][] = []
      const notNull: string[] = []
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.order = () => b
      b.limit = () => b
      b.eq = (c: string, v: unknown) => {
        eqs.push([c, v])
        return b
      }
      b.ilike = (c: string, v: unknown) => {
        ilikes.push([c, v])
        return b
      }
      b.not = (c: string) => {
        notNull.push(c)
        return b
      }
      b.is = () => b
      const rows = () =>
        (tables[table] ?? []).filter(
          (r) =>
            eqs.every(([c, v]) => r[c] === v) &&
            ilikes.every(
              ([c, v]) => String(r[c] ?? '').toLowerCase() === String(v).toLowerCase(),
            ) &&
            notNull.every((c) => r[c] !== null && r[c] !== undefined),
        )
      b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null })
      b.then = (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(r)
      return b
    },
    storage: {
      from: () => ({
        createSignedUrl: async (path: string) => ({
          data: { signedUrl: `https://signed.example/${path}` },
          error: null,
        }),
      }),
    },
  }
  return client as unknown as SupabaseClient
}

const account = { id: 'acct-1', handle: 'vaidehi', display_name: 'Vaidehi' }

function issue(over: Record<string, unknown> = {}) {
  return {
    id: 'iss-shared',
    owner_id: 'acct-1',
    number: 9,
    name: 'Things We Made',
    state: 'closed',
    page_total: 214,
    interior_path: 'issues/iss-shared/interior.pdf',
    cover_path: 'issues/iss-shared/cover.pdf',
    built_order: ['a', 'b'],
    visibility: 'shared',
    closed_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    ...over,
  }
}

describe('sharedShelf', () => {
  it('lists only what was marked shared', async () => {
    const db = sharedDb({
      press_accounts: [account],
      press_issues: [issue(), issue({ id: 'iss-private', number: 8, visibility: 'private' })],
    })
    const shelf = await sharedShelf('vaidehi', db)
    expect(shelf?.issues.map((i) => i.number)).toEqual([9])
  })

  it('leaves out a shared issue that was never built', async () => {
    // Sharing a draft would be a page offering a PDF that does not exist, and
    // a reader cannot tell that from a broken link.
    const db = sharedDb({
      press_accounts: [account],
      press_issues: [issue({ interior_path: null })],
    })
    expect((await sharedShelf('vaidehi', db))?.issues).toEqual([])
  })

  it('is null for a handle nobody has', async () => {
    // Not an empty shelf: that would say "this person shares nothing" about
    // somebody who does not exist.
    const db = sharedDb({ press_accounts: [account], press_issues: [issue()] })
    expect(await sharedShelf('nobody', db)).toBeNull()
  })

  it('finds a handle typed in the wrong case', async () => {
    const db = sharedDb({ press_accounts: [account], press_issues: [issue()] })
    expect(await sharedShelf('VAIDEHI', db)).not.toBeNull()
  })
})

describe('sharedIssue', () => {
  it('lists the contents in the order the PDF was rendered from', async () => {
    // built_order, not the items' positions: if the two disagree, the PDF is
    // what the reader is holding.
    const db = sharedDb({
      press_accounts: [account],
      press_issues: [issue({ built_order: ['b', 'a'] })],
      press_items: [
        { id: 'a', issue_id: 'iss-shared', title: 'First', page_count: 10 },
        { id: 'b', issue_id: 'iss-shared', title: 'Second', page_count: 5 },
      ],
    })
    const found = await sharedIssue('vaidehi', 9, db)
    expect(found?.articles.map((a) => a.title)).toEqual(['Second', 'First'])
  })

  it('refuses a private issue asked for by number', async () => {
    // Guessing the number of an unshared issue gets a 404, not its contents.
    const db = sharedDb({
      press_accounts: [account],
      press_issues: [issue({ number: 8, visibility: 'private' })],
      press_items: [],
    })
    expect(await sharedIssue('vaidehi', 8, db)).toBeNull()
  })

  it('hands back signed links rather than storage paths', async () => {
    const db = sharedDb({
      press_accounts: [account],
      press_issues: [issue()],
      press_items: [{ id: 'a', issue_id: 'iss-shared', title: 'First', page_count: 10 }],
    })
    const found = await sharedIssue('vaidehi', 9, db)
    expect(found?.interiorUrl).toMatch(/^https:\/\/signed\.example\//)
  })

  it('is a projection, not the row', async () => {
    // The read-only guarantee is the ownership scoping (018) — every editing
    // route resolves its issue through the caller's own client, so a stranger
    // holding an id can do nothing with it. This is the second layer: what
    // reaches the page has no ids in it to try.
    //
    // The one exception is deliberate and unavoidable: a signed Storage URL
    // names the object, so the issue's UUID is visible inside it. It is a
    // capability that expires in an hour, not a handle to the row.
    const db = sharedDb({
      press_accounts: [account],
      press_issues: [issue()],
      press_items: [{ id: 'a', issue_id: 'iss-shared', title: 'First', page_count: 10 }],
    })
    const found = await sharedIssue('vaidehi', 9, db)

    expect(Object.keys(found?.articles[0] ?? {})).toEqual([
      'title',
      'byline',
      'sourceName',
      'pages',
    ])
    const { interiorUrl, coverUrl, ...rest } = found ?? {}
    expect(interiorUrl).toBeTruthy()
    expect(coverUrl).toBeTruthy()
    expect(JSON.stringify(rest)).not.toContain('iss-shared')
    expect(JSON.stringify(rest)).not.toContain('acct-1')
  })
})
