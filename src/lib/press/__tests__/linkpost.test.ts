import { describe, it, expect, vi } from 'vitest'
import { parseHtml } from '../extract'
import {
  MAX_TARGETS,
  classifyLinkpost,
  collectOutboundLinks,
  fallbackTargets,
  isChrome,
  linkpostSignals,
  orderWithLinkposts,
  withLinkpostChildren,
  worthClassifying,
  type OutboundLink,
} from '../linkpost'
import type { Article, ArticleBlock } from '../types'

const SOURCE = 'https://thezvi.substack.com/p/on-writing'

function root(html: string, url = SOURCE): Element {
  const dom = parseHtml(`<div id="r">${html}</div>`, url)
  return dom.window.document.getElementById('r')!
}

function article(over: Partial<Article> = {}): Article {
  return {
    title: 'A piece',
    byline: null,
    sourceName: null,
    url: SOURCE,
    publishedAt: null,
    dek: null,
    lead: null,
    blocks: [],
    ...over,
  }
}

const para = (text: string): ArticleBlock => ({ type: 'para', html: text })

/** `words` words of filler, so density is a number rather than an accident. */
const filler = (words: number): ArticleBlock => para(Array(words).fill('word').join(' '))

function link(over: Partial<OutboundLink> = {}): OutboundLink {
  return {
    url: 'https://example.com/a',
    text: 'a real essay title',
    context: 'a real essay title',
    host: 'example.com',
    standalone: true,
    inHeading: false,
    ...over,
  }
}

describe('what counts as chrome', () => {
  it('drops navigation, sharing and subscription furniture', () => {
    expect(isChrome('https://substack.com/subscribe', 'Subscribe', 'thezvi.substack.com')).toBe(true)
    expect(isChrome('https://twitter.com/x/status/1', 'a thread', 'thezvi.substack.com')).toBe(true)
    expect(isChrome('https://other.com/p/1/comments', 'comments', 'thezvi.substack.com')).toBe(true)
    expect(isChrome('https://other.com/essay', 'here', 'thezvi.substack.com')).toBe(true)
    expect(isChrome('https://other.com/essay', '[3]', 'thezvi.substack.com')).toBe(true)
  })

  it('drops a link back into the publication being read', () => {
    expect(isChrome('https://thezvi.substack.com/p/other', 'an older post', 'thezvi.substack.com')).toBe(true)
  })

  it('keeps a pointer at another publication on the same platform', () => {
    // The bug this covers: matching substack.com by suffix made every
    // cross-Substack pointer chrome, which is most of what a roundup of
    // Substack writers points at.
    expect(isChrome('https://scottsumner.substack.com/p/virginia-woolf-on-writing', 'Virginia Woolf on writing', 'thezvi.substack.com')).toBe(false)
    expect(isChrome('https://nabeelqu.substack.com/p/what-makes-art-great', 'What makes text into great art', 'thezvi.substack.com')).toBe(false)
  })

  it('still drops the platform itself, and plumbing on a publication', () => {
    expect(isChrome('https://substack.com/home', 'Substack', 'thezvi.substack.com')).toBe(true)
    expect(isChrome('https://other.substack.com/subscribe', 'Subscribe', 'thezvi.substack.com')).toBe(true)
    expect(isChrome('https://other.substack.com/archive', 'Archive', 'thezvi.substack.com')).toBe(true)
  })

  it('keeps a pointer at somebody else with real anchor text', () => {
    expect(isChrome('https://joecarlsmith.com/on-sincerity', 'On sincerity', 'thezvi.substack.com')).toBe(false)
  })

  it('treats an unparsable href as chrome rather than throwing', () => {
    expect(isChrome('not a url', 'words', 'example.com')).toBe(true)
  })
})

