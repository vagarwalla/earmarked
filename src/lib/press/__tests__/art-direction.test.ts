/**
 * press — the cover brief.
 *
 * These are about the rules holding, not about taste: that a cover uses two
 * colours rather than six, that the grounds can actually be told apart, and
 * that nothing here can stop an issue being printed.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  FIGURES,
  GROUNDS,
  INKS,
  groundFor,
  SCHEMES,
  chooseCover,
  coverBriefPrompt,
  fallbackBrief,
  parseCoverBrief,
  rampFor,
  contentsKey,
  briefFromStored,
} from '../art-direction'
import { buildCoverHtml } from '../compose'

const toc = [
  { title: 'Making Sense of the Lysenko Affair', page: 2 },
  { title: 'The Secret of the Soviet Hydrogen Bomb', page: 14 },
]

describe('the palette', () => {
  it('draws a cover in at most two inks — the rainbow was the complaint', () => {
    for (const scheme of SCHEMES) {
      expect(scheme.inks.length).toBeLessThanOrEqual(2)
      const ramp = rampFor(scheme)
      const hues = new Set(ramp.filter((c) => Object.values(INKS).includes(c as never)))
      expect(hues.size).toBeLessThanOrEqual(2)
    }
  })

  /**
   * Six tones of two hues, not six hues — and not two hues padded with the
   * flat ground either, which read as holes punched in the picture. Every
   * tone has to sit between the two inks, the ground and the shade.
   */
  it('builds six distinct tones without introducing a third hue', () => {
    const ramp = rampFor(SCHEMES[0], 6)
    expect(new Set(ramp).size).toBe(6)

    const hue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      if (max === min) return null
      const d = max - min
      const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
      return (h * 60 + 360) % 360
    }
    // Every scheme, not just the first: a third hue anywhere is the bug.
    const apart = (x: number, y: number) => {
      const d = Math.abs(x - y) % 360
      return d > 180 ? 360 - d : d
    }
    for (const scheme of SCHEMES) {
      const inkHues = scheme.inks.map((i) => hue(INKS[i])!)
      for (const c of rampFor(scheme)) {
        const h = hue(c)
        if (h === null) continue // a neutral tone belongs to no hue
        expect(Math.min(...inkHues.map((ih) => apart(h, ih)))).toBeLessThanOrEqual(90)
      }
    }
  })

  /**
   * A shelf of same-scheme issues must not be a shelf of identical covers.
   * Several of these issues are about systems and correctly choose the same
   * scheme; the ground is what keeps them apart when stacked.
   */
  it('offers all of a scheme\'s grounds, and cycles through them by number', () => {
    for (const scheme of SCHEMES) {
      const seen = new Set(scheme.grounds.map((_, n) => groundFor(scheme, n)))
      expect(seen.size).toBe(scheme.grounds.length)
    }
  })

  /**
   * The point of hashing the name rather than the number: four issues about
   * systems all choose `cold`, and `issueNumber % grounds.length` sent 1 and 4
   * — and 5 and 8 — to the same paper, so the shelf came out in matched pairs.
   */
  it('spreads real issue names across the grounds instead of pairing them', () => {
    const cold = SCHEMES.find((s) => s.name === 'cold')!
    const names = ['Effective Uncertainty', 'Hard to Count', 'Soviet Systems and Failures', 'The Record of Trying']
    const seen = new Set(names.map((n) => groundFor(cold, n)))
    expect(seen.size).toBeGreaterThanOrEqual(3)
  })

  it('always gives one issue the same ground, so a rebuild never moves a cover', () => {
    const s = SCHEMES[0]
    expect(groundFor(s, 'Hard to Count')).toBe(groundFor(s, 'Hard to Count'))
  })

  it('offers every scheme more than one ground to print on', () => {
    for (const scheme of SCHEMES) expect(scheme.grounds.length).toBeGreaterThan(1)
  })

  /**
   * The previous grounds were four percent of colour and every cover read as
   * cream: the difference existed in the file and not on the shelf. Each must
   * now be visibly distinct from the plain paper.
   */
  it('has grounds that can actually be told apart from cream', () => {
    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    const plain = rgb(GROUNDS.plain)
    for (const [name, hex] of Object.entries(GROUNDS)) {
      if (name === 'plain') continue
      const d = rgb(hex).reduce((n, v, i) => n + Math.abs(v - plain[i]), 0)
      expect(d).toBeGreaterThan(24)
    }
  })

  it('keeps every ground light enough to carry the ink', () => {
    for (const hex of Object.values(GROUNDS)) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
      expect(0.299 * r + 0.587 * g + 0.114 * b).toBeGreaterThan(0xd0)
    }
  })
})

describe('coverBriefPrompt', () => {
  it('offers every scheme and figure by name, with what it is for', () => {
    const prompt = coverBriefPrompt('The Planned Century', toc)
    for (const s of SCHEMES) expect(prompt).toContain(`${s.name}: ${s.suits}`)
    for (const f of FIGURES) expect(prompt).toContain(`${f.name}: ${f.suits}`)
    expect(prompt).toContain('Making Sense of the Lysenko Affair')
  })
})

