'use client'

/**
 * press — the workbench shell.
 *
 * Three panels and one drag context spanning two of them. An article dragged
 * from the pool into the issue, or out of the issue back to the pool, is the
 * same gesture in both directions; the button on an issue row is that second
 * direction without the dragging. All of them end in one call that states the
 * issue's complete contents — because one drag can add, reorder and displace
 * all at once, and sending that as three requests would leave the issue in a
 * shape nobody asked for if the second one failed.
 *
 * The optimistic update is deliberate: a drag that snaps back on every round
 * trip is unusable. The server owns the truth and the panel reverts to the
 * last order it agreed to when the two disagree — which they will, because the
 * pool is also being filled by a worker on a schedule.
 *
 * See docs/plans/2026-08-31-003-feat-press-workbench-plan.md §2, §3.
 */

import { useCallback, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ArrowRight, Lock, LockOpen, Package, Plus, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { readJson } from './readJson'
import { ArticleRow, articleLabel } from './ArticleRow'
import { PoolPanel } from './PoolPanel'
import { OrdersPanel } from './OrdersPanel'
import { SettingsPanel, type SettingsProps } from './SettingsPanel'
import { OrderDialog } from './OrderDialog'
import { PrintSpec } from './PrintSpec'
import type { OrderWithIssue } from '@/lib/press/orders'

export interface PoolItem {
  id: string
  title: string
  url: string | null
  byline: string | null
  sourceName: string | null
  pageCount: number
  reason?: string | null
}

export interface WorkbenchIssue {
  id: string
  number: number
  name: string
  state: string
  contents: PoolItem[]
  pages: number
  pageTotal: number
  built: boolean
  hasCover: boolean
  dirty: boolean
  luluJobId: string | null
  rejectionReason: string | null
}

interface Props {
  issues: WorkbenchIssue[]
  pool: PoolItem[]
  failed: PoolItem[]
  skipped: PoolItem[]
  dropped: PoolItem[]
  orders: OrderWithIssue[] | null
  settings: SettingsProps
  threshold: number
  /** Lulu POD package id, decoded for the print-spec panel. */
  packageId: string
}

/** `open` and `closed` are the schema's words; these are the reader's. */
export const STATE_LABEL: Record<string, string> = {
  open: 'draft',
  closed: 'locked',
  approved: 'ordered',
  ordered: 'ordered',
  shipped: 'shipped',
  rejected: 'rejected',
  skipped: 'declined',
}

/**
 * Which issues can be ticked for a bundle — the same two states that offer an
 * Order button on the issue itself.
 *
 * The real gate is `orderBlockers`, which needs the address, the built files
 * and the open orders, and so can only run on the server. This is the cheap
 * half: it keeps a draft out of a parcel, and the dialog refuses the bundle
 * with a reason for everything else.
 */
function orderable(state: string): boolean {
  return state === 'closed' || state === 'shipped'
}

const RAIL_FILTERS = ['all', 'draft', 'locked', 'printed'] as const
type RailFilter = (typeof RAIL_FILTERS)[number]

function inFilter(state: string, filter: RailFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'draft') return state === 'open'
  if (filter === 'locked') return state === 'closed' || state === 'rejected'
  return state === 'approved' || state === 'ordered' || state === 'shipped'
}

