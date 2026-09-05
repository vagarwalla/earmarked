import { describe, it, expect, vi } from 'vitest'
import { digestLines, digestHtml, sendWeeklyDigest, DROPPED_REASON } from '../digest'
import { isWeeklyTick } from '../../../../worker/index'
import type { PressItem } from '../types'
import type { PressSettings } from '../settings'

function item(over: Partial<PressItem> = {}): PressItem {
  // A named, typed base rather than one literal: spreading a `Partial<T>`
  // over a `T` widens every field the partial declares back to `| undefined`,
  // so the result stops being a `T`. Annotating the base keeps the literal
  // contextually typed, and Object.assign keeps the override behaviour.
  const base: PressItem = {
    // Owned, as every press row has been since migration 018. The factories
    // carry it so a test row is the shape the database actually stores.
    owner_id: '00000000-0000-0000-0000-000000000001',
    id: 'i1',
    url: 'https://example.com/a',
    url_key: 'example.com/a',
    source: 'raindrop',
    raindrop_id: null,
    state: 'failed',
    issue_id: null,
    position: null,
    title: 'A piece',
    byline: null,
    source_name: null,
    published_at: null,
    content_path: null,
    fragment_path: null,
    page_count: null,
    failure_reason: 'extraction ladder exhausted',
    raw_email_path: null,
    is_linkpost: false,
    linkpost_parent_id: null,
    linkpost_anchor: null,
    linkpost_scanned_at: null,
    created_at: '2026-08-25T00:00:00Z',
    updated_at: '2026-08-28T00:00:00Z',
  }
  return Object.assign(base, over)
}

const since = new Date('2026-08-23T00:00:00Z')

describe('digestLines', () => {
  it('reports this week’s failures with their reasons', () => {
    const lines = digestLines([item({ failure_reason: 'paywalled' })], since)
    expect(lines).toEqual([
      {
        title: 'A piece',
        url: 'https://example.com/a',
        source: 'raindrop',
        reason: 'paywalled',
        when: '2026-08-28',
      },
    ])
  })

  it('excludes an article V chose to drop — that is a decision, not a failure', () => {
    expect(digestLines([item({ failure_reason: DROPPED_REASON })], since)).toHaveLength(0)
  })

  it('excludes failures from before the window', () => {
    expect(digestLines([item({ updated_at: '2026-08-01T00:00:00Z' })], since)).toHaveLength(0)
  })

  it('ignores items that are not failed', () => {
    expect(digestLines([item({ state: 'in_issue' })], since)).toHaveLength(0)
  })

  it('falls back to the url when a failed item never got a title', () => {
    expect(digestLines([item({ title: null })], since)[0].title).toBe('https://example.com/a')
  })
})

describe('digestHtml', () => {
  it('lists each failure and its reason', () => {
    const html = digestHtml(digestLines([item({ failure_reason: 'paywalled' })], since))
    expect(html).toContain('A piece')
    expect(html).toContain('paywalled')
    expect(html).toContain('1 item failed')
  })

  it('escapes a title carrying markup', () => {
    const html = digestHtml(digestLines([item({ title: '<script>x</script>' })], since))
    expect(html).not.toContain('<script>')
  })
})

describe('sendWeeklyDigest', () => {
  function db(items: PressItem[]) {
    const client = {
      from() {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.in = () => b
        b.eq = () => b
        b.order = () => b
        b.limit = () => b
        b.insert = () => b
        b.update = () => b
        b.upsert = () => b
        b.maybeSingle = async () => ({ data: null, error: null })
        b.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: items, error: null }).then(r)
        return b
      },
      rpc: async () => ({ data: null, error: null }),
    }
    return client as never
  }

  const settings = {
    resendApiKey: 're_key',
    mailFrom: 'press@example.com',
    mailTo: 'owner@example.com',
  } as PressSettings

  it('sends nothing on a quiet week, rather than an all-clear nobody reads', async () => {
    const fetchImpl = vi.fn()
    const result = await sendWeeklyDigest(since, { db: db([]), settings, fetchImpl: fetchImpl as never })
    expect(result).toEqual({ sent: false, count: 0 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends when there is something to report', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const result = await sendWeeklyDigest(since, {
      db: db([item(), item({ id: 'i2' })]),
      settings,
      fetchImpl: fetchImpl as never,
    })
    expect(result).toEqual({ sent: true, count: 2 })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('does not send a digest made only of dropped articles', async () => {
    const fetchImpl = vi.fn()
    const result = await sendWeeklyDigest(since, {
      db: db([item({ failure_reason: DROPPED_REASON })]),
      settings,
      fetchImpl: fetchImpl as never,
    })
    expect(result.sent).toBe(false)
  })
})

describe('isWeeklyTick', () => {
  it('fires on Sunday evening Pacific', () => {
    // 2026-08-30 is a Sunday; 19:00 PT is 02:00 UTC the next day.
    expect(isWeeklyTick(new Date('2026-08-31T02:30:00Z'))).toBe(true)
  })

  it('does not fire at other hours or on other days', () => {
    expect(isWeeklyTick(new Date('2026-08-31T10:30:00Z'))).toBe(false) // Sunday morning PT
    expect(isWeeklyTick(new Date('2026-09-01T02:30:00Z'))).toBe(false) // Monday evening PT
  })
})
