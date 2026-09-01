'use client'

/**
 * press — the pool.
 *
 * Every article that has been extracted and measured and that no issue has
 * claimed. This is the source of truth the whole workbench turns on: issues
 * are arrangements of it, removing an article from one returns it here, and
 * the `×` on a row is the only permanent delete in the product.
 *
 * The chips filter to the piles that are *not* the pool — a broken extraction,
 * a reference page set aside, what has been discarded — and each carries the
 * one action that gets an article back, because un-skipping used to mean
 * hand-editing JSON. No chip is the pool itself: the panel already is the
 * pool, and naming it twice made two labels and two identical counts for one
 * list.
 *
 * See docs/plans/2026-08-31-003-feat-press-workbench-plan.md §2, §4.
 */

import { useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { RotateCcw, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { readJson } from './readJson'
import { ArticleRow } from './ArticleRow'
import type { PoolItem } from './Workbench'

/** The exceptions. `null` is the pool, which is the panel's default state. */
type Pile = 'failed' | 'skipped' | 'dropped'

export function PoolPanel({
  pool,
  failed,
  skipped,
  dropped,
  editable,
  onError,
  onNote,
  onRefresh,
}: {
  pool: PoolItem[]
  failed: PoolItem[]
  skipped: PoolItem[]
  dropped: PoolItem[]
  editable: boolean
  onError: (m: string | null) => void
  onNote: (m: string | null) => void
  onRefresh: () => void
}) {
  const [pile, setPile] = useState<Pile | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<PoolItem | null>(null)
  const { setNodeRef, isOver } = useDroppable({ id: 'pool' })

  const piles: Record<Pile, PoolItem[]> = { failed, skipped, dropped }
  const items = (pile ? piles[pile] : pool).filter((i) =>
    query.trim() ? `${i.title} ${i.url ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()) : true,
  )

  const act = async (item: PoolItem, action: 'retry' | 'unskip') => {
    setBusy(item.id)
    onError(null)
    try {
      const res = await fetch(`/api/press/item/${item.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const body = await readJson(res)
      if (!res.ok) onError(body.error ?? 'That did not work.')
      else {
        onNote(action === 'retry' ? 'Queued for another go.' : 'Back in the pool.')
        onRefresh()
      }
    } finally {
      setBusy(null)
    }
  }

  /**
   * The delete. A confirm rather than an undo toast: the raindrop survives in
   * `Not printing` either way, so the dialog is not the only thing standing
   * between a mis-click and a loss — it is the thing that makes the mis-click
   * unlikely.
   */
  const destroy = async (item: PoolItem) => {
    setBusy(item.id)
    onError(null)
    try {
      const res = await fetch(`/api/press/item/${item.id}`, { method: 'DELETE' })
      const body = await readJson<{ warning: string | null }>(res)
      if (!res.ok) onError(body.error ?? 'Could not delete it.')
      else {
        onNote(body.warning ?? 'Deleted. The raindrop is in “Not printing”.')
        onRefresh()
      }
    } finally {
      setBusy(null)
      setConfirming(null)
    }
  }

  return (
    <div ref={setNodeRef}>
      <div className="mb-2 flex flex-wrap gap-1">
        {(['failed', 'skipped', 'dropped'] as const).map((p) => (
          <button
            key={p}
            type="button"
            // Clicking the chip that is already on goes back to the pool, so
            // there is always a way out that is not a second "pool" control.
            onClick={() => setPile(pile === p ? null : p)}
            aria-pressed={pile === p}
            disabled={piles[p].length === 0 && pile !== p}
            className={`rounded-md border px-2 py-1 text-xs capitalize disabled:opacity-40 ${
              pile === p
                ? 'bg-accent border-foreground/20'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground border-transparent'
            }`}
          >
            {p} · {piles[p].length}
          </button>
        ))}
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search…"
        aria-label="Search the pool"
        className="bg-background focus-visible:ring-ring/50 mb-2 w-full rounded-md border px-2.5 py-1.5 text-xs focus-visible:ring-3 focus-visible:outline-none"
      />

      {/* No scroller of its own: the pool now sits under the issues in one
          column that scrolls as a whole, and a list that scrolled inside that
          would be two scrollbars deep and impossible to drag out of. */}
      <div className={`rounded-lg border ${isOver ? 'border-foreground border-dashed' : ''}`}>
        <SortableContext id="pool" items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <ul className="divide-y">
            {items.map((item) => (
              <ArticleRow
                key={item.id}
                item={item}
                draggable={pile === null && editable}
                trailing={
                  <>
                    {pile === 'failed' && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={busy === item.id}
                        onClick={() => void act(item, 'retry')}
                        aria-label={`Retry ${item.title}`}
                        className="text-muted-foreground hover:text-foreground self-center"
                      >
                        <RotateCcw />
                      </Button>
                    )}
                    {pile === 'skipped' && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={busy === item.id}
                        onClick={() => void act(item, 'unskip')}
                        aria-label={`Un-skip ${item.title}`}
                        className="text-muted-foreground hover:text-foreground self-center"
                      >
                        <Undo2 />
                      </Button>
                    )}
                    {pile !== 'dropped' && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={busy === item.id}
                        onClick={() => setConfirming(item)}
                        aria-label={`Delete ${item.title}`}
                        className="text-muted-foreground hover:text-destructive self-center"
                      >
                        <X />
                      </Button>
                    )}
                  </>
                }
              />
            ))}
            {items.length === 0 && (
              <li className="text-muted-foreground px-4 py-8 text-center text-xs">
                {pile === null ? 'The pool is empty. Save something to hw.' : `Nothing ${pile}.`}
              </li>
            )}
          </ul>
        </SortableContext>
      </div>

      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-title"
        >
          <div className="bg-background w-full max-w-sm rounded-lg border p-5 shadow-lg">
            <h3 id="delete-title" className="font-serif text-lg">
              Delete for good?
            </h3>
            <p className="mt-2 text-sm">“{confirming.title}”</p>
            <p className="text-muted-foreground mt-3 text-xs">
              It leaves the pool permanently, and re-saving the same link will not bring it back. The
              raindrop moves to a <span className="font-medium">Not printing</span> collection, which is
              where to find it if you change your mind.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy === confirming.id}
                onClick={() => void destroy(confirming)}
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