describe('collecting outbound links', () => {
  it('keeps the anchor text and the sentence around it', () => {
    const links = collectOutboundLinks(
      root('<p>Worth reading: <a href="https://example.com/a">On sincerity</a>, which is about honesty.</p>'),
      SOURCE,
    )
    expect(links).toHaveLength(1)
    expect(links[0].text).toBe('On sincerity')
    expect(links[0].context).toBe('Worth reading: On sincerity, which is about honesty.')
    expect(links[0].host).toBe('example.com')
  })

  it('marks a bare pointer standalone and a passing citation not', () => {
    const links = collectOutboundLinks(
      root(
        '<ul><li><a href="https://a.test/x">On sincerity</a></li></ul>' +
          `<p>${'padding '.repeat(40)}<a href="https://b.test/y">one study</a> found otherwise.</p>`,
      ),
      SOURCE,
    )
    expect(links.find((l) => l.host === 'a.test')?.standalone).toBe(true)
    expect(links.find((l) => l.host === 'b.test')?.standalone).toBe(false)
  })

  it('notices a link that is a heading', () => {
    const links = collectOutboundLinks(root('<h2><a href="https://a.test/x">On sincerity</a></h2>'), SOURCE)
    expect(links[0].inHeading).toBe(true)
  })

  it('counts one destination once, however often it is linked', () => {
    const links = collectOutboundLinks(
      root(
        '<h2><a href="https://a.test/x">On sincerity</a></h2>' +
          '<p>More on <a href="https://a.test/x?utm_source=feed">On sincerity</a> here.</p>',
      ),
      SOURCE,
    )
    expect(links).toHaveLength(1)
  })

  it('ignores relative and non-http hrefs', () => {
    const links = collectOutboundLinks(
      root('<p><a href="/local">local</a> <a href="mailto:a@b.test">mail</a></p>'),
      SOURCE,
    )
    expect(links).toHaveLength(0)
  })
})

describe('deciding what is worth asking about', () => {
  const manyLinks = Array.from({ length: 8 }, (_, i) =>
    link({ url: `https://s${i}.test/p`, host: `s${i}.test` }),
  )

  it('reads a declaration off the page and settles the question', () => {
    const signals = linkpostSignals(
      article({ blocks: [para('This is a linkpost for https://example.com/real')] }),
      [],
    )
    expect(signals.declared).toBe('https://example.com/real')
    expect(worthClassifying(signals)).toBe(true)
  })

  it('does not ask about an essay that happens to cite things', () => {
    // Four citations spread through six thousand words is a habit, not a linkpost.
    const signals = linkpostSignals(
      article({ blocks: [filler(6000)] }),
      manyLinks.slice(0, 4).map((l) => link({ ...l, standalone: false })),
    )
    expect(signals.density).toBeLessThan(0.6)
    expect(worthClassifying(signals)).toBe(false)
  })

  it('asks about a dense list of pointers at many sites', () => {
    const signals = linkpostSignals(article({ blocks: [filler(200)] }), manyLinks)
    expect(signals.distinctHosts).toBe(8)
    expect(worthClassifying(signals)).toBe(true)
  })

  it('asks about a long piece that still points at many different places', () => {
    // Zvi's "On Writing" posts: thousands of words of commentary threaded
    // through a dozen pointers. Density, bare pointers and linked headings all
    // miss it, and the title announces nothing — but eight destinations is
    // roundup-shaped, and the model should get to say so.
    const signals = linkpostSignals(
      article({ title: 'On Writing #3', blocks: [filler(5000)] }),
      manyLinks.map((l) => link({ ...l, standalone: false, inHeading: false })),
    )
    expect(signals.titleSuggests).toBe(false)
    expect(signals.density).toBeLessThan(0.6)
    expect(signals.standalone).toBe(0)
    expect(signals.distinctHosts).toBeGreaterThanOrEqual(6)
    expect(worthClassifying(signals)).toBe(true)
  })

  it('will not call four links at one site a linkpost', () => {
    const sameHost = Array.from({ length: 6 }, () => link())
    expect(worthClassifying(linkpostSignals(article({ blocks: [filler(100)] }), sameHost))).toBe(false)
  })
})

