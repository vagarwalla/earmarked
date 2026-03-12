import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Edition } from '@/lib/types'

// ─── Mock @anthropic-ai/sdk ───────────────────────────────────────────────────

const mockCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: mockCreate }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_opts: unknown) {}
  }
  return { default: MockAnthropic }
})

// Mock EditionPicker (only the groupEditionsByCover export is needed)
vi.mock('@/components/EditionPicker', () => ({
  groupEditionsByCover: vi.fn((editions: Edition[]) => {
    // Simple mock: one group per unique cover_id, else one per isbn
    const map = new Map()
    for (const e of editions) {
      const key = e.cover_id != null ? `id:${e.cover_id}` : `no-cover:${e.isbn}`
      if (!map.has(key)) map.set(key, { key, cover_url: e.cover_url, editions: [], formats: [] })
      const g = map.get(key)
      g.editions.push(e)
      if (!g.formats.includes(e.format)) g.formats.push(e.format)
    }
    return Array.from(map.values())
  }),
}))

import { groupEditionsWithClaude, judgeGroupingWithOpus, runGroupingExperiment } from '../ai-edition-grouping'

// ─── Sample data ──────────────────────────────────────────────────────────────

const sampleEditions: Edition[] = [
  {
    isbn: '9780061935466',
    title: 'To Kill a Mockingbird',
    publisher: 'Harper Perennial',
    publish_year: 2002,
    format: 'paperback',
    cover_url: 'https://covers.openlibrary.org/b/isbn/9780061935466-M.jpg',
    cover_id: 8228691,
    edition_name: null,
    pages: 323,
    popularity_score: 45,
    ocaid: null,
  },
  {
    isbn: '9780446310789',
    title: 'To Kill a Mockingbird',
    publisher: 'Warner Books',
    publish_year: 1988,
    format: 'paperback',
    cover_url: 'https://covers.openlibrary.org/b/isbn/9780446310789-M.jpg',
    cover_id: 8228691,
    edition_name: null,
    pages: 284,
    popularity_score: 40,
    ocaid: null,
  },
  {
    isbn: '9780060935467',
    title: 'To Kill a Mockingbird',
    publisher: 'HarperCollins',
    publish_year: 1960,
    format: 'hardcover',
    cover_url: 'https://covers.openlibrary.org/b/isbn/9780060935467-M.jpg',
    cover_id: 12345678,
    edition_name: 'First Edition',
    pages: 281,
    popularity_score: 55,
    ocaid: 'tokillamockingbird00lee',
  },
]

// ─── groupEditionsWithClaude ──────────────────────────────────────────────────

