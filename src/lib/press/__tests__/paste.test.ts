import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  MAX_PER_DAY,
  MAX_PER_PASTE,
  describePaste,
  ingestPaste,
  parsePaste,
} from '../paste'

describe('parsePaste', () => {
  it('takes links out of a copied paragraph, not just a tidy list', async () => {
    const parsed = parsePaste(
      'worth reading https://example.com/a and also https://example.com/b tomorrow',
    )
    expect(parsed.urls).toEqual(['https://example.com/a', 'https://example.com/b'])
    // "worth", "reading", "and"… are not links and are counted, not silently
    // dropped: a paste that absorbs half its input without saying so is the
    // bug this whole module is careful about.
    expect(parsed.rejected.length).toBeGreaterThan(0)
  })

  it('unwraps a link copied out of a newsletter', async () => {
    // <https://…>, markdown, and a trailing sentence comma are all how a link
    // actually arrives when somebody copies one.
    const parsed = parsePaste('<https://example.com/a> [x](https://example.com/b) https://example.com/c,')
    expect(parsed.urls).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ])
  })

  it('counts a link named twice in one paste, and keeps it once', async () => {
    // Normalised, so the tracking-parameter copy and the clean one are one
    // link — which is the same comparison the dedupe index makes.
    const parsed = parsePaste('https://example.com/a\nhttps://www.example.com/a/?utm_source=x')
    expect(parsed.urls).toHaveLength(1)
    expect(parsed.duplicates).toBe(1)
  })

  it('refuses anything that is not http(s)', async () => {
    const parsed = parsePaste('file:///etc/passwd javascript:alert(1) ftp://x.example.com/a')
    expect(parsed.urls).toEqual([])
    expect(parsed.rejected).toHaveLength(3)
  })

  it('cuts a paste that is over the limit, and says it did', async () => {
    const many = Array.from({ length: MAX_PER_PASTE + 5 }, (_, i) => `https://example.com/${i}`)
    const parsed = parsePaste(many.join('\n'))
    expect(parsed.urls).toHaveLength(MAX_PER_PASTE)
    expect(parsed.truncated).toBe(true)
  })

  it('is empty for an empty paste rather than throwing', async () => {
    expect(parsePaste('   \n\n  ').urls).toEqual([])
  })
})

/** A db that accepts inserts and reports a day's count. */
function pasteDb(alreadyToday: number, existing: string[] = []) {
  const inserted: Record<string, unknown>[] = []
  const client = {
    from() {
      const b: Record<string, unknown> = {}
      let counting = false
      b.select = (_cols?: string, opts?: { head?: boolean }) => {
        counting = Boolean(opts?.head)
        return b
      }
      b.gte = () => b
      b.upsert = (row: Record<string, unknown>) => {
        inserted.push(row)
        return b
      }
      b.eq = () => b
      b.then = (r: (v: unknown) => unknown) => {
        if (counting) return Promise.resolve({ count: alreadyToday, error: null }).then(r)
        const row = inserted[inserted.length - 1]
        // ignoreDuplicates: a link this account already has comes back as no
        // rows at all, which is what `insertItem` turns into null.
        const seen = existing.includes(String(row?.url_key))
        return Promise.resolve({ data: seen ? [] : [{ id: 'i1' }], error: null }).then(r)
      }
      return b
    },
  }
  return { client: client as unknown as SupabaseClient, inserted }
}

describe('ingestPaste', () => {
  it('queues what was pasted, as pasted', async () => {
    const db = pasteDb(0)
    const result = await ingestPaste('https://example.com/a\nhttps://example.com/b', db.client)
    expect(result.added).toBe(2)
    expect(db.inserted[0]).toMatchObject({ source: 'paste', state: 'queued' })
  })

  it('reports a link this press already has as already had, not as added', async () => {
    const db = pasteDb(0, ['example.com/a'])
    const result = await ingestPaste('https://example.com/a\nhttps://example.com/b', db.client)
    expect(result).toMatchObject({ added: 1, alreadyHad: 1 })
  })

  it('refuses once the account has had its day', async () => {
    const db = pasteDb(MAX_PER_DAY)
    const result = await ingestPaste('https://example.com/a', db.client)
    expect(result.added).toBe(0)
    expect(result.refused).toMatch(/limit/)
  })

  it('takes what fits rather than refusing the whole paste', async () => {
    // Forty of fifty and a sentence saying so beats none.
    const db = pasteDb(MAX_PER_DAY - 2)
    const urls = ['a', 'b', 'c', 'd'].map((x) => `https://example.com/${x}`).join('\n')
    const result = await ingestPaste(urls, db.client)
    expect(result.added).toBe(2)
    expect(result.truncated).toBe(true)
  })

  it('does not go to the database for a paste with no links in it', async () => {
    const db = pasteDb(0)
    const result = await ingestPaste('not a link at all', db.client)
    expect(result).toMatchObject({ added: 0, rejected: 5 })
    expect(db.inserted).toHaveLength(0)
  })
})

describe('describePaste', () => {
  it('names everything that happened, not just the good half', async () => {
    const line = describePaste({
      added: 31,
      alreadyHad: 4,
      duplicates: 2,
      rejected: 3,
      truncated: false,
    })
    expect(line).toContain('31 added')
    expect(line).toContain('4 you already had')
    expect(line).toContain('2 repeated')
    expect(line).toContain('3 that were not links')
  })

  it('says plainly when nothing landed', async () => {
    const line = describePaste({ added: 0, alreadyHad: 0, duplicates: 0, rejected: 2, truncated: false })
    expect(line).toMatch(/^Nothing to add/)
  })

  it('shows a refusal instead of the counts', async () => {
    const line = describePaste({
      added: 0,
      alreadyHad: 0,
      duplicates: 0,
      rejected: 0,
      truncated: false,
      refused: 'That is the limit.',
    })
    expect(line).toBe('That is the limit.')
  })
})
