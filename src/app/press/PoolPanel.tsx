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
import { Plus, RotateCcw, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FIELD, Toggle } from './controls'
import { readJson } from './readJson'
import { ArticleRow } from './ArticleRow'
import type { PoolItem } from './Workbench'

/**
 * The exceptions. `null` is the pool, which is the panel's default state.
 *
 * `arriving` is not an exception in the same sense — it is the pool's own
 * waiting room, everything queued or extracted but not yet measured. It has a
 * chip because a paste of ten links leaves the pool looking untouched for a
 * couple of minutes, and a pool that looks untouched is a paste somebody makes
 * twice.
 */
type Pile = 'arriving' | 'failed' | 'skipped' | 'dropped'

export function PoolPanel({
  pool,
  arriving,
  failed,
  skipped,
  dropped,
  editable,
  onError,
  onNote,
  onRefresh,
}: {
  pool: PoolItem[]
  arriving: PoolItem[]
  failed: PoolItem[]
  skipped: PoolItem[]
  dropped: PoolItem[]
  editable: boolean
  onError: (m: string | null) => void
  onNote: (m: string | null) => void
  onRefresh: () => void
}) {
  const [pile, setPile] = useState<Pile | null>(null)
  const [paste, setPaste] = useState('')
  const [pasting, setPasting] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<PoolItem | null>(null)
  const { setNodeRef, isOver } = useDroppable({ id: 'pool' })

  const piles: Record<Pile, PoolItem[]> = { arriving, failed, skipped, dropped }
  const items = (pile ? piles[pile] : pool).filter((i) =>
    query.trim() ? `${i.title} ${i.url ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()) : true,
  )

  /**
   * Add a block of links.
   *
   * Reports all of it — what was added, what this press already had, what was
   * repeated in the paste, what was not a link at all. A paste that quietly
   * absorbs half its input is the same bug as a dedupe key that swallowed
   * somebody's article, and the counts are how it stays visible.
   */
  const addPaste = async () => {
    if (!paste.trim()) return
    setPasting(true)
    onError(null)
    onNote(null)
    try {
      const res = await fetch('/api/press/paste', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: paste }),
      })
      const body = await readJson<{ message?: string; added?: number }>(res)
      if (!res.ok) {
        onError(body.error ?? 'Could not add those.')
        return
      }
      onNote(body.message ?? null)
      // Cleared only when something landed: a paste that added nothing is one
      // you want to look at rather than one you want gone.
      if (body.added) {
        setPaste('')
        // Straight to the waiting room, so the links just added are visible
        // rather than absent from a pool they have not reached yet.
        setPile('arriving')
      }
      onRefresh()
    } finally {
      setPasting(false)
    }
  }

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
      <div className="mb-2 flex flex-wrap gap-1.5">
        {(['arriving', 'failed', 'skipped', 'dropped'] as const).map((p) => (
          <Toggle
            key={p}
            // Clicking the chip that is already on goes back to the pool, so
            // there is always a way out that is not a second "pool" control.
            active={pile === p}
            onClick={() => setPile(pile === p ? null : p)}
            disabled={piles[p].length === 0 && pile !== p}
            className="flex-1 capitalize"
          >
            {p} · {piles[p].length}
          </Toggle>
        ))}
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search…"
        aria-label="Search the pool"
        className={`${FIELD} mb-2`}
      />

      {editable && (
        <div className="mb-2 grid gap-1.5">
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={paste ? 4 : 2}
            placeholder="paste links, one per line…"
            aria-label="Add articles by pasting links"
            className={`${FIELD} resize-y font-mono text-xs`}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={pasting || !paste.trim()}
            onClick={() => void addPaste()}
          >
            <Plus data-icon="inline-start" />
            {pasting ? 'Adding…' : 'Add to the pool'}
          </Button>
        </div>
      )}

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
                dense
                draggable={pile === null && editable}
                trailing={
                  <>
                    {(pile === 'failed' || pile === 'arriving') && (
                      <Button
                        size="icon"
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
                        size="icon"
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
                        size="icon"
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
                {pile === null
                  ? 'The pool is empty. Paste some links, or save something to hw.'
                  : pile === 'arriving'
                    ? 'Nothing on its way in.'
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
              <Button size="lg" variant="outline" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                size="lg"
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