describe('groupEditionsWithClaude', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns CoverGroup[] shaped correctly when AI responds with valid JSON', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify([
            {
              cover_url: 'https://covers.openlibrary.org/b/isbn/9780061935466-M.jpg',
              editions: ['9780061935466', '9780446310789'],
            },
            {
              cover_url: 'https://covers.openlibrary.org/b/isbn/9780060935467-M.jpg',
              editions: ['9780060935467'],
            },
          ]),
        },
      ],
    })

    const groups = await groupEditionsWithClaude(sampleEditions, 'test-key')

    expect(Array.isArray(groups)).toBe(true)
    expect(groups.length).toBeGreaterThanOrEqual(1)

    for (const group of groups) {
      expect(group).toHaveProperty('key')
      expect(group).toHaveProperty('cover_url')
      expect(group).toHaveProperty('editions')
      expect(group).toHaveProperty('formats')
      expect(Array.isArray(group.editions)).toBe(true)
      expect(Array.isArray(group.formats)).toBe(true)
    }
  })

  it('includes all editions across all groups (no edition dropped)', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify([
            { cover_url: null, editions: ['9780061935466', '9780446310789'] },
            { cover_url: null, editions: ['9780060935467'] },
          ]),
        },
      ],
    })

    const groups = await groupEditionsWithClaude(sampleEditions, 'test-key')
    const allIsbns = groups.flatMap((g) => g.editions.map((e) => e.isbn))

    for (const edition of sampleEditions) {
      expect(allIsbns).toContain(edition.isbn)
    }
  })

  it('returns empty array when API call fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API unavailable'))

    const groups = await groupEditionsWithClaude(sampleEditions, 'test-key')

    expect(groups).toEqual([])
  })

  it('returns empty array when AI response has no JSON array', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I cannot process this request.' }],
    })

    const groups = await groupEditionsWithClaude(sampleEditions, 'test-key')

    expect(groups).toEqual([])
  })

  it('returns empty array for empty editions input', async () => {
    const groups = await groupEditionsWithClaude([], 'test-key')

    expect(groups).toEqual([])
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

// ─── judgeGroupingWithOpus ────────────────────────────────────────────────────

describe('judgeGroupingWithOpus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const sampleGroups = [
    {
      key: 'id:8228691',
      cover_url: 'https://covers.openlibrary.org/b/isbn/9780061935466-M.jpg',
      editions: [sampleEditions[0], sampleEditions[1]],
      formats: ['paperback' as const],
    },
    {
      key: 'id:12345678',
      cover_url: 'https://covers.openlibrary.org/b/isbn/9780060935467-M.jpg',
      editions: [sampleEditions[2]],
      formats: ['hardcover' as const],
    },
  ]

  it('returns a number between 0 and 100 for a valid response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'text', text: '{"score": 85, "reasoning": "Good grouping overall."}' },
      ],
    })

    const score = await judgeGroupingWithOpus(sampleEditions, sampleGroups, 'test-key')

    expect(typeof score).toBe('number')
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(100)
    expect(score).toBe(85)
  })

  it('clamps score to 0–100 range', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"score": 120, "reasoning": "Perfect!"}' }],
    })

    const score = await judgeGroupingWithOpus(sampleEditions, sampleGroups, 'test-key')
    expect(score).toBe(100)
  })

  it('returns 0 when API call fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Timeout'))

    const score = await judgeGroupingWithOpus(sampleEditions, sampleGroups, 'test-key')

    expect(score).toBe(0)
  })

  it('returns 0 when response JSON has no score field', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"reasoning": "No score here"}' }],
    })

    const score = await judgeGroupingWithOpus(sampleEditions, sampleGroups, 'test-key')

    expect(score).toBe(0)
  })

  it('returns 0 when response has no JSON', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I am unable to score this.' }],
    })

    const score = await judgeGroupingWithOpus(sampleEditions, sampleGroups, 'test-key')

    expect(score).toBe(0)
  })
})

// ─── runGroupingExperiment ────────────────────────────────────────────────────

describe('runGroupingExperiment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns all four values with correct types', async () => {
    // First call: groupEditionsWithClaude
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify([
            { cover_url: null, editions: ['9780061935466', '9780446310789', '9780060935467'] },
          ]),
        },
      ],
    })
    // Second call: judgeGroupingWithOpus for heuristic groups
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"score": 70, "reasoning": "Decent heuristic."}' }],
    })
    // Third call: judgeGroupingWithOpus for AI groups
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"score": 85, "reasoning": "Better AI grouping."}' }],
    })

    const result = await runGroupingExperiment(sampleEditions, 'test-key')

    expect(typeof result.heuristicScore).toBe('number')
    expect(typeof result.aiScore).toBe('number')
    expect(Array.isArray(result.aiGroups)).toBe(true)
    expect(Array.isArray(result.heuristicGroups)).toBe(true)

    expect(result.heuristicScore).toBeGreaterThanOrEqual(0)
    expect(result.heuristicScore).toBeLessThanOrEqual(100)
    expect(result.aiScore).toBeGreaterThanOrEqual(0)
    expect(result.aiScore).toBeLessThanOrEqual(100)
  })
})
