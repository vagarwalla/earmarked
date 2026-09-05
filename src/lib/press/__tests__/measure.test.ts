/**
 * press — the key that decides whether a measured page count can be reused.
 *
 * The stake is the contents page: reuse a count the stylesheet has since
 * invalidated and the printed magazine says an article starts on a page it
 * does not start on. So these tests are about what must *change* the key, not
 * about the key's shape.
 */

import { describe, it, expect } from 'vitest'
import { measurementKey, layoutKey } from '../measure'
import type { Article } from '../types'

const article = (over: Partial<Article> = {}): Article =>
  ({
    title: 'A Piece',
    sourceName: 'Somewhere',
    url: 'https://example.com/a',
    byline: null,
    publishedAt: null,
    blocks: [{ kind: 'paragraph', html: 'One line of prose.' }],
    ...over,
  }) as unknown as Article

describe('measurementKey', () => {
  it('is the same for the same article under the same layout', () => {
    expect(measurementKey(article())).toBe(measurementKey(article()))
  })

  it('changes when the article gains text, because its length changes', () => {
    const longer = article({
      blocks: [
        { kind: 'paragraph', html: 'One line of prose.' },
        { kind: 'paragraph', html: 'And another.' },
      ],
    } as Partial<Article>)
    expect(measurementKey(longer)).not.toBe(measurementKey(article()))
  })

  it('changes when a re-extraction rewrites the title', () => {
    expect(measurementKey(article({ title: 'A Piece, Retitled' }))).not.toBe(
      measurementKey(article()),
    )
  })

  /**
   * Key ordering is not a change to the article, and a JSON round trip is
   * allowed to reorder. Whitespace likewise: this is hashed from the parsed
   * object, so neither throws away a measurement that is still correct.
   */
  it('survives a JSON round trip that reorders the same content', () => {
    const a = article()
    const reordered = JSON.parse(JSON.stringify({ blocks: a.blocks, url: a.url, title: a.title, sourceName: a.sourceName, byline: a.byline, publishedAt: a.publishedAt }))
    expect(measurementKey(reordered as Article)).toBe(measurementKey(a))
  })

  it('carries the layout half, so every article moves together when it does', () => {
    expect(measurementKey(article()).startsWith(`${layoutKey()}.`)).toBe(true)
    // Two different articles share the layout half and differ in the other.
    const [layoutA, contentA] = measurementKey(article()).split('.')
    const [layoutB, contentB] = measurementKey(article({ title: 'Other' })).split('.')
    expect(layoutA).toBe(layoutB)
    expect(contentA).not.toBe(contentB)
  })
})
