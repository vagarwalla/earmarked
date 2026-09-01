'use client'

/**
 * press — the pool.
 *
 * Every article that has been extracted and measured and that no issue has
 * claimed. This is the source of truth the whole workbench turns on: issues
 * are arrangements of it, removing an article from one returns it here, and
 * the `×` on a row is the only permanent delete in the product.
 *
 * The three other tabs are the piles that are not waiting — a broken
 * extraction, a reference page set aside, and what has been discarded. Each
 * has the one action that gets it back, because un-skipping used to mean
 * hand-editing JSON.
 *
 * See docs/plans/2026-08-31-003-feat-press-workbench-plan.md §2, §4.
 */

import { useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { RotateCcw, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ArticleRow } from './ArticleRow'
import type { PoolItem } from './Workbench'

type Pile = 'waiting' | 'failed' | 'skipped' | 'dropped'

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
  const [pile, setPile] = useState<Pile>('waiting')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<PoolItem | null>(null)
  const { setNodeRef, isOver } = useDroppable({ id: 'pool' })

  const piles: Record<Pile, PoolItem[]> = { waiting: pool, failed, skipped, dropped }
  const items = piles[pile].filter((i) =>
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
      const body = (await res.json()) as { error?: string }
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
      const body = (await res.json()) as { error?: string; warning?: string | null }
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
        {(['waiting', 'failed', 'skipped', 'dropped'] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPile(p)}
            className={`rounded px-1.5 py-0.5 text-xs capitalize ${
              pile === p ? 'bg-accent' : 'text-muted-foreground hover:text-foreground'
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
        className="bg-background focus-visible:ring-ring/50 mb-2 w-full rounded-md border px-2 py-1 text-xs focus-visible:ring-3 focus-visible:outline-none"
      />

      <div
        className={`max-h-[calc(100vh-14rem)] overflow-y-auto rounded-lg border ${
          isOver ? 'border-foreground border-dashed' : ''
        }`}
      >
        <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <ul className="divide-y">
            {items.map((item) => (
              <ArticleRow
                key={item.id}
                item={item}
                draggable={pile === 'waiting' && editable}
                trailing={
                  <>
                    {pile === 'failed' && (
                      <Button
                        size="icon-xs"
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
                        size="icon-xs"
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
                        size="icon-xs"
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
                {pile === 'waiting'
                  ? 'Nothing waiting. Save something to hw.'
                  : `Nothing ${pile}.`}
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
