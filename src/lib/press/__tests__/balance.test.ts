import { describe, it, expect } from 'vitest'
import { balance } from '../balance'
import type { IssueDraft, PressState, StateItem } from '../issues'
import type { ItemState } from '../types'

function item(id: string, pageCount: number, over: Partial<StateItem> = {}): StateItem {
  return {
    id,
    url: `https://example.com/${id}`,
    raindropId: id,
    title: `Article ${id}`,
    state: 'laid_out',
    pageCount,
    savedAt: `2026-01-${String((Number(id.slice(1)) % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    ...over,
  }
}

function state(items: StateItem[], issues: IssueDraft[]): PressState {
  return { issueNumber: issues.length + 1, items, seen: [], printed: [], issues }
}

const pages = (s: PressState, d: IssueDraft) => {
  const by = new Map(s.items.map((i) => [i.id, i]))
  return d.itemIds.reduce((n, id) => n + (by.get(id)?.pageCount ?? 0), 0)
}

describe('balance', () => {
  it('fills a starved issue out of the pool', () => {
    const claimed = [item('a1', 20, { state: 'in_issue' as ItemState }), item('a2', 16, { state: 'in_issue' as ItemState })]
    const pool = [item('p1', 40), item('p2', 30), item('p3', 24), item('p4', 12)]
    const draft: IssueDraft = { number: 1, itemIds: ['a1', 'a2'], state: 'draft' }
    const s = state([...claimed, ...pool], [draft])

    expect(pages(s, draft)).toBe(36)
    balance(s, [draft], 100, 150)
    expect(pages(s, draft)).toBeGreaterThanOrEqual(100)
    expect(pages(s, draft)).toBeLessThanOrEqual(150)
  })

  it('sheds from an issue over the maximum, from the end', () => {
    const items = [
      item('a1', 60, { state: 'in_issue' as ItemState }),
      item('a2', 60, { state: 'in_issue' as ItemState }),
      item('a3', 50, { state: 'in_issue' as ItemState }),
      item('a4', 20, { state: 'in_issue' as ItemState }),
    ]
    const draft: IssueDraft = { number: 1, itemIds: ['a1', 'a2', 'a3', 'a4'], state: 'draft' }
    const s = state(items, [draft])

    expect(pages(s, draft)).toBe(190)
    balance(s, [draft], 100, 150)
    expect(pages(s, draft)).toBeLessThanOrEqual(150)
    // The front of the running order is untouched.
    expect(draft.itemIds.slice(0, 2)).toEqual(['a1', 'a2'])
  })

  it('never sheds an issue below the minimum to get it under the maximum', () => {
    // 95 + 60 is 155, five over — but shedding the 60 leaves 95, five under.
    // Out of range either way, so it is left alone rather than made worse.
    const items = [item('a1', 95, { state: 'in_issue' as ItemState }), item('a2', 60, { state: 'in_issue' as ItemState })]
    const draft: IssueDraft = { number: 1, itemIds: ['a1', 'a2'], state: 'draft' }
    const s = state(items, [draft])

    balance(s, [draft], 100, 150)
    expect(draft.itemIds).toEqual(['a1', 'a2'])
  })

  it('sheds before it fills, so one issue\'s overflow can feed another', () => {
    const items = [
      item('a1', 70, { state: 'in_issue' as ItemState }),
      item('a2', 50, { state: 'in_issue' as ItemState }),
      item('a3', 45, { state: 'in_issue' as ItemState }),
      item('b1', 90, { state: 'in_issue' as ItemState }),
    ]
    const full: IssueDraft = { number: 1, itemIds: ['a1', 'a2', 'a3'], state: 'draft' }
    const thin: IssueDraft = { number: 2, itemIds: ['b1'], state: 'draft' }
    const s = state(items, [full, thin])

    balance(s, [full, thin], 100, 150)
    // a3 came off issue 1 (165pp) and landed in issue 2 (90pp).
    expect(full.itemIds).toEqual(['a1', 'a2'])
    expect(thin.itemIds).toContain('a3')
    // And it is available again, rather than stranded in `in_issue`.
    expect(s.items.find((i) => i.id === 'a3')?.state).toBe('laid_out')
  })

  it('never puts one article in two issues', () => {
    const items = [item('a1', 40, { state: 'in_issue' as ItemState }), ...Array.from({ length: 8 }, (_, i) => item(`p${i}`, 30))]
    const one: IssueDraft = { number: 1, itemIds: ['a1'], state: 'draft' }
    const two: IssueDraft = { number: 2, itemIds: [], state: 'draft' }
    const s = state(items, [one, two])

    balance(s, [one, two], 100, 150)
    const all = [...one.itemIds, ...two.itemIds]
    expect(new Set(all).size).toBe(all.length)
  })

  it('stops rather than looping when the pool runs dry', () => {
    const draft: IssueDraft = { number: 1, itemIds: ['a1'], state: 'draft' }
    const s = state([item('a1', 10, { state: 'in_issue' as ItemState })], [draft])
    balance(s, [draft], 100, 150)
    expect(pages(s, draft)).toBe(10)
  })
})
