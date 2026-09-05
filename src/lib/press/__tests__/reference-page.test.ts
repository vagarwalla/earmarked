/**
 * The second of the two invariants press must not break: a page that is not
 * an article — an About page, a docs index, a product landing page — must
 * never be selected into a printed issue.
 *
 * Three things have to hold for that, and each is tested here:
 *
 *   1. the rule recognises a reference page from its title;
 *   2. it does *not* fire on an essay whose title merely starts with one of
 *      those words, which would silently lose reading;
 *   3. an item the rule excluded cannot be selected into an issue afterwards,
 *      by the automatic selection or by hand.
 *
 * (1) and (2) are the rule. (3) is what makes it an invariant rather than a
 * suggestion — the rule marks an item `skipped`, and it is `skipped` that has
 * to be unselectable.
 */

import { describe, it, expect } from 'vitest'
import { isReferencePage, REFERENCE_PAGE_REASON } from '../reference-page'
import {
  IssueEditError,
  applyIssueAction,
  readyItems,
  selectForIssue,
  type IssueDraft,
  type PressState,
  type StateItem,
} from '../issues'

function item(over: Partial<StateItem> = {}): StateItem {
  const base: StateItem = {
    id: 'a',
    url: 'https://example.com/a',
    raindropId: '1',
    title: 'A piece',
    state: 'laid_out',
    pageCount: 10,
    savedAt: '2026-08-01T00:00:00Z',
  }
  return Object.assign(base, over)
}

function state(over: Partial<PressState> = {}): PressState {
  const base: PressState = { issueNumber: 1, items: [], seen: [], printed: [] }
  return Object.assign(base, over)
}

describe('recognising a page that is not an article', () => {
  it('catches the titles a site puts on its furniture', () => {
    for (const title of [
      'About',
      'About us',
      'ABOUT US',
      'Home',
      'Index',
      'Untitled',
      'Overview',
      'Team',
      'Our team',
      'Contact',
      'Contact us',
      'Careers',
      'Career',
      'Jobs',
      'FAQ',
      'Doc',
      'Docs',
      'Documentation',
      'Mission',
      'Welcome',
      'Getting started',
      'Resources',
    ]) {
      expect(isReferencePage(title), title).toBe(true)
    }
  })

  it('ignores surrounding whitespace, which extraction leaves behind', () => {
    expect(isReferencePage('  About  \n')).toBe(true)
  })

  it('says nothing about an item with no title yet', () => {
    expect(isReferencePage(null)).toBe(false)
    expect(isReferencePage('')).toBe(false)
    expect(isReferencePage(undefined)).toBe(false)
  })

  /**
   * The expensive direction. A false positive here is an essay that silently
   * never reaches an issue, which nobody would think to go looking for — so
   * the rule only fires when the whole title is the generic noun.
   */
  it('leaves an essay alone when a generic word merely appears in its title', () => {
    for (const title of [
      'About a Boy',
      'On Careers',
      'The Home Front',
      'Welcome to the Machine',
      'What I Learned About Mission Creep',
      'Index Funds and the Death of Price Discovery',
      'Getting started is the hardest part',
      'Our team shipped a compiler',
      'Resources for the Coming Famine',
      'The FAQ Nobody Wrote',
    ]) {
      expect(isReferencePage(title), title).toBe(false)
    }
  })
})

describe('a reference page cannot reach an issue', () => {
  /** What `press-run` writes when the rule fires. */
  const skipped = () =>
    item({
      id: 'about',
      title: 'About',
      state: 'skipped',
      reason: REFERENCE_PAGE_REASON,
    })

  it('is not among the articles waiting to be printed', () => {
    const s = state({ items: [item({ id: 'essay' }), skipped()] })
    expect(readyItems(s).map((i) => i.id)).toEqual(['essay'])
  })

  it('is never picked up by the automatic selection', () => {
    const s = state({ items: [skipped(), item({ id: 'essay' })] })
    expect(selectForIssue(s, 1000).map((i) => i.id)).toEqual(['essay'])
  })

  it('cannot be added to an issue by hand either', () => {
    const s = state({ items: [item({ id: 'essay' }), skipped()] })
    const draft: IssueDraft = { number: 1, itemIds: ['essay'], state: 'draft' }
    expect(() => applyIssueAction(s, draft, { action: 'add', itemId: 'about' })).toThrow(
      IssueEditError,
    )
    expect(draft.itemIds).toEqual(['essay'])
  })

  it('comes back to the pool once it is un-skipped, and only then', () => {
    // The call is the reader's: un-skipping is supported, and is the only way
    // in. Modelled here as the state change the workbench's unskip performs.
    const s = state({ items: [skipped()] })
    expect(selectForIssue(s, 1000)).toHaveLength(0)
    s.items[0].state = 'laid_out'
    expect(selectForIssue(s, 1000).map((i) => i.id)).toEqual(['about'])
  })
})
