/**
 * press — why an article's measured length can be trusted a second time.
 *
 * Every build re-measured every article: one Vivliostyle pass each, alone, in
 * sequence, before the pass that renders them all together. A nineteen-article
 * issue therefore launched Chromium twenty-two times to produce three PDFs,
 * and nineteen of those launches usually reproduced a number already on disk.
 *
 * The re-measuring was not paranoia. The contents page states where each piece
 * starts, so a stale count prints a magazine whose page references are wrong,
 * and that is exactly what happens the first time a stylesheet change lands —
 * every count recorded before it was measured against the previous layout.
 *
 * What was missing was a way to tell a stale count from a current one. This is
 * that: a key naming everything a measurement depended on. Same key, same
 * number of pages, and the render can be skipped; different key, and it has to
 * be measured again. So a layout change still re-measures the whole issue, and
 * a rebuild that changed nothing but the running order measures nothing at all.
 *
 * Three inputs, and the omission of any one of them is a wrong page number:
 *
 *   the stylesheet, which decides how much text fits on a page
 *   the article template, which decides what furniture sits around it
 *   the article itself, because re-extraction changes its length
 */

import { createHash } from 'node:crypto'
import { buildArticleHtml, pressCss } from './layout/render'
import type { Article } from './types'

/**
 * Bumped by hand when something outside the three inputs below changes the
 * length of a rendered article — a Vivliostyle upgrade that repaginates, a
 * change to the page box in `types.ts`. Cheap insurance: the cost of bumping
 * it needlessly is one slow build, and the cost of not bumping it when it
 * mattered is a printed contents page that lies.
 */
const MEASUREMENT_EPOCH = 1

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** The half of the key that is the same for every article in a build. */
let layoutCache: string | null = null
export function layoutKey(): string {
  if (layoutCache === null) {
    // A representative article rather than the template source: the template
    // is a function, and this is what it actually emits.
    const specimen = buildArticleHtml(
      {
        title: 'Specimen',
        sourceName: 'press',
        url: 'https://example.com/specimen',
        byline: null,
        publishedAt: null,
        blocks: [{ kind: 'paragraph', html: 'One line of prose.' }],
      } as unknown as Article,
      { issueNumber: 1, startPage: 1, measurement: true },
    )
    layoutCache = sha(`${MEASUREMENT_EPOCH}\n${pressCss()}\n${specimen}`)
  }
  return layoutCache
}

/** Only for tests, which change the stylesheet under it. */
export function __resetLayoutKey(): void {
  layoutCache = null
}

/**
 * JSON with every object's keys in a fixed order.
 *
 * `JSON.stringify` preserves insertion order, so the same article serialised
 * by two versions of the extractor can produce two different strings with no
 * difference a reader could see — and every measurement on disk would be
 * thrown away for it. Arrays keep their order, which is content: moving a
 * paragraph does change the pagination.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * The key a measurement of this article was taken under.
 *
 * Article content is hashed from the parsed object, canonically, so a
 * re-extraction that changed only key order does not throw away a measurement
 * that is still correct.
 */
export function measurementKey(article: Article): string {
  return `${layoutKey()}.${sha(canonical(article))}`
}
