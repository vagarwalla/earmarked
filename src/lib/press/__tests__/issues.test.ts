import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, stat, utimes } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  IssueEditError,
  applyIssueAction,
  claimedItemIds,
  ensureDraft,
  estimatePages,
  findDraft,
  readyItems,
  selectForIssue,
  type IssueAction,
  type IssueDraft,
  type PressState,
  type StateItem,
} from '../issues'

function item(over: Partial<StateItem> = {}): StateItem {
  return {
    id: 'a',
    url: 'https://example.com/a',
    raindropId: '1',
    title: 'A piece',
    state: 'laid_out',
    pageCount: 10,
    savedAt: '2026-08-01T00:00:00Z',
    ...over,
  }
}

function state(over: Partial<PressState> = {}): PressState {
  return { issueNumber: 1, items: [], seen: [], printed: [], ...over }
}

// ── Selection ────────────────────────────────────────────────────────────────

describe('selectForIssue', () => {
  const backlog = state({
    items: [
      item({ id: 'c', savedAt: '2026-08-03T00:00:00Z', pageCount: 40 }),
      item({ id: 'a', savedAt: '2026-08-01T00:00:00Z', pageCount: 40 }),
      item({ id: 'b', savedAt: '2026-08-02T00:00:00Z', pageCount: 40 }),
      item({ id: 'd', savedAt: '2026-08-04T00:00:00Z', pageCount: 40 }),
    ],
  })

  it('takes the oldest saves first', () => {
    expect(selectForIssue(backlog, 100).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('includes the article that crosses the threshold rather than stopping short', () => {
    // 40 + 40 = 80 is under 100; the third takes it to 120 and is kept, since
    // a 120-page issue prints and an 80-page one is below what was asked for.
    expect(selectForIssue(backlog, 100)).toHaveLength(3)
  })

  it('leaves the remainder for the next issue', () => {
    const chosen = selectForIssue(backlog, 100).map((i) => i.id)
    expect(chosen).not.toContain('d')
  })

  it('only considers articles that extracted and were measured', () => {
    const mixed = state({
      items: [
        item({ id: 'ok' }),
        item({ id: 'queued', state: 'queued' }),
        item({ id: 'skipped', state: 'skipped' }),
        item({ id: 'failed', state: 'failed' }),
        item({ id: 'printed', state: 'printed' }),
      ],
    })
    expect(readyItems(mixed).map((i) => i.id)).toEqual(['ok'])
    expect(selectForIssue(mixed, 100).map((i) => i.id)).toEqual(['ok'])
  })
})

// ── Drafts ───────────────────────────────────────────────────────────────────

describe('ensureDraft', () => {
  it('creates a draft from the fallback selection', () => {
    const s = state()
    const draft = ensureDraft(s, 1, ['a', 'b'])
    expect(draft).toEqual({ number: 1, itemIds: ['a', 'b'], state: 'draft' })
    expect(s.issues).toEqual([draft])
  })

  it('never overwrites an existing draft with the default selection', () => {
    const s = state({ issues: [{ number: 1, itemIds: ['b', 'a'], state: 'draft' }] })
    expect(ensureDraft(s, 1, ['a', 'b', 'c']).itemIds).toEqual(['b', 'a'])
  })

  it('copies the fallback rather than aliasing it', () => {
    const fallback = ['a']
    const draft = ensureDraft(state(), 1, fallback)
    fallback.push('b')
    expect(draft.itemIds).toEqual(['a'])
  })

  it('keeps issues in number order', () => {
    const s = state()
    ensureDraft(s, 3, [])
    ensureDraft(s, 1, [])
    ensureDraft(s, 2, [])
    expect(s.issues?.map((i) => i.number)).toEqual([1, 2, 3])
  })
})

describe('claimedItemIds', () => {
  const s = state({
    issues: [
      { number: 1, itemIds: ['a'], state: 'ordered' },
      { number: 2, itemIds: ['b'], state: 'draft' },
    ],
    printed: [{ number: 1, name: 'One', orderedAt: '2026-08-01T00:00:00Z', itemIds: ['a', 'z'] }],
  })

  it('counts drafted and printed issues alike', () => {
    expect([...claimedItemIds(s)].sort()).toEqual(['a', 'b', 'z'])
  })

  it('excludes the issue being edited, so its own articles are not "taken"', () => {
    expect([...claimedItemIds(s, 2)].sort()).toEqual(['a', 'z'])
  })
})

// ── Editing ──────────────────────────────────────────────────────────────────

describe('applyIssueAction', () => {
  function fixture(): { s: PressState; draft: IssueDraft } {
    const s = state({
      items: [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })],
      issues: [{ number: 1, itemIds: ['a', 'b'], state: 'draft' }],
    })
    return { s, draft: findDraft(s, 1)! }
  }

  it('reorders to exactly the order given', () => {
    const { s, draft } = fixture()
    applyIssueAction(s, draft, { action: 'reorder', itemIds: ['b', 'a'] })
    expect(draft.itemIds).toEqual(['b', 'a'])
  })

  it('refuses a reorder that adds or drops an article', () => {
    const { s, draft } = fixture()
    // A stale page reordering a list it no longer has would otherwise delete
    // whatever it did not know about.
    expect(() => applyIssueAction(s, draft, { action: 'reorder', itemIds: ['a'] })).toThrow(
      IssueEditError,
    )
    expect(() => applyIssueAction(s, draft, { action: 'reorder', itemIds: ['a', 'b', 'c'] })).toThrow(
      IssueEditError,
    )
    expect(draft.itemIds).toEqual(['a', 'b'])
  })

  it('removes an article and leaves the rest in order', () => {
    const { s, draft } = fixture()
    applyIssueAction(s, draft, { action: 'remove', itemId: 'a' })
    expect(draft.itemIds).toEqual(['b'])
  })

  it('refuses to remove something that is not in the issue', () => {
    const { s, draft } = fixture()
    expect(() => applyIssueAction(s, draft, { action: 'remove', itemId: 'c' })).toThrow(IssueEditError)
  })

  it('adds a waiting article to the end', () => {
    const { s, draft } = fixture()
    applyIssueAction(s, draft, { action: 'add', itemId: 'c' })
    expect(draft.itemIds).toEqual(['a', 'b', 'c'])
  })

  it('is a no-op when the article is already in the issue', () => {
    const { s, draft } = fixture()
    applyIssueAction(s, draft, { action: 'add', itemId: 'a' })
    expect(draft.itemIds).toEqual(['a', 'b'])
  })

  it('refuses an article that was skipped as a reference page', () => {
    const { s, draft } = fixture()
    s.items.push(item({ id: 'about', state: 'skipped', reason: 'reference page, not an article' }))
    expect(() => applyIssueAction(s, draft, { action: 'add', itemId: 'about' })).toThrow(
      /skipped, not waiting/,
    )
  })

  it('refuses an article whose extraction failed', () => {
    const { s, draft } = fixture()
    s.items.push(item({ id: 'broken', state: 'failed' }))
    expect(() => applyIssueAction(s, draft, { action: 'add', itemId: 'broken' })).toThrow(
      IssueEditError,
    )
  })

  it('refuses an article that belongs to another issue', () => {
    const { s, draft } = fixture()
    s.issues!.push({ number: 2, itemIds: ['c'], state: 'draft' })
    expect(() => applyIssueAction(s, draft, { action: 'add', itemId: 'c' })).toThrow(
      /another issue/,
    )
  })

  it('refuses an unknown article', () => {
    const { s, draft } = fixture()
    expect(() => applyIssueAction(s, draft, { action: 'add', itemId: 'nope' })).toThrow(IssueEditError)
  })

  it('refuses every edit to an issue that has been printed', () => {
    const { s, draft } = fixture()
    draft.state = 'ordered'
    const edits: IssueAction[] = [
      { action: 'reorder', itemIds: ['b', 'a'] },
      { action: 'remove', itemId: 'a' },
      { action: 'add', itemId: 'c' },
    ]
    for (const edit of edits) {
      expect(() => applyIssueAction(s, draft, edit)).toThrow(/has been printed/)
    }
    expect(draft.itemIds).toEqual(['a', 'b'])
  })
})

// ── Linkposts ────────────────────────────────────────────────────────────────

describe('linkposts in an issue', () => {
  /** A roundup, the two pieces it named, and an unrelated article. */
  const pool = () =>
    state({
      items: [
        item({ id: 'zvi', savedAt: '2026-08-01T00:00:00Z', pageCount: 6, isLinkpost: true }),
        item({ id: 'k1', savedAt: '2026-08-01T00:00:00Z', pageCount: 20, linkpostParentId: 'zvi' }),
        item({ id: 'k2', savedAt: '2026-08-01T00:00:00Z', pageCount: 20, linkpostParentId: 'zvi' }),
        item({ id: 'solo', savedAt: '2026-08-02T00:00:00Z', pageCount: 10 }),
      ],
    })

  const draft = (itemIds: string[]): IssueDraft => ({ number: 1, itemIds, state: 'draft' })

  it('selects a roundup together with the pieces it named', () => {
    // The threshold falls inside the group; taking half of it would print an
    // opener promising two pieces that are not there.
    const chosen = selectForIssue(pool(), 10).map((i) => i.id)
    expect(chosen).toContain('zvi')
    expect(chosen).toContain('k1')
    expect(chosen).toContain('k2')
  })

  it('prints them directly behind their linkpost', () => {
    expect(selectForIssue(pool(), 200).map((i) => i.id)).toEqual(['zvi', 'k1', 'k2', 'solo'])
  })

  it('adding a linkpost adds what it named', () => {
    const s = pool()
    const d = applyIssueAction(s, draft([]), { action: 'add', itemId: 'zvi' })
    expect(d.itemIds).toEqual(['zvi', 'k1', 'k2'])
  })

  it('adding one of the named pieces brings its linkpost with it', () => {
    const s = pool()
    const d = applyIssueAction(s, draft([]), { action: 'add', itemId: 'k1' })
    // Without the roundup, "Linkpost of Monthly Roundup" points at nothing.
    expect(d.itemIds).toContain('zvi')
    expect(d.itemIds).toContain('k1')
    expect(d.itemIds.indexOf('zvi')).toBeLessThan(d.itemIds.indexOf('k1'))
  })

  it('refuses a named piece when its linkpost belongs to another issue', () => {
    const s = pool()
    s.issues = [{ number: 2, itemIds: ['zvi'], state: 'draft' }]
    expect(() => applyIssueAction(s, draft([]), { action: 'add', itemId: 'k1' })).toThrow(
      IssueEditError,
    )
  })

  it('removing a linkpost removes what it brought in', () => {
    const s = pool()
    const d = applyIssueAction(s, draft(['zvi', 'k1', 'k2', 'solo']), {
      action: 'remove',
      itemId: 'zvi',
    })
    expect(d.itemIds).toEqual(['solo'])
  })

  it('removing one named piece leaves the rest of the group alone', () => {
    const s = pool()
    const d = applyIssueAction(s, draft(['zvi', 'k1', 'k2']), { action: 'remove', itemId: 'k1' })
    expect(d.itemIds).toEqual(['zvi', 'k2'])
  })

  it('pulls a dragged-away piece back behind its linkpost', () => {
    const s = pool()
    const d = applyIssueAction(s, draft(['zvi', 'k1', 'k2', 'solo']), {
      action: 'reorder',
      itemIds: ['k1', 'solo', 'zvi', 'k2'],
    })
    expect(d.itemIds).toEqual(['solo', 'zvi', 'k1', 'k2'])
  })

  it('still refuses a reorder that changes the membership', () => {
    const s = pool()
    expect(() =>
      applyIssueAction(s, draft(['zvi', 'k1']), { action: 'reorder', itemIds: ['zvi'] }),
    ).toThrow(IssueEditError)
  })

  it('leaves an issue with no linkposts in it exactly as it was', () => {
    const s = state({ items: [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })] })
    const d = applyIssueAction(s, draft(['a', 'b', 'c']), {
      action: 'reorder',
      itemIds: ['c', 'a', 'b'],
    })
    expect(d.itemIds).toEqual(['c', 'a', 'b'])
  })
})

