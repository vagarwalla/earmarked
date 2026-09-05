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

const article = (over: Partial<Article> = {}): Article => {
  // A real `Article`, not a cast-away shape. The blocks are the union the type
  // actually declares — `{ type: 'para' }`, not `{ kind: 'paragraph' }` — and
  // the base is annotated so a field that stops existing fails here rather
  // than being hashed as a key `measurementKey` will never see in production.
  const base: Article = {
    title: 'A Piece',
    sourceName: 'Somewhere',
    url: 'https://example.com/a',
    byline: null,
    publishedAt: null,
    dek: null,
    lead: null,
    blocks: [{ type: 'para', html: 'One line of prose.' }],
  }
  return Object.assign(base, over)
}

describe('measurementKey', () => {
  it('is the same for the same article under the same layout', () => {
    expect(measurementKey(article())).toBe(measurementKey(article()))
  })

  it('changes when the article gains text, because its length changes', () => {
    // Passed straight in, not cast: the parameter's `Partial<Article>`
    // contextually types `type` as the literal the block union wants, where an
    // `as Partial<Article>` on the literal widens it to `string` first and then
    // has nothing to convert to.
    const longer = article({
      blocks: [
        { type: 'para', html: 'One line of prose.' },
        { type: 'para', html: 'And another.' },
      ],
    })
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
    // Every field, inserted in the opposite order — not a hand-listed subset,
    // which is what this was: it passed only while the factory happened to
    // emit exactly the six fields the literal named, and called a dropped
    // field a reordering. Reversing keeps the content identical, so the key
    // must not move.
    const reordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(a).reverse())),
    ) as Article
    expect(measurementKey(reordered)).toBe(measurementKey(a))
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
