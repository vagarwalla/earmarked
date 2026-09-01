import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SELECTION,
  archiveUrl,
  engagementScore,
  excerptFor,
  isSignpost,
  selectPosts,
  tagsFor,
  type SubstackPost,
} from '../substack'

function post(over: Partial<SubstackPost & { source: string; publication: string; topic: string }> = {}) {
  return {
    title: 'An Essay',
    subtitle: null,
    canonical_url: 'https://example.com/p/an-essay',
    post_date: '2026-01-01T00:00:00.000Z',
    type: 'newsletter',
    wordcount: 3000,
    reaction_count: 200,
    restacks: 0,
    comment_count: 0,
    source: 'example.com',
    publication: 'Example',
    topic: 'sociology',
    ...over,
  }
}

describe('engagementScore', () => {
  it('weights a restack at three reactions', () => {
    expect(engagementScore(post({ reaction_count: 0, restacks: 10, comment_count: 0 }))).toBe(30)
  })

  it('weights a comment at half a reaction', () => {
    expect(engagementScore(post({ reaction_count: 0, restacks: 0, comment_count: 10 }))).toBe(5)
  })

  it('treats missing counts as zero rather than NaN', () => {
    expect(engagementScore({ title: '', canonical_url: '', post_date: '' })).toBe(0)
  })
})

describe('isSignpost', () => {
  it.each([
    '18 Books. 6 Months. 5 Must-Reads.',
    'Book Review Contest 2024 Winners',
    'The Winning Essays for the Big Questions About AI',
    'Links for October',
    'Open Thread 350',
  ])('rejects %j', (title) => {
    expect(isSignpost(title)).toBe(true)
  })

  it('keeps a contest entry, which is an essay in its own right', () => {
    expect(isSignpost('Your Book Review: Two Arms and a Head')).toBe(false)
  })

  it('catches a pointer promised in the subtitle', () => {
    expect(isSignpost('July', 'the best things I read this month')).toBe(true)
  })
})

describe('selectPosts', () => {
  it('drops short posts, restacks and signposts', () => {
    const { picks, rejected } = selectPosts([
      post({ wordcount: 400 }),
      post({ type: 'restack' }),
      post({ title: 'Must-Reads of 2025' }),
    ])
    expect(picks).toEqual([])
    expect(rejected).toMatchObject({ short: 1, restack: 1, signpost: 1 })
  })

  it('drops posts below the celebration floor', () => {
    const { picks, rejected } = selectPosts([post({ reaction_count: 3 })])
    expect(picks).toEqual([])
    expect(rejected.floor).toBe(1)
  })

  it('honours a per-source floor for a source held to a higher bar', () => {
    const config = { ...DEFAULT_SELECTION, floorBySource: { 'example.com': 500 } }
    expect(selectPosts([post({ reaction_count: 200 })], config).picks).toEqual([])
    expect(selectPosts([post({ reaction_count: 600 })], config).picks).toHaveLength(1)
  })

  it('caps each source, and spends the cap on its best posts', () => {
    const posts = [200, 900, 300, 700].map((reaction_count, i) =>
      post({ reaction_count, canonical_url: `https://example.com/p/${i}` }),
    )
    const { picks, rejected } = selectPosts(posts, { ...DEFAULT_SELECTION, cap: 2 })
    expect(picks.map((p) => p.engagement)).toEqual([900, 700])
    expect(rejected.capped).toBe(2)
  })

  it('caps sources independently, so one prolific source cannot crowd the rest out', () => {
    const loud = [900, 800, 700, 600].map((reaction_count, i) =>
      post({ reaction_count, source: 'loud.com', canonical_url: `https://loud.com/p/${i}` }),
    )
    const quiet = post({ reaction_count: 150, source: 'quiet.com', canonical_url: 'https://quiet.com/p/1' })
    const { picks } = selectPosts([...loud, quiet], { ...DEFAULT_SELECTION, cap: 3 })
    expect(picks.filter((p) => p.source === 'loud.com')).toHaveLength(3)
    expect(picks.filter((p) => p.source === 'quiet.com')).toHaveLength(1)
  })

  it('splits landmark from key on the twelve-month boundary', () => {
    const { picks } = selectPosts([
      post({ post_date: '2026-01-01T00:00:00.000Z', canonical_url: 'https://example.com/p/new' }),
      post({ post_date: '2025-01-01T00:00:00.000Z', canonical_url: 'https://example.com/p/old' }),
    ])
    expect(picks.map((p) => p.tier).sort()).toEqual(['key', 'landmark'])
  })

  it('ignores anything older than the window', () => {
    const { rejected } = selectPosts([post({ post_date: '2020-01-01T00:00:00.000Z' })])
    expect(rejected.window).toBe(1)
  })
})

describe('archiveUrl', () => {
  it('pages by offset and never asks for more than the server returns', () => {
    expect(archiveUrl('example.com', 50)).toBe(
      'https://example.com/api/v1/archive?sort=new&limit=50&offset=50',
    )
  })
})

describe('tagsFor / excerptFor', () => {
  const [pick] = selectPosts([post({ subtitle: 'A subtitle' })]).picks

  it('tags by tier, topic and publication', () => {
    expect(tagsFor(pick)).toEqual(['landmark', 'sociology', 'example'])
  })

  it('puts provenance in the excerpt', () => {
    expect(excerptFor(pick)).toBe('A subtitle — Example · 2026-01-01 · 3000w')
  })
})