describe('the answer with no model available', () => {
  it('keeps standalone pointers with real anchor text, one per site', () => {
    const targets = fallbackTargets([
      link({ url: 'https://a.test/1', host: 'a.test', text: 'On sincerity' }),
      link({ url: 'https://a.test/2', host: 'a.test', text: 'Another by the same person' }),
      link({ url: 'https://b.test/1', host: 'b.test', text: 'A second essay' }),
      link({ url: 'https://c.test/1', host: 'c.test', text: 'here', standalone: true }),
      link({ url: 'https://d.test/1', host: 'd.test', text: 'A third essay', standalone: false, inHeading: false }),
    ])
    expect(targets.map((t) => t.url)).toEqual(['https://a.test/1', 'https://b.test/1'])
  })

  it('honours the cap', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      link({ url: `https://s${i}.test/p`, host: `s${i}.test`, text: `essay number ${i}` }),
    )
    expect(fallbackTargets(many)).toHaveLength(MAX_TARGETS)
  })
})

describe('classifying', () => {
  const roundup = article({
    title: 'Monthly Roundup #14',
    blocks: [filler(200)],
  })
  const pointers = Array.from({ length: 8 }, (_, i) =>
    link({ url: `https://s${i}.test/p`, host: `s${i}.test`, text: `essay number ${i}` }),
  )

  it('answers a declaration without calling the model at all', async () => {
    const create = vi.fn()
    const judgement = await classifyLinkpost({
      article: article({ blocks: [para('This is a linkpost for https://example.com/real')] }),
      links: pointers,
      apiKey: 'sk-test',
      client: { messages: { create } } as never,
    })
    expect(create).not.toHaveBeenCalled()
    expect(judgement).toMatchObject({ isLinkpost: true, kind: 'pointer', decidedBy: 'declaration' })
    expect(judgement.targets).toEqual([
      { url: 'https://example.com/real', anchor: 'A piece', note: null },
    ])
  })

  it('does not call the model for an ordinary essay', async () => {
    const create = vi.fn()
    const judgement = await classifyLinkpost({
      article: article({ blocks: [filler(6000)] }),
      links: pointers.slice(0, 3),
      apiKey: 'sk-test',
      client: { messages: { create } } as never,
    })
    expect(create).not.toHaveBeenCalled()
    expect(judgement.isLinkpost).toBe(false)
  })

  it('takes the model’s selection and resolves it back to real URLs', async () => {
    const create = vi.fn().mockResolvedValue({
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            is_linkpost: true,
            kind: 'roundup',
            reason: 'a monthly links roundup',
            targets: [
              { index: 2, note: 'an essay on honesty' },
              { index: 5, note: 'a paper on forecasting' },
            ],
          }),
        },
      ],
    })

    const judgement = await classifyLinkpost({
      article: roundup,
      links: pointers,
      apiKey: 'sk-test',
      client: { messages: { create } } as never,
    })

    expect(create).toHaveBeenCalledOnce()
    expect(judgement.decidedBy).toBe('model')
    expect(judgement.targets).toEqual([
      { url: 'https://s1.test/p', anchor: 'essay number 1', note: 'an essay on honesty' },
      { url: 'https://s4.test/p', anchor: 'essay number 4', note: 'a paper on forecasting' },
    ])
  })

  it('lets the model say no', async () => {
    const create = vi.fn().mockResolvedValue({
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            is_linkpost: false,
            kind: 'roundup',
            reason: 'an essay with a lot of sources',
            targets: [],
          }),
        },
      ],
    })
    const judgement = await classifyLinkpost({
      article: roundup,
      links: pointers,
      apiKey: 'sk-test',
      client: { messages: { create } } as never,
    })
    expect(judgement.isLinkpost).toBe(false)
    expect(judgement.targets).toEqual([])
  })

  it('ignores an index the model invented', async () => {
    const create = vi.fn().mockResolvedValue({
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            is_linkpost: true,
            kind: 'roundup',
            reason: 'a roundup',
            targets: [{ index: 99, note: 'nothing' }, { index: 1, note: 'the first' }],
          }),
        },
      ],
    })
    const judgement = await classifyLinkpost({
      article: roundup,
      links: pointers,
      apiKey: 'sk-test',
      client: { messages: { create } } as never,
    })
    expect(judgement.targets.map((t) => t.url)).toEqual(['https://s0.test/p'])
  })

  it('falls back to the shape of the page when the call fails', async () => {
    const create = vi.fn().mockRejectedValue(new Error('502'))
    const judgement = await classifyLinkpost({
      article: roundup,
      links: pointers,
      apiKey: 'sk-test',
      client: { messages: { create } } as never,
    })
    expect(judgement.decidedBy).toBe('signals')
    expect(judgement.isLinkpost).toBe(true)
    expect(judgement.targets.length).toBeGreaterThan(1)
  })

  it('treats a refusal as a failure rather than as "no"', async () => {
    const create = vi.fn().mockResolvedValue({ stop_reason: 'refusal', content: [] })
    const judgement = await classifyLinkpost({
      article: roundup,
      links: pointers,
      apiKey: 'sk-test',
      client: { messages: { create } } as never,
    })
    expect(judgement.decidedBy).toBe('signals')
  })

  it('works with no API key at all', async () => {
    const judgement = await classifyLinkpost({ article: roundup, links: pointers, apiKey: null })
    expect(judgement.isLinkpost).toBe(true)
    expect(judgement.decidedBy).toBe('signals')
  })

  it('never exceeds the cap the caller asked for', async () => {
    const create = vi.fn().mockResolvedValue({
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            is_linkpost: true,
            kind: 'roundup',
            reason: 'a roundup',
            targets: pointers.map((_, i) => ({ index: i + 1, note: 'x' })),
          }),
        },
      ],
    })
    const judgement = await classifyLinkpost({
      article: roundup,
      links: pointers,
      apiKey: 'sk-test',
      maxTargets: 3,
      client: { messages: { create } } as never,
    })
    expect(judgement.targets).toHaveLength(3)
  })
})