describe('parseCoverBrief', () => {
  it('reads the two words back', () => {
    expect(parseCoverBrief('cold nested')).toEqual({
      scheme: SCHEMES.find((s) => s.name === 'cold'),
      figure: FIGURES.find((f) => f.name === 'nested'),
    })
  })

  it('tolerates a model that would not stop talking', () => {
    expect(parseCoverBrief('I would go with "archive stack" for this one.')?.scheme.name).toBe('archive')
  })

  it('refuses an answer that names only one of the two', () => {
    expect(parseCoverBrief('cold')).toBeNull()
    expect(parseCoverBrief('something else entirely')).toBeNull()
  })
})

describe('chooseCover', () => {
  it('asks the model and uses what it says', async () => {
    const client = {
      messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: 'cold nested' }] })) },
    }
    const brief = await chooseCover({
      issueNumber: 5, issueName: 'The Planned Century', toc, apiKey: 'k', client: client as never,
    })
    expect(brief.scheme.name).toBe('cold')
    expect(brief.figure.name).toBe('nested')
  })

  /**
   * A cover nobody could choose is still a cover. None of these may be the
   * reason an issue cannot be printed.
   */
  it('falls back rather than failing, on every way this can go wrong', async () => {
    const rotation = fallbackBrief(5)
    expect(await chooseCover({ issueNumber: 5, issueName: 'x', toc, apiKey: null })).toEqual(rotation)
    expect(await chooseCover({ issueNumber: 5, issueName: 'x', toc: [], apiKey: 'k' })).toEqual(rotation)

    const angry = { messages: { create: vi.fn(async () => { throw new Error('no network') }) } }
    expect(
      await chooseCover({ issueNumber: 5, issueName: 'x', toc, apiKey: 'k', client: angry as never }),
    ).toEqual(rotation)

    const rambling = {
      messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: 'hmm, tricky' }] })) },
    }
    expect(
      await chooseCover({ issueNumber: 5, issueName: 'x', toc, apiKey: 'k', client: rambling as never }),
    ).toEqual(rotation)
  })

  /**
   * The model does not answer identically every time, so without this a
   * rebuild to fix a typo would quietly restyle the magazine — and "always
   * lock what you rebuild" would mean "redesign it every time you lock it".
   */
  it('keeps the cover an issue already has, without asking again', async () => {
    const client = { messages: { create: vi.fn() } }
    const previous = { scheme: 'field', figure: 'horizon', of: contentsKey(toc) }
    const brief = await chooseCover({
      issueNumber: 5, issueName: 'x', toc, apiKey: 'k', previous, client: client as never,
    })
    expect(brief.scheme.name).toBe('field')
    expect(brief.figure.name).toBe('horizon')
    expect(client.messages.create).not.toHaveBeenCalled()
  })

  it('looks again when the contents have changed', async () => {
    const client = {
      messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: 'ember lens' }] })) },
    }
    const previous = { scheme: 'field', figure: 'horizon', of: 'something-else' }
    const brief = await chooseCover({
      issueNumber: 5, issueName: 'x', toc, apiKey: 'k', previous, client: client as never,
    })
    expect(brief.scheme.name).toBe('ember')
    expect(client.messages.create).toHaveBeenCalled()
  })

  it('keeps the old cover rather than the rotation when it cannot ask', async () => {
    const previous = { scheme: 'field', figure: 'horizon', of: 'stale' }
    const brief = await chooseCover({ issueNumber: 5, issueName: 'x', toc, apiKey: null, previous })
    expect(brief.scheme.name).toBe('field')
  })

  it('ignores a stored brief naming something that no longer exists', () => {
    expect(briefFromStored({ scheme: 'retired', figure: 'horizon', of: 'x' })).toBeNull()
    expect(briefFromStored(null)).toBeNull()
  })

  it('varies the fallback, so a press with no key still gets a shelf', () => {
    const seen = new Set([1, 2, 3, 4, 5, 6, 7].map((n) => {
      const b = fallbackBrief(n)
      return `${b.scheme.name}/${b.figure.name}`
    }))
    expect(seen.size).toBeGreaterThan(5)
  })
})

describe('buildCoverHtml with a brief', () => {
  it('prints the chosen ground and composition, and only the chosen inks', () => {
    const brief = { scheme: SCHEMES.find((s) => s.name === 'cold')!, figure: FIGURES.find((f) => f.name === 'nested')! }
    const html = buildCoverHtml({
      brief, issueName: 'The Planned Century', issueNumber: 5, pageCount: 154, dateRange: 'Sep 2026', toc,
    })
    expect(html).toContain(`--bg: ${groundFor(brief.scheme, 'The Planned Century')}`)
    expect(html).toContain('data-art="nested"')
    // The back band reprises this cover's inks, not the whole palette.
    expect(html).toContain(INKS.ultramarine)
    expect(html).not.toContain(INKS.marigold)
  })
})