describe('estimatePages', () => {
  const s = state({
    items: [item({ id: 'a', pageCount: 12 }), item({ id: 'b', pageCount: 30 }), item({ id: 'c' })],
  })

  it('sums the measured pages of the articles named', () => {
    expect(estimatePages(s, ['a', 'b'])).toBe(42)
  })

  it('counts an unmeasured or unknown article as nothing rather than guessing', () => {
    expect(estimatePages(s, ['a', 'ghost'])).toBe(12)
  })
})

// ── The state lock ───────────────────────────────────────────────────────────

/**
 * `PRESS_ROOT` is fixed at import time from the working directory, so these
 * load a second copy of the module against a temp directory. Nothing here may
 * touch the real `.press/`.
 */
async function inTempRoot(): Promise<{
  dir: string
  mod: typeof import('../issues')
  cleanup: () => Promise<void>
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'press-issues-'))
  const spy = vi.spyOn(process, 'cwd').mockReturnValue(dir)
  vi.resetModules()
  const mod = await import('../issues')
  return {
    dir,
    mod,
    cleanup: async () => {
      spy.mockRestore()
      vi.resetModules()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

describe('withStateLock', () => {
  let cleanup: (() => Promise<void>) | null = null
  afterEach(async () => {
    await cleanup?.()
    cleanup = null
  })

  it('creates a state file when there is none', async () => {
    const t = await inTempRoot()
    cleanup = t.cleanup
    await t.mod.withStateLock((s) => {
      s.items.push(item())
    })
    const written = JSON.parse(await readFile(path.join(t.dir, '.press', 'state.json'), 'utf8'))
    expect(written.items).toHaveLength(1)
    expect(written.issueNumber).toBe(1)
  })

  it('serialises concurrent writers, so neither loses the other edit', async () => {
    const t = await inTempRoot()
    cleanup = t.cleanup

    // Without the lock these interleave: both read the same state, and
    // whichever writes last silently discards the other's article.
    await Promise.all([
      t.mod.withStateLock(async (s) => {
        await new Promise((r) => setTimeout(r, 10))
        s.items.push(item({ id: 'from-runner' }))
      }),
      t.mod.withStateLock(async (s) => {
        await new Promise((r) => setTimeout(r, 10))
        s.items.push(item({ id: 'from-editor' }))
      }),
    ])

    const written = JSON.parse(await readFile(path.join(t.dir, '.press', 'state.json'), 'utf8'))
    expect(written.items.map((i: StateItem) => i.id).sort()).toEqual(['from-editor', 'from-runner'])
  })

  it('releases the lock when the callback throws', async () => {
    const t = await inTempRoot()
    cleanup = t.cleanup

    await expect(
      t.mod.withStateLock(() => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // The next writer must not be wedged behind a lock nobody holds.
    await t.mod.withStateLock((s) => {
      s.seen.push('after')
    })
    expect((await t.mod.readState())?.seen).toEqual(['after'])
  })

  it('breaks a lock left behind by a process that died', async () => {
    const t = await inTempRoot()
    cleanup = t.cleanup
    await t.mod.withStateLock(() => {})

    const lock = path.join(t.dir, '.press', 'state.lock')
    await writeFile(lock, '99999 stale\n')
    const old = new Date(Date.now() - 60_000)
    await utimes(lock, old, old)

    await t.mod.withStateLock((s) => {
      s.seen.push('recovered')
    })
    expect((await t.mod.readState())?.seen).toEqual(['recovered'])
  })

  it('leaves no lock or scratch file behind', async () => {
    const t = await inTempRoot()
    cleanup = t.cleanup
    await t.mod.withStateLock((s) => {
      s.seen.push('x')
    })
    await expect(stat(path.join(t.dir, '.press', 'state.lock'))).rejects.toThrow()
  })

  it('carries an existing state file forward, including its drafts', async () => {
    const t = await inTempRoot()
    cleanup = t.cleanup
    await t.mod.withStateLock((s) => {
      s.items.push(item({ id: 'a' }))
      t.mod.ensureDraft(s, 1, ['a'])
    })
    await t.mod.withStateLock((s) => {
      s.seen.push('second pass')
    })

    const after = await t.mod.readState()
    expect(after?.issues).toEqual([{ number: 1, itemIds: ['a'], state: 'draft' }])
    expect(after?.items).toHaveLength(1)
  })
})