describe('the running order', () => {
  const parents: Record<string, string | undefined> = {
    b: 'a',
    c: 'a',
    e: 'd',
  }
  const parentOf = (id: string) => parents[id]

  it('puts a linkpost’s children directly behind it', () => {
    expect(orderWithLinkposts(['b', 'x', 'a', 'c'], parentOf)).toEqual(['x', 'a', 'b', 'c'])
  })

  it('keeps the order the parent named them in', () => {
    expect(orderWithLinkposts(['a', 'c', 'b'], parentOf)).toEqual(['a', 'c', 'b'])
  })

  it('leaves a child whose parent is absent exactly where it was', () => {
    expect(orderWithLinkposts(['x', 'b', 'y'], parentOf)).toEqual(['x', 'b', 'y'])
  })

  it('handles two linkposts in one issue', () => {
    expect(orderWithLinkposts(['a', 'd', 'b', 'e', 'c'], parentOf)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('is a permutation, always', () => {
    const input = ['b', 'x', 'a', 'c', 'd', 'e', 'y']
    const out = orderWithLinkposts(input, parentOf)
    expect([...out].sort()).toEqual([...input].sort())
    expect(out).toHaveLength(input.length)
  })

  it('is idempotent', () => {
    const once = orderWithLinkposts(['b', 'x', 'a', 'c'], parentOf)
    expect(orderWithLinkposts(once, parentOf)).toEqual(once)
  })

  it('cannot be made to lose an article by a cycle', () => {
    const cyclic = (id: string) => ({ p: 'q', q: 'p' })[id]
    const out = orderWithLinkposts(['p', 'q'], cyclic)
    expect([...out].sort()).toEqual(['p', 'q'])
  })

  it('ignores an item that claims to be its own parent', () => {
    expect(orderWithLinkposts(['a', 'b'], (id) => id)).toEqual(['a', 'b'])
  })
})

describe('taking a linkpost takes what it named', () => {
  const all = [
    { id: 'a', parent: undefined },
    { id: 'b', parent: 'a' },
    { id: 'c', parent: 'a' },
    { id: 'z', parent: undefined },
  ]
  const parentOf = (i: (typeof all)[number]) => i.parent

  it('pulls the children of anything chosen', () => {
    const out = withLinkpostChildren([all[0]], all, parentOf)
    expect(out.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('adds nothing when no linkpost was chosen', () => {
    const out = withLinkpostChildren([all[3]], all, parentOf)
    expect(out.map((i) => i.id)).toEqual(['z'])
  })

  it('does not duplicate a child already chosen', () => {
    const out = withLinkpostChildren([all[0], all[1]], all, parentOf)
    expect(out.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
})