export function Workbench(props: Props) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  /**
   * What the server last agreed to for THIS issue, so a rejected drag can be
   * put back.
   *
   * Was a `useRef` seeded from `props.issues[0]`, which is evaluated once and
   * never re-based when the rail selection changes. Selecting a different
   * issue and then having a commit fail wrote the *first* issue's article list
   * into the selected issue's panel — a composition that had never existed,
   * and which the next drag would then POST as though it were real.
   *
   * Keyed by issue number, and cleared whenever the server re-seeds.
   */
  const committedRef = useRef<{ number: number; contents: PoolItem[]; pool: PoolItem[] } | null>(null)

  const [issues, setIssues] = useState(props.issues)
  const [pool, setPool] = useState(props.pool)

  /**
   * Re-seed from the server whenever it hands us a new answer.
   *
   * `useState(props.x)` reads its initializer once. Every `router.refresh()` —
   * after opening an issue, locking one, deleting from the pool, retrying a
   * failed extraction — re-renders the server component and passes fresh
   * props that this component was then ignoring. The visible effect was that
   * those actions all appeared to do nothing: a new issue could not be
   * selected because it was not in the list, and a locked issue kept offering
   * Lock. Worse, `failed`/`skipped` were passed straight through and *did*
   * update, so retrying an article made it leave one pile and never arrive in
   * the other.
   *
   * Keyed on identity, not a deep compare: Next gives us new arrays only when
   * the server actually re-rendered, which is precisely when we want to yield
   * to it.
   */
  const seeded = useRef({ issues: props.issues, pool: props.pool })
  if (seeded.current.issues !== props.issues || seeded.current.pool !== props.pool) {
    seeded.current = { issues: props.issues, pool: props.pool }
    setIssues(props.issues)
    setPool(props.pool)
    committedRef.current = null
  }
  const [selected, setSelected] = useState<number | null>(props.issues[0]?.number ?? null)
  const [tab, setTab] = useState<'pool' | 'orders' | 'settings'>('pool')
  const [railFilter, setRailFilter] = useState<RailFilter>('all')
  const [railQuery, setRailQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState<PoolItem | null>(null)
  /**
   * The issues the order dialog is about, or null when it is closed.
   *
   * A list rather than a number even for one issue: the dialog, the route and
   * `performBundledApproval` all take a bundle of one down the same path as a
   * bundle of three, and a second single-issue path here is the one that would
   * drift out of step with them.
   */
  const [ordering, setOrdering] = useState<number[] | null>(null)
  /**
   * Ticked in the rail, waiting to be ordered together.
   *
   * Kept here rather than in the dialog because the selection is made across
   * the rail, over several issues, before the dialog exists — and because
   * closing the dialog should not throw away a selection someone assembled.
   */
  const [bundle, setBundle] = useState<number[]>([])

  const issue = useMemo(
    () => issues.find((i) => i.number === selected) ?? null,
    [issues, selected],
  )


  /** This issue's last agreed state, or the server's latest word on it. */
  const lastAgreed = (number: number) =>
    committedRef.current?.number === number
      ? committedRef.current
      : { contents: issues.find((i) => i.number === number)?.contents ?? [], pool }

  // `commit` is memoised and must not close over a stale `lastAgreed`.
  const lastAgreedRef = useRef(lastAgreed)
  lastAgreedRef.current = lastAgreed

  const editable = issue?.state === 'open'

  const sensors = useSensors(
    // A few pixels of slop, or the drag handle can never simply be clicked.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const commitSeq = useRef(0)

  const setIssueContents = useCallback(
    (number: number, contents: PoolItem[], opts: { dirty?: boolean } = {}) =>
      setIssues((all) =>
        all.map((i) =>
          i.number === number
            ? {
                ...i,
                contents,
                pages: contents.reduce((n, e) => n + e.pageCount, 0),
                // A reverted edit must not leave the issue marked "edited since
                // the last build" — nothing was edited; the server said no.
                dirty: opts.dirty ?? true,
              }
            : i,
        ),
      ),
    [],
  )

  /**
   * State the issue's complete contents. One call, one transaction.
   *
   * Requests carry a sequence number because drags are fire-and-forget: two
   * quick ones overlap, and if the first response lands second it would write
   * the older server state over the newer one, leaving the panel disagreeing
   * with the database until a reload. Only the newest reply is allowed to
   * write.
   */
  const commit = useCallback(
    async (number: number, itemIds: string[]) => {
      const seq = ++commitSeq.current
      const previous = lastAgreedRef.current(number)
      setBusy(true)
      setError(null)

      const revert = () => {
        if (seq !== commitSeq.current) return
        setIssueContents(number, previous.contents, { dirty: false })
        setPool(previous.pool)
      }

      try {
        const res = await fetch(`/api/press/issue/${number}/contents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ itemIds }),
        })
        const body = (await res.json().catch(() => null)) as {
          contents?: PoolItem[]
          pool?: PoolItem[]
          error?: string
        } | null

        if (!res.ok || !body?.contents || !body?.pool) {
          if (seq === commitSeq.current) setError(body?.error ?? 'The edit did not stick.')
          revert()
          return false
        }
        // A superseded reply is correct but stale; dropping it is the point.
        if (seq !== commitSeq.current) return true

        committedRef.current = { number, contents: body.contents, pool: body.pool }
        setIssueContents(number, body.contents)
        setPool(body.pool)
        return true
      } catch (err) {
        if (seq === commitSeq.current) setError((err as Error).message)
        revert()
        return false
      } finally {
        if (seq === commitSeq.current) setBusy(false)
      }
    },
    [setIssueContents],
  )

  /**
   * Take an article out of the issue and put it back in the pool.
   *
   * The one edit behind two gestures — dragging the row onto the pool, and the
   * button on the row for when the pool is not on screen or the list is long
   * enough that dragging to it is a chore. Nothing is destroyed: the article
   * returns to where it came from, and deleting it stays a separate decision
   * made in the pool.
   */
  const returnToPool = useCallback(
    (from: WorkbenchIssue, itemId: string) => {
      const entry = from.contents.find((e) => e.id === itemId)
      if (!entry) return
      const next = from.contents.filter((e) => e.id !== itemId)
      setIssueContents(from.number, next)
      setPool((p) => [entry, ...p])
      void commit(from.number, next.map((e) => e.id))
    },
    [commit, setIssueContents],
  )

  const onDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id)
    setDragging(pool.find((p) => p.id === id) ?? issue?.contents.find((c) => c.id === id) ?? null)
  }

  /**
   * Where did it land?
   *
   * Comparing `over.id` to the container ids directly is not enough: with
   * `pointerWithin`, dropping onto a populated list resolves to the nearest
   * *row*, not the container. So an article dragged out of an issue onto a
   * non-empty pool reported `over.id` = some pool item, missed the `'pool'`
   * branch, fell through to the reorder branch and silently did nothing — and
   * a pool item dropped back onto the pool reported the same thing, missed
   * nothing, and got appended to the issue. dnd-kit records the owning
   * SortableContext on each sortable, which is the question actually being
   * asked.
   */
  const containerOf = (over: DragEndEvent['over']): 'issue' | 'pool' | null => {
    if (!over) return null
    if (over.id === 'issue' || over.id === 'pool') return over.id
    const owner = over.data.current?.sortable?.containerId
    if (owner === 'issue' || owner === 'pool') return owner
    // A sortable we do not recognise: treat it as "nowhere" rather than
    // guessing, because every guess here moves an article.
    return null
  }

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null)
    const { active, over } = event
    if (!over || !issue || !editable) return

    const activeId = String(active.id)
    const overId = String(over.id)
    const target = containerOf(over)
    if (target === null) return

    const contents = issue.contents
    const fromIssue = contents.findIndex((e) => e.id === activeId)
    const fromPool = pool.find((p) => p.id === activeId)

    // Out of the issue and back to the pool.
    if (fromIssue !== -1 && target === 'pool') {
      returnToPool(issue, activeId)
      return
    }

    // Picked up in the pool and put down in the pool: the pool has no order,
    // so this is a cancelled drag, not an edit.
    if (fromPool && target === 'pool') return

    // Into the issue, at the row it was dropped on, or at the end.
    if (fromPool && target === 'issue') {
      const at = contents.findIndex((e) => e.id === overId)
      const next = [...contents]
      next.splice(at === -1 ? next.length : at, 0, fromPool)
      setIssueContents(issue.number, next)
      setPool((p) => p.filter((i) => i.id !== activeId))
      void commit(issue.number, next.map((e) => e.id))
      return
    }

    // A reorder within the issue.
    if (fromIssue !== -1 && target === 'issue') {
      const to = contents.findIndex((e) => e.id === overId)
      if (to === -1 || to === fromIssue) return
      const next = arrayMove(contents, fromIssue, to)
      setIssueContents(issue.number, next)
      void commit(issue.number, next.map((e) => e.id))
    }
  }

  const refresh = () => startTransition(() => router.refresh())

  const newIssue = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/press/issue', { method: 'POST' })
      const body = await readJson<{ number: number }>(res)
      if (!res.ok || body.number === undefined) {
        setError(body.error ?? 'Could not open an issue.')
        return
      }
      setSelected(body.number)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  /** The old oldest-first-to-the-threshold rule, as a button. */
  const autoFill = () => {
    if (!issue) return
    const oldestFirst = [...pool].reverse()
    const next = [...issue.contents]
    let total = issue.pages
    for (const item of oldestFirst) {
      if (total >= props.threshold) break
      next.push(item)
      total += item.pageCount
    }
    if (next.length === issue.contents.length) return
    setIssueContents(issue.number, next)
    setPool((p) => p.filter((i) => !next.some((n) => n.id === i.id)))
    void commit(issue.number, next.map((e) => e.id))
  }

  /**
   * The ticked issues that are still orderable.
   *
   * The checkbox shows `bundle` directly, because a checkbox should say what
   * was ticked. What may not use it raw is the order bar: once the emailed
   * link is followed an issue moves to `approved`, its checkbox stops being
   * rendered, and the number it left behind in `bundle` would otherwise still
   * be counted in "Order these 2" and handed to `setOrdering` — offering to
   * spend money on something the server now refuses. Derived rather than
   * cleaned up on re-seed, so a stale number falls out on its own.
   */
  const selection = bundle.filter((n) =>
    issues.some((i) => i.number === n && orderable(i.state)),
  )

  const railIssues = issues
    .filter((i) => inFilter(i.state, railFilter))
    .filter((i) =>
      railQuery.trim()
        ? `${i.number} ${i.name}`.toLowerCase().includes(railQuery.trim().toLowerCase())
        : true,
    )

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)_24rem]">
        {/* ── Issues ───────────────────────────────────────────────── */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Issues</h2>
            <Button size="icon-xs" variant="ghost" onClick={() => void newIssue()} disabled={busy} aria-label="New issue">
              <Plus />
            </Button>
          </div>
          <input
            value={railQuery}
            onChange={(e) => setRailQuery(e.target.value)}
            placeholder="search…"
            aria-label="Search issues"
            className="bg-background focus-visible:ring-ring/50 mb-2 w-full rounded-md border px-2 py-1 text-xs focus-visible:ring-3 focus-visible:outline-none"
          />
          <div className="mb-2 flex flex-wrap gap-1">
            {RAIL_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setRailFilter(f)}
                className={`rounded px-1.5 py-0.5 text-xs capitalize ${
                  railFilter === f ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <ul className="space-y-0.5">
            {railIssues.map((i) => (
              <li key={i.number} className="flex items-center gap-1.5">
                {/* Outside the row button, not inside it: a checkbox nested in
                    a button is neither valid nor clickable on its own, and
                    ticking an issue must not also select it for editing. */}
                {orderable(i.state) ? (
                  <input
                    type="checkbox"
                    className="shrink-0"
                    checked={bundle.includes(i.number)}
                    onChange={(e) =>
                      setBundle((b) =>
                        e.target.checked ? [...b, i.number].sort((x, y) => x - y) : b.filter((n) => n !== i.number),
                      )
                    }
                    aria-label={`Order issue ${i.number} with others`}
                  />
                ) : (
                  <span className="w-3.5 shrink-0" />
                )}
                <button
                  type="button"
                  onClick={() => setSelected(i.number)}
                  aria-current={i.number === selected}
                  className={`flex min-w-0 flex-1 items-baseline gap-1.5 rounded-md px-2 py-1.5 text-left text-xs ${
                    i.number === selected ? 'bg-accent' : 'hover:bg-accent/50'
                  }`}
                >
                  <span className="shrink-0 tabular-nums">#{i.number}</span>
                  <span className="text-muted-foreground shrink-0">{STATE_LABEL[i.state] ?? i.state}</span>
                  <span className="truncate">{i.name}</span>
                  <span className="text-muted-foreground ml-auto shrink-0 tabular-nums">{i.pages}pp</span>
                </button>
              </li>
            ))}
            {railIssues.length === 0 && (
              <li className="text-muted-foreground px-2 py-4 text-xs">
                {issues.length === 0 ? 'No issues yet. Open one.' : 'Nothing matches.'}
              </li>
            )}
          </ul>

          {/* The bundling gesture, and the only place it is offered. Two
              issues in one Lulu job pay for one parcel instead of two, and
              the dialog says how much that is before anything is sent. */}
          {selection.length > 0 && (
            <div className="mt-2 rounded-md border p-2">
              <p className="text-muted-foreground text-xs">
                {selection.length === 1
                  ? `Issue ${selection[0]} selected. Tick another to share one parcel.`
                  : `${selection.map((n) => `#${n}`).join(', ')} — one job, one shipping charge.`}
              </p>
              <div className="mt-1.5 flex gap-2">
                <Button size="xs" onClick={() => setOrdering(selection)}>
                  <Package data-icon="inline-start" />
                  Order {selection.length === 1 ? 'it' : `these ${selection.length}`}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setBundle([])}>
                  Clear
                </Button>
              </div>
            </div>
          )}
        </aside>

        {/* ── The issue ────────────────────────────────────────────── */}
        <section className="min-w-0">
          {issue ? (
            <IssuePanel
              packageId={props.packageId}
              issue={issue}
              threshold={props.threshold}
              busy={busy}
              editable={editable}
              onError={setError}
              onNote={setNote}
              onRefresh={refresh}
              onAutoFill={autoFill}
              onRemove={(itemId) => returnToPool(issue, itemId)}
              onOrder={() => setOrdering([issue.number])}
              poolCount={pool.length}
            />
          ) : (
            <p className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
              No issue selected. Open one with <span className="font-medium">+</span> above.
            </p>
          )}

          {error && (
            <p className="text-destructive mt-3 text-xs" role="alert">
              {error}
            </p>
          )}
          {note && (
            <p className="text-muted-foreground mt-3 text-xs" role="status">
              {note}
            </p>
          )}
        </section>

        {/* ── Pool · Orders · Settings ─────────────────────────────── */}
        <aside className="min-w-0">
          <div className="mb-3 flex gap-1">
            {(['pool', 'orders', 'settings'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`rounded-md px-2 py-1 text-xs font-medium capitalize ${
                  tab === t ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t}
                {t === 'pool' && ` · ${pool.length}`}

              </button>
            ))}
          </div>

          {/* Kept mounted rather than swapped: the pool is the drop target for
              a drag that may start while another tab is showing, and an
              unmounted droppable is not a droppable. */}
          <div hidden={tab !== 'pool'}>
            <PoolPanel
              pool={pool}
              failed={props.failed}
              skipped={props.skipped}
              dropped={props.dropped}
              editable={editable}
              onError={setError}
              onNote={setNote}
              onRefresh={refresh}
            />
          </div>
          {tab === 'orders' && <OrdersPanel orders={props.orders} onError={setError} onRefresh={refresh} />}
          {tab === 'settings' && <SettingsPanel {...props.settings} onError={setError} onNote={setNote} onRefresh={refresh} />}
        </aside>
      </div>

      <DragOverlay>
        {dragging && (
          <div className="bg-background rounded-md border px-3 py-2 text-xs shadow-lg">
            {articleLabel(dragging)}
          </div>
        )}
      </DragOverlay>

      {ordering && (
        <OrderDialog
          issueNumbers={ordering}
          onClose={() => setOrdering(null)}
          onError={setError}
          onNote={setNote}
        />
      )}
    </DndContext>
  )
}

// ── The middle panel ─────────────────────────────────────────────────────────

function IssuePanel({
  issue,
  threshold,
  busy,
  editable,
  onError,
  onNote,
  onRefresh,
  onAutoFill,
  onRemove,
  onOrder,
  poolCount,
  packageId,
}: {
  issue: WorkbenchIssue
  threshold: number
  busy: boolean
  editable: boolean
  onError: (m: string | null) => void
  onNote: (m: string | null) => void
  onRefresh: () => void
  onAutoFill: () => void
  /** Send one article back to the pool, by id. */
  onRemove: (itemId: string) => void
  onOrder: () => void
  poolCount: number
  packageId: string
}) {
  const [working, setWorking] = useState<string | null>(null)
  const { setNodeRef, isOver } = useDroppable({ id: 'issue', disabled: !editable })

  /** Lock and rebuild both stream NDJSON, because both are minutes of Chromium. */
  const stream = async (url: string, body?: object) => {
    setWorking('Starting')
    onError(null)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const err = (await res.json()) as { error?: string }
        onError(err.error ?? 'That did not work.')
        return
      }
      if (!res.body) throw new Error('No response from the builder.')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const event = JSON.parse(line) as {
            progress?: string
            error?: string
            done?: { name: string; pageCount: number; preflight: { code: string }[] }
          }
          if (event.progress) setWorking(event.progress)
          if (event.error) onError(event.error)
          if (event.done) {
            onNote(
              `“${event.done.name}” — ${event.done.pageCount} pages, preflight ` +
                `${event.done.preflight.length ? event.done.preflight.map((p) => p.code).join(', ') : 'clean'}`,
            )
            onRefresh()
          }
        }
      }
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setWorking(null)
    }
  }

  const unlock = async () => {
    setWorking('Unlocking')
    onError(null)
    try {
      const res = await fetch(`/api/press/issue/${issue.number}/lock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'unlock' }),
      })
      const body = await readJson(res)
      if (!res.ok) onError(body.error ?? 'Could not unlock.')
      else onRefresh()
    } finally {
      setWorking(null)
    }
  }

  const locked = busy || working !== null
  const printed = ['approved', 'ordered', 'shipped'].includes(issue.state)

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-serif text-xl">{issue.name}</h2>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Issue {issue.number} · {STATE_LABEL[issue.state] ?? issue.state} ·{' '}
            {issue.built ? `${issue.pageTotal}pp built` : 'not built'}
            {issue.dirty && issue.built && ' · edited since'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {issue.built && (
            <a
              className="hover:bg-accent rounded-md border px-2.5 py-1 text-xs"
              href={`/api/press/file/${issue.number}/interior.pdf`}
              target="_blank"
              rel="noreferrer"
            >
              Interior
            </a>
          )}
          {editable && (
            <>
              <Button size="xs" variant="outline" disabled={locked || poolCount === 0} onClick={onAutoFill}>
                <Sparkles data-icon="inline-start" />
                Auto-fill
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={locked || issue.contents.length === 0}
                onClick={() => void stream(`/api/press/issue/${issue.number}/rebuild`)}
              >
                Rebuild
              </Button>
              <Button
                size="xs"
                disabled={locked || issue.contents.length === 0}
                onClick={() => void stream(`/api/press/issue/${issue.number}/lock`, { action: 'lock' })}
              >
                <Lock data-icon="inline-start" />
                Lock
              </Button>
            </>
          )}
          {issue.state === 'closed' && (
            <>
              <Button size="xs" variant="outline" disabled={locked} onClick={() => void unlock()}>
                <LockOpen data-icon="inline-start" />
                Unlock
              </Button>
              <Button size="xs" disabled={locked} onClick={onOrder}>
                Order
              </Button>
            </>
          )}
          {issue.state === 'shipped' && (
            <Button size="xs" variant="outline" disabled={locked} onClick={onOrder}>
              Order another copy
            </Button>
          )}
        </div>
      </div>

      {/* The built count is the true one; before a build, the draft's measured
          pages are the best estimate of how thick it will be. */}
      <PrintSpec packageId={packageId} pageCount={issue.pageTotal || issue.pages} />

      {issue.state === 'rejected' && (
        <p className="border-destructive/50 text-destructive mb-3 border-l-2 py-1 pl-3 text-xs">
          Lulu refused the files{issue.rejectionReason ? `: ${issue.rejectionReason}` : '.'} Unlock, fix, and lock again.
        </p>
      )}

      {issue.dirty && issue.built && editable && (
        <p className="border-muted-foreground/30 text-muted-foreground mb-3 border-l-2 py-1 pl-3 text-xs">
          The PDF on file is the previous build. Lock — or rebuild — to see these changes in print.
        </p>
      )}

      {working && (
        <p className="text-muted-foreground mb-3 text-xs" role="status" aria-live="polite">
          {working}…
        </p>
      )}

      <div
        ref={setNodeRef}
        className={`rounded-lg border ${isOver ? 'border-foreground border-dashed' : ''}`}
      >
        <SortableContext id="issue" items={issue.contents.map((e) => e.id)} strategy={verticalListSortingStrategy}>
          <ol className="divide-y">
            {issue.contents.map((entry, i) => (
              <ArticleRow
                key={entry.id}
                item={entry}
                index={i + 1}
                draggable={editable}
                trailing={
                  // Not the pool's `×`: that one deletes for good, and the same
                  // glyph doing two different things on one screen is how a
                  // mis-click becomes a loss. This points at the pool, which is
                  // both where the article goes and where the panel sits.
                  editable ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      disabled={locked}
                      onClick={() => onRemove(entry.id)}
                      aria-label={`Remove ${entry.title} from issue ${issue.number}`}
                      title="Back to the pool"
                      className="text-muted-foreground hover:text-foreground self-center"
                    >
                      <ArrowRight />
                    </Button>
                  ) : undefined
                }
              />
            ))}
            {issue.contents.length === 0 && (
              <li className="text-muted-foreground px-4 py-10 text-center text-sm">
                {editable ? 'Empty. Drag something in from the pool.' : 'Empty.'}
              </li>
            )}
          </ol>
        </SortableContext>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <div className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full">
          <div
            className="bg-foreground h-full rounded-full transition-[width]"
            style={{ width: `${Math.min(100, (issue.pages / threshold) * 100)}%` }}
          />
        </div>
        <p className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {issue.pages} / {threshold} pages
          {printed && ' · printed'}
        </p>
      </div>
    </div>
  )
}
