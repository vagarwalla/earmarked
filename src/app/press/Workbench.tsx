'use client'

/**
 * press — the workbench shell.
 *
 * Three columns, and the middle one is the issue. On the left, the issues and
 * the pool they are made from — one column and one scroll, because an issue is
 * an arrangement of the pool and dragging between them should not mean crossing
 * the page. On the right, everything you can *do*: open an issue, fill it,
 * build it, lock it, order it, and the two panels that are not the issue at all.
 *
 * An article dragged from the pool into the issue, or out of the issue back to
 * the pool, is the same gesture in both directions; the button on an issue row
 * is that second direction without the dragging. All of them end in one call
 * that states the issue's complete contents — because one drag can add, reorder
 * and displace all at once, and sending that as three requests would leave the
 * issue in a shape nobody asked for if the second one failed.
 *
 * The optimistic update is deliberate: a drag that snaps back on every round
 * trip is unusable. The server owns the truth and the panel reverts to the
 * last order it agreed to when the two disagree — which they will, because the
 * pool is also being filled by a worker on a schedule.
 *
 * See docs/plans/2026-08-31-003-feat-press-workbench-plan.md §2, §3.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
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
import {
  ArrowLeft,
  BookImage,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Link2,
  Link2Off,
  Lock,
  LockOpen,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { readJson } from './readJson'
import { ArticleRow, articleLabel } from './ArticleRow'
import { IssuePreview, type Sheet } from './IssuePreview'
import { FIELD, Toggle } from './controls'
import { PoolPanel } from './PoolPanel'
import { OrdersPanel } from './OrdersPanel'
import { SettingsPanel, type SettingsProps } from './SettingsPanel'
import { OrderDialog } from './OrderDialog'
import { PrintSpec } from './PrintSpec'
import { PRINT_SPEC } from '@/lib/press/types'
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

/** The bit of a `press_jobs` row a button needs. See src/lib/press/jobs.ts. */
interface PressJobView {
  id: string
  issue_id: string
  intent: 'rebuild' | 'lock'
  state: 'queued' | 'running' | 'done' | 'failed'
  progress: string | null
  error: string | null
  result: { name: string; pageCount: number; preflight: { code: string }[] } | null
}

/**
 * What one issue's buttons are doing, and the line they are reporting.
 *
 * Held per issue rather than one at a time, because more than one can be in
 * flight: ticking four drafts and pressing Lock queues four renders, and a
 * single slot would have the fourth one's progress reporting on the first
 * one's panel. It is also what the resume on load needs — every live job is
 * picked back up, not just the oldest, which used to leave the newest render
 * looking idle and the oldest one's issue frozen behind a job nobody claimed.
 */
interface Working {
  what: 'rebuild' | 'lock' | 'unlock'
  message: string
  /** Queued, and no renderer has taken it yet. */
  stalled?: boolean
}

/** Keyed by issue number. Absent means that issue is idle. */
type WorkingMap = Record<number, Working>

/**
 * A run of composes started from one press of a multi-select button.
 *
 * Sequential, because the renderer is: locally `withBuildLock` serialises
 * them, and on the worker there is one machine. What this carries is the only
 * thing the loop knows that the per-issue lines do not — how far through the
 * list it is.
 */
interface Batch {
  what: 'rebuild' | 'lock'
  total: number
  done: number
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
  /** Readable by anyone with the link at /press/i/<handle>/<number>. */
  shared: boolean
  dirty: boolean
  luluJobId: string | null
  rejectionReason: string | null
  /**
   * How many times this issue has actually gone to the printer — orders
   * placed and not refused, copies included. An issue can be printed more
   * than once (`press_place_order` was built for exactly that), and until
   * this was on the row there was nowhere on the workbench that said so.
   */
  printCount: number
  /** When the row last changed; what busts the preview's cache. */
  updatedAt: string
}

interface Props {
  issues: WorkbenchIssue[]
  pool: PoolItem[]
  /** Queued and extracted — pasted or dropped, not yet measured into the pool. */
  arriving: PoolItem[]
  failed: PoolItem[]
  skipped: PoolItem[]
  dropped: PoolItem[]
  orders: OrderWithIssue[] | null
  /** The owner's handle, which is half of a shared issue's URL. */
  handle: string
  settings: SettingsProps
  threshold: number
  /** Lulu POD package id, decoded for the print-spec panel. */
  packageId: string
  /**
   * Whether this account may order at all.
   *
   * Two gates and-ed together upstream: PRESS_ORDER_ENABLED, which is V's own
   * safety catch on a button that spends money, and press_accounts.can_order,
   * which is false for everybody who is not her — ordering bills the one Lulu
   * account on file. Shown, never set, from here.
   */
  orderingEnabled: boolean
  /**
   * Whether this account could ever order, ignoring the env flag.
   *
   * Separate because the two mean different things to a reader. "Ordering is
   * switched off" is a thing V can turn back on; for a friend it is simply not
   * how their press works, and telling them to set an environment variable
   * would be telling them to fix something that is not broken.
   */
  canOrder: boolean
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

/**
 * Whether an issue has anything the selection bar could do to it.
 *
 * A draft can be locked or rebuilt, a locked or shipped one ordered. An issue
 * mid-order — approved, waiting on Lulu — has nothing on offer, and a checkbox
 * that ticks but changes no button is a checkbox that looks broken.
 */
function tickable(issue: { state: string; contents: unknown[] }): boolean {
  if (orderable(issue.state)) return true
  return issue.state === 'open' && issue.contents.length > 0
}

/** "3 drafts", "1 draft" — the count and its noun, agreeing. */
function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/** The one word a rail row has room for while an issue is being made. */
const WORKING_VERB: Record<'rebuild' | 'lock' | 'unlock', string> = {
  rebuild: 'building',
  lock: 'locking',
  unlock: 'unlocking',
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
  const [tab, setTab] = useState<'issue' | 'orders' | 'settings'>('issue')
  const [railFilter, setRailFilter] = useState<RailFilter>('all')
  /**
   * Which sheet the middle column is showing, and whether it is showing one.
   *
   * Up here rather than in the preview because the buttons that set it are in
   * the right-hand column with every other control — the middle column is the
   * issue itself, and a row of chrome across the top of it was costing the
   * viewer an inch of height on every screen.
   */
  const [sheet, setSheet] = useState<Sheet>('interior')
  const [previewOpen, setPreviewOpen] = useState(true)
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
   * Ticked in the rail.
   *
   * One selection, not one per action. It began as the bundle for an order and
   * is now what Lock and Rebuild act on too — the gesture is the same in all
   * three cases ("these ones"), and a second row of checkboxes for the other
   * two would have made the reader choose which set they were in before they
   * had chosen what to do with it.
   *
   * Kept here rather than in the dialog because the selection is made across
   * the rail, over several issues, before the dialog exists — and because
   * closing the dialog should not throw away a selection someone assembled.
   */
  const [ticked, setTicked] = useState<number[]>([])

  const issue = useMemo(
    () => issues.find((i) => i.number === selected) ?? null,
    [issues, selected],
  )


  /**
   * This issue's last agreed state, or the server's latest word on it.
   *
   * The fallback reads `seeded`, not the live lists. `committedRef` is cleared
   * on every re-seed, so between a refresh and the first successful commit the
   * live lists are whatever the last optimistic edit made them — and a second
   * edit that failed would then "revert" to a composition the server had
   * already rejected, which the next drag would POST as though it were real.
   */
  const lastAgreed = (number: number) =>
    committedRef.current?.number === number
      ? committedRef.current
      : {
          contents: seeded.current.issues.find((i) => i.number === number)?.contents ?? [],
          pool: seeded.current.pool,
        }

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
    // Every button is disabled while a build runs; a drag must be too. Moving
    // an article out mid-lock would freeze the issue against PDFs rendered from
    // the contents it had a minute ago — the exact trap the lock route composes
    // first to avoid. Not `locked`: that includes a commit in flight, and two
    // quick drags in a row are meant to work.
    if (issue.number in working) return

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

  // Stable, because `track` closes over it for the length of a render and a
  // fresh identity every keystroke would mean a fresh `track` mid-poll.
  const refresh = useCallback(() => startTransition(() => router.refresh()), [router, startTransition])

  /**
   * Rename a draft by hand. The build named it once, with a model, and the
   * person whose issue it is gets the last word — until lock, where the name
   * is frozen with everything else (plan question 3).
   *
   * An empty name clears it, and the next rebuild names the issue again.
   * Resolves to whether the server took it, so the title knows whether to
   * leave edit mode.
   */
  const rename = useCallback(
    async (number: number, name: string): Promise<boolean> => {
      setError(null)
      setNote(null)
      const res = await fetch(`/api/press/issue/${number}/name`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const body = await readJson<{ name: string | null }>(res)
      if (!res.ok) {
        setError(body.error ?? 'Could not rename that.')
        return false
      }
      const taken = body.name ?? `Issue ${number}`
      setIssues((all) => all.map((i) => (i.number === number ? { ...i, name: taken } : i)))
      const built = issues.find((i) => i.number === number)?.built
      setNote(
        body.name === null
          ? `Cleared — the next rebuild will name it.${built ? ' The PDF on file still carries the old name.' : ''}`
          : built
            ? 'Renamed. The PDF on file still carries the old name; rebuild — or lock — to put this one on the cover.'
            : 'Renamed.',
      )
      refresh()
      return true
    },
    [issues, refresh],
  )

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
   * The ticked issues, split by what can actually be done to them.
   *
   * The checkbox shows `ticked` directly, because a checkbox should say what
   * was ticked. What may not use it raw are the action buttons: once the
   * emailed link is followed an issue moves to `approved`, and the number it
   * left behind in `ticked` would otherwise still be counted in "Order these
   * 2" and handed to `setOrdering` — offering to spend money on something the
   * server now refuses. The same holds for Lock and Rebuild, which only a
   * draft with something in it can take. Derived rather than cleaned up on
   * re-seed, so a stale number falls out on its own.
   */
  const pick = (fn: (i: WorkbenchIssue) => boolean) =>
    ticked.filter((n) => issues.some((i) => i.number === n && fn(i)))

  const orderSelection = pick((i) => orderable(i.state))
  const draftSelection = pick((i) => i.state === 'open' && i.contents.length > 0)

  /**
   * What each issue's buttons are doing, and the line they are streaming.
   *
   * Lifted out of the issue panel because the buttons and the progress they
   * report now live in different columns — the actions on the right, the issue
   * itself in the middle. `what` is carried alongside the message so only the
   * button that was pressed says it is working; a single boolean made Lock
   * announce a rebuild.
   */
  const [working, setWorking] = useState<WorkingMap>({})
  /** The multi-select run in flight, if there is one. */
  const [batch, setBatch] = useState<Batch | null>(null)

  /** Set or clear one issue's line, leaving every other issue alone. */
  const setWorkingFor = useCallback((number: number, next: Working | null) => {
    setWorking((all) => {
      if (next === null) {
        if (!(number in all)) return all
        const rest = { ...all }
        delete rest[number]
        return rest
      }
      return { ...all, [number]: next }
    })
  }, [])

  /** Say what a finished compose produced, in the one line the panel has. */
  const announce = useCallback(
    (done: { name: string; pageCount: number; preflight: { code: string }[] }) => {
      setNote(
        `“${done.name}” — ${done.pageCount} pages, preflight ` +
          `${done.preflight.length ? done.preflight.map((p) => p.code).join(', ') : 'clean'}`,
      )
    },
    [],
  )

  /**
   * Follow a render happening on the worker.
   *
   * Polling, not streaming, and the reason is in the row: a compose queued from
   * here outlives this tab, so its progress cannot travel down a response body
   * that closes with the page. Two seconds is comfortably faster than the
   * stages it is reporting and is one indexed row read.
   */
  const track = useCallback(
    async (jobId: string, what: 'rebuild' | 'lock', number: number): Promise<boolean> => {
      const startedAt = Date.now()
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000))
        let job: PressJobView | undefined
        try {
          const res = await fetch(`/api/press/job/${jobId}`, { cache: 'no-store' })
          if (!res.ok) throw new Error('Lost track of the render.')
          ;({ job } = (await res.json()) as { job?: PressJobView })
        } catch (err) {
          // A dropped poll is not a failed render — the worker is still going.
          // Say so and keep asking; only a job row can end this loop.
          setWorkingFor(number, { what, message: (err as Error).message })
          continue
        }
        if (!job) {
          setError('That render is no longer on the queue.')
          return false
        }
        if (job.state === 'failed') {
          setError(job.error ?? 'The render failed.')
          return false
        }
        if (job.state === 'done') {
          if (job.result) announce(job.result)
          refresh()
          return true
        }
        // Queued, and still nobody has picked it up. Worth saying out loud
        // rather than spinning: a press with no renderer running looks exactly
        // like a slow one, and the difference is minutes against forever.
        // Nothing is aborted — a worker that starts late still finds the row.
        const stalled = job.state === 'queued' && Date.now() - startedAt > 45_000
        setWorkingFor(number, {
          what,
          stalled,
          message: stalled
            ? 'No renderer has picked this up. It stays queued until one does.'
            : (job.progress ?? 'Working'),
        })
      }
    },
    [announce, refresh, setWorkingFor],
  )

  /**
   * Ask for a compose, and follow it whichever way it happens.
   *
   * Two shapes come back. On the machine with `.press/`, the build runs inside
   * the request and streams NDJSON. Deployed, there is no browser: the route
   * answers 202 with a job row the worker will claim, and this polls it. One
   * button, one route, and the difference is which response arrives.
   */
  const compose = async (what: 'rebuild' | 'lock', number: number): Promise<boolean> => {
    const url =
      what === 'lock' ? `/api/press/issue/${number}/lock` : `/api/press/issue/${number}/rebuild`
    setWorkingFor(number, { what, message: 'Starting' })
    setError(null)
    setNote(null)
    const body = what === 'lock' ? { action: 'lock' } : undefined
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      const isJson = res.headers.get('content-type')?.includes('application/json')
      // A refusal — an empty issue, an article this machine cannot render, a
      // render already in flight — arrives as JSON, not as a stream. Named
      // with its issue, because a run of five makes "That did not work"
      // useless on its own.
      if (!res.ok && isJson) {
        const err = (await res.json()) as { error?: string }
        setError(`#${number}: ${err.error ?? 'That did not work.'}`)
        return false
      }
      if (res.status === 202 && isJson) {
        const { job } = (await res.json()) as { job: PressJobView }
        setWorkingFor(number, { what, message: job.progress ?? 'Queued' })
        return await track(job.id, what, number)
      }
      if (!res.body) throw new Error('No response from the builder.')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let ok = false
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
          if (event.progress) setWorkingFor(number, { what, message: event.progress })
          if (event.error) setError(`#${number}: ${event.error}`)
          if (event.done) {
            announce(event.done)
            refresh()
            ok = true
          }
        }
      }
      return ok
    } catch (err) {
      setError(`#${number}: ${(err as Error).message}`)
      return false
    } finally {
      setWorkingFor(number, null)
    }
  }

  /**
   * The same compose, over a list, one after another.
   *
   * Sequential and not `Promise.all`: there is one renderer. Locally
   * `withBuildLock` would serialise them anyway and the parallel calls would
   * simply queue against each other with no way to say which is which; on the
   * worker the second would be refused outright by the one-live-job index and
   * the reader would get four failures for work that was never attempted.
   *
   * A failure does not stop the run. Locking five issues where the third has
   * an article this machine cannot render should still lock the other four —
   * so the loop carries on and the count at the end says what actually
   * happened.
   */
  const composeMany = async (what: 'rebuild' | 'lock', numbers: number[]) => {
    if (numbers.length === 0) return
    if (numbers.length === 1) {
      await compose(what, numbers[0])
      return
    }
    setBatch({ what, total: numbers.length, done: 0 })
    const failed: number[] = []
    try {
      for (const [i, number] of numbers.entries()) {
        setBatch({ what, total: numbers.length, done: i })
        // `compose` clears the error before each one, so the last failure is
        // the one on screen; this keeps the whole tally.
        if (!(await compose(what, number))) failed.push(number)
      }
    } finally {
      setBatch(null)
    }
    const won = numbers.length - failed.length
    const verb = what === 'lock' ? 'Locked' : 'Rebuilt'
    setNote(
      failed.length === 0
        ? `${verb} ${won} issues.`
        : `${verb} ${won} of ${numbers.length}. ${failed.map((n) => `#${n}`).join(', ')} did not go through.`,
    )
    // Only what went through leaves the selection, so a second press retries
    // exactly the ones that did not.
    setTicked((t) => t.filter((n) => failed.includes(n)))
  }

  /**
   * Pick up the renders that were already in flight when this page loaded.
   *
   * The point of composing on the worker is that it survives the tab that
   * asked for it — pressed on a phone, watched on a laptop, or simply reloaded
   * halfway through. Without this the page shows an idle Rebuild button over a
   * machine four minutes into a hundred pages, and pressing it earns a refusal
   * from the one-live-job index rather than the progress that already exists.
   *
   * Every live job, not `jobs[0]`. That was written when one render could be
   * in flight; ticking four drafts and pressing Lock makes four. The old code
   * took the *oldest* live row and followed only that one, so the three newer
   * renders looked idle — and, worse, a single abandoned job at the head of
   * the queue meant every reload resumed a render nobody was doing, froze that
   * issue's buttons behind it, and polled it every two seconds forever.
   */
  const resumed = useRef(false)
  useEffect(() => {
    if (resumed.current) return
    resumed.current = true
    void (async () => {
      try {
        const res = await fetch('/api/press/job', { cache: 'no-store' })
        if (!res.ok) return
        const { jobs } = (await res.json()) as { jobs: PressJobView[] }
        const byId = new Map(props.issues.map((i) => [i.id, i.number]))
        await Promise.all(
          jobs.map(async (live) => {
            const number = byId.get(live.issue_id)
            if (number === undefined) return
            setWorkingFor(number, { what: live.intent, message: live.progress ?? 'Working' })
            try {
              await track(live.id, live.intent, number)
            } finally {
              setWorkingFor(number, null)
            }
          }),
        )
      } catch {
        // Nothing to recover, and nothing worth saying about it: the buttons
        // work either way, and a render nobody is watching still finishes.
      }
    })()
  }, [props.issues, track, setWorkingFor])

  const unlock = async (number: number) => {
    setWorkingFor(number, { what: 'unlock', message: 'Unlocking' })
    setError(null)
    try {
      const res = await fetch(`/api/press/issue/${number}/lock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'unlock' }),
      })
      const body = await readJson(res)
      if (!res.ok) setError(body.error ?? 'Could not unlock.')
      else refresh()
    } finally {
      setWorkingFor(number, null)
    }
  }

  const railIssues = issues
    .filter((i) => inFilter(i.state, railFilter))
    .filter((i) =>
      railQuery.trim()
        ? `${i.number} ${i.name}`.toLowerCase().includes(railQuery.trim().toLowerCase())
        : true,
    )

  /**
   * Don't touch this one while it is being made.
   *
   * Scoped to the issue the render is for, not to the whole workbench. It used
   * to be global, which was right when a build ran inside the request and the
   * page was the only thing that could have started one. A compose on the
   * worker outlives the tab, so a global lock would mean opening /press during
   * a four-minute render found every button dead, on every issue.
   */
  const locked = busy || batch !== null || (issue !== null && issue.number in working)

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="grid gap-5 lg:grid-cols-[21rem_minmax(0,1fr)_19rem]">
        {/* ── Issues, and the pool they are made from ──────────────── */}
        {/* One column, one scroll: an issue is an arrangement of the pool, and
            dragging between them should not mean crossing the page. */}
        <aside className="lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:self-start lg:overflow-y-auto lg:pr-1">
          <h2 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">Issues</h2>
          <input
            value={railQuery}
            onChange={(e) => setRailQuery(e.target.value)}
            placeholder="search…"
            aria-label="Search issues"
            className={`${FIELD} mb-2`}
          />
          <div className="mb-2 flex flex-wrap gap-1.5">
            {RAIL_FILTERS.map((f) => (
              <Toggle
                key={f}
                active={railFilter === f}
                onClick={() => setRailFilter(f)}
                className="flex-1 capitalize"
              >
                {f}
              </Toggle>
            ))}
          </div>
          <ul className="space-y-0.5">
            {railIssues.map((i) => (
              <li key={i.number} className="flex items-center gap-1.5">
                {/* Outside the row button, not inside it: a checkbox nested in
                    a button is neither valid nor clickable on its own, and
                    ticking an issue must not also select it for editing.
                    On every issue that has an action, not only the orderable
                    ones: what the tick means is decided by the bar below,
                    which offers Lock and Rebuild for the drafts in the
                    selection and Order for the ones already frozen. */}
                {tickable(i) ? (
                  <input
                    type="checkbox"
                    className="size-4 shrink-0"
                    checked={ticked.includes(i.number)}
                    onChange={(e) =>
                      setTicked((t) =>
                        e.target.checked ? [...t, i.number].sort((x, y) => x - y) : t.filter((n) => n !== i.number),
                      )
                    }
                    aria-label={`Select issue ${i.number}`}
                  />
                ) : (
                  <span className="w-4 shrink-0" />
                )}
                <button
                  type="button"
                  onClick={() => setSelected(i.number)}
                  aria-current={i.number === selected}
                  className={`flex min-w-0 flex-1 items-baseline gap-1.5 rounded-lg border px-2.5 py-2 text-left text-xs ${
                    i.number === selected
                      ? 'bg-accent border-foreground/20'
                      : 'hover:bg-accent/50 border-transparent'
                  }`}
                >
                  <span className="shrink-0 tabular-nums">#{i.number}</span>
                  <span className="text-muted-foreground shrink-0">{STATE_LABEL[i.state] ?? i.state}</span>
                  <span className="truncate">{i.name}</span>
                  <span className="text-muted-foreground ml-auto shrink-0 tabular-nums">{i.pages}pp</span>
                  {/* Beside the page count, because they are the two numbers
                      that describe the object: how thick, and how many times
                      it has been made. Absent rather than “×0” — most issues
                      have never been printed and a column of zeroes is noise. */}
                  {i.printCount > 0 && (
                    <span
                      className="bg-muted text-foreground shrink-0 rounded px-1 tabular-nums"
                      title={`Printed ${i.printCount} time${i.printCount === 1 ? '' : 's'}`}
                    >
                      ×{i.printCount}
                    </span>
                  )}
                </button>
                {/* A render in flight on an issue you are not looking at. The
                    middle column reports the selected one; without this a run
                    of five was four invisible builds and one visible. */}
                {working[i.number] && (
                  <span
                    className="text-muted-foreground shrink-0 text-[0.65rem]"
                    title={working[i.number].message}
                    aria-label={working[i.number].message}
                  >
                    {working[i.number].stalled ? 'queued' : WORKING_VERB[working[i.number].what]}
                  </span>
                )}
              </li>
            ))}
            {railIssues.length === 0 && (
              <li className="text-muted-foreground px-2 py-4 text-xs">
                {issues.length === 0 ? 'No issues yet. Open one.' : 'Nothing matches.'}
              </li>
            )}
          </ul>

          {/* What the ticks are for, and the only place any of it is offered.
              Three actions over one selection, each shown only for the part of
              it that can take it — so ticking four drafts and a locked issue
              offers to lock or rebuild the four and to order the one, and says
              which is which rather than silently doing the wrong subset. */}
          {ticked.length > 0 && (
            <div className="mt-2 grid gap-2 rounded-lg border p-2.5">
              <p className="text-muted-foreground text-xs">
                {ticked.map((n) => `#${n}`).join(', ')} selected.
              </p>

              {draftSelection.length > 0 && (
                <>
                  <Button
                    size="lg"
                    className="w-full justify-start"
                    disabled={busy || batch !== null}
                    onClick={() => void composeMany('lock', draftSelection)}
                  >
                    <Lock data-icon="inline-start" />
                    {batch?.what === 'lock'
                      ? `Locking ${batch.done + 1} of ${batch.total}…`
                      : `Lock ${countOf(draftSelection.length, 'draft')}`}
                  </Button>
                  <Button
                    size="lg"
                    variant="outline"
                    className="w-full justify-start"
                    disabled={busy || batch !== null}
                    onClick={() => void composeMany('rebuild', draftSelection)}
                  >
                    <RefreshCw data-icon="inline-start" />
                    {batch?.what === 'rebuild'
                      ? `Rebuilding ${batch.done + 1} of ${batch.total}…`
                      : `Rebuild ${countOf(draftSelection.length, 'draft')}`}
                  </Button>
                </>
              )}

              {/* Two issues in one Lulu job pay for one parcel instead of two,
                  and the dialog says how much that is before anything is
                  sent. */}
              {orderSelection.length > 0 && (
                <Button
                  size="lg"
                  variant={draftSelection.length > 0 ? 'outline' : 'default'}
                  className="w-full justify-start"
                  disabled={batch !== null}
                  onClick={() => setOrdering(orderSelection)}
                >
                  <Package data-icon="inline-start" />
                  Order {orderSelection.length === 1 ? `#${orderSelection[0]}` : `these ${orderSelection.length}`}
                  {orderSelection.length > 1 && ' — one parcel'}
                </Button>
              )}

              {draftSelection.length === 0 && orderSelection.length === 0 && (
                <p className="text-muted-foreground text-xs">
                  Nothing here can be locked, rebuilt or ordered as it stands.
                </p>
              )}

              <Button
                size="lg"
                variant="ghost"
                className="w-full justify-start"
                disabled={batch !== null}
                onClick={() => setTicked([])}
              >
                Clear the selection
              </Button>
            </div>
          )}

          <h2 className="text-muted-foreground mt-6 mb-2 text-xs font-medium tracking-wide uppercase">
            Pool · {pool.length}
          </h2>
          {/* Capped below `lg`, uncapped above it. At full width the pool sits
              in its own scrolling column and needs no limit; below `lg` the
              three columns stack, and an uncapped pool of a dozen articles
              pushed the issue — and every button that acts on it — a thousand
              pixels off the bottom of the screen. */}
          <div className="max-h-[22rem] overflow-y-auto lg:max-h-none lg:overflow-visible">
            <PoolPanel
              pool={pool}
              arriving={props.arriving}
              failed={props.failed}
              skipped={props.skipped}
              dropped={props.dropped}
              editable={editable}
              onError={setError}
              onNote={setNote}
              onRefresh={refresh}
            />
          </div>
        </aside>

        {/* ── The issue ────────────────────────────────────────────── */}
        {/* Its own column-height scroll, like the other two: the preview is
            the top half and the running order the bottom, and neither is worth
            much without the other in view. */}
        <section className="flex min-w-0 flex-col lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)] lg:overflow-y-auto">
          {issue ? (
            <IssuePanel
              issue={issue}
              editable={editable}
              locked={locked}
              working={working[issue.number]?.message ?? null}
              sheet={issue.hasCover ? sheet : 'interior'}
              previewOpen={previewOpen}
              onRemove={(itemId) => returnToPool(issue, itemId)}
              onRename={(name) => rename(issue.number, name)}
            />
          ) : (
            <p className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
              No issue selected. Open one with <span className="font-medium">New issue</span> on the right.
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

        {/* ── Making an issue · orders · settings ──────────────────── */}
        <aside className="min-w-0 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:self-start lg:overflow-y-auto lg:pl-1">
          <div className="mb-3 flex gap-1.5">
            {(['issue', 'orders', 'settings'] as const).map((t) => (
              <Toggle key={t} active={tab === t} onClick={() => setTab(t)} className="flex-1 capitalize">
                {t}
              </Toggle>
            ))}
          </div>

          {tab === 'issue' && (
            <div>
              {/* `busy`, not `locked`: opening an issue is not an edit to the
                  one being built, and a four-minute rebuild should not stop it. */}
              <Button
                size="lg"
                variant="outline"
                className="w-full justify-start"
                onClick={() => void newIssue()}
                disabled={busy}
              >
                <Plus data-icon="inline-start" />
                New issue
              </Button>

              {issue ? (
                <>
                  {/* The one action the workbench is for, at the top of the
                      column that holds every other action. It was a card in
                      the middle, where it competed with the pages themselves
                      for the space they both wanted. */}
                  <OrderCta
                    issue={issue}
                    locked={locked}
                    orderingEnabled={props.orderingEnabled}
                    canOrder={props.canOrder}
                    packageId={props.packageId}
                    onOrder={() => setOrdering([issue.number])}
                  />
                  <IssueActions
                    issue={issue}
                    editable={editable}
                    locked={locked}
                    working={working[issue.number] ?? null}
                    poolCount={pool.length}
                    threshold={props.threshold}
                    onAutoFill={autoFill}
                    onRebuild={() => void compose('rebuild', issue.number)}
                    onLock={() => void compose('lock', issue.number)}
                    onUnlock={() => void unlock(issue.number)}
                  />
                  <ShareControls
                    issue={issue}
                    handle={props.handle}
                    onError={setError}
                    onNote={setNote}
                    onRefresh={refresh}
                  />
                  <PreviewControls
                    issue={issue}
                    sheet={issue.hasCover ? sheet : 'interior'}
                    open={previewOpen}
                    onSheet={(s) => {
                      setSheet(s)
                      setPreviewOpen(true)
                    }}
                    onToggle={() => setPreviewOpen((v) => !v)}
                  />
                  {/* The built count is the true one; while the draft has moved
                      since, its measured pages are the better guess at how
                      thick this will come out. */}
                  <PageMeter
                    pages={issue.pages}
                    threshold={props.threshold}
                    printCount={issue.printCount}
                  />
                  <PrintSpec
                    packageId={props.packageId}
                    pageCount={issue.dirty || !issue.built ? issue.pages : issue.pageTotal}
                    estimated={issue.dirty || !issue.built}
                  />
                </>
              ) : (
                <p className="text-muted-foreground mt-3 rounded-lg border border-dashed p-4 text-center text-xs">
                  Select an issue to build one.
                </p>
              )}
            </div>
          )}
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

// ── The middle panel: the issue as it stands ─────────────────────────────────

function IssuePanel({
  issue,
  editable,
  locked,
  working,
  sheet,
  previewOpen,
  onRemove,
  onRename,
}: {
  issue: WorkbenchIssue
  editable: boolean
  /** An edit or a build is in flight; a second one would race it. */
  locked: boolean
  /** What the buttons on the right are doing, if anything. */
  working: string | null
  /** Which PDF to show. Set from the right-hand column. */
  sheet: Sheet
  /** Whether to show one at all, so the list can have the whole column. */
  previewOpen: boolean
  /** Send one article back to the pool, by id. */
  onRemove: (itemId: string) => void
  /** Give the issue a name of your own. Resolves to whether the server took it. */
  onRename: (name: string) => Promise<boolean>
}) {
  const { setNodeRef, isOver } = useDroppable({ id: 'issue', disabled: !editable })

  return (
    <div className="flex flex-col lg:min-h-0 lg:flex-1">
      {/* Beside the title, not under it: it is one line of facts about the
          same thing, and stacking it cost a row of height the preview wanted.
          Two page counts, and they mean different things — the articles as
          they stand right now, which every add and remove changes, and the PDF
          on file, which only a build changes. Then how many times this has
          been printed, which is what says a reorder is a reorder. */}
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <IssueTitle issue={issue} editable={editable && !locked} onRename={onRename} />
        <p className="text-muted-foreground text-xs">
          Issue {issue.number} · {STATE_LABEL[issue.state] ?? issue.state} ·{' '}
          <span className="text-foreground tabular-nums">{issue.pages}pp</span> of articles ·{' '}
          {issue.built ? `${issue.pageTotal}pp built${issue.dirty ? ', out of date' : ''}` : 'never built'} ·{' '}
          <span className="text-foreground tabular-nums">printed {issue.printCount}×</span>
        </p>
      </div>

      {issue.state === 'rejected' && (
        <p className="border-destructive/50 text-destructive mb-3 border-l-2 py-1 pl-3 text-xs">
          Lulu refused the files{issue.rejectionReason ? `: ${issue.rejectionReason}` : '.'} Unlock, fix, and lock again.
        </p>
      )}

      {issue.dirty && issue.built && editable && (
        <p className="border-muted-foreground/30 text-muted-foreground mb-3 border-l-2 py-1 pl-3 text-xs">
          The PDF on file is the previous build. Rebuild — or lock — to put these changes in print.
        </p>
      )}

      {working && (
        <p className="text-muted-foreground mb-3 text-xs" role="status" aria-live="polite">
          {working}…
        </p>
      )}

      {/* The top half: what it will look like printed. */}
      {previewOpen && (
        <div className="mb-3 flex flex-col lg:min-h-0 lg:flex-[1.6]">
          <IssuePreview
            issueNumber={issue.number}
            version={issue.updatedAt}
            sheet={sheet}
            built={issue.built}
          />
        </div>
      )}

      {/* The bottom half: what is in it, in order. */}
      <div
        ref={setNodeRef}
        className={`rounded-lg border lg:min-h-0 lg:flex-1 lg:overflow-y-auto ${
          isOver ? 'border-foreground border-dashed' : ''
        }`}
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
                      size="icon"
                      variant="ghost"
                      disabled={locked}
                      onClick={() => onRemove(entry.id)}
                      aria-label={`Remove ${entry.title} from issue ${issue.number}`}
                      title="Back to the pool"
                      className="text-muted-foreground hover:bg-muted hover:text-foreground self-center"
                    >
                      <ArrowLeft />
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

    </div>
  )
}

// ── How full the issue is ────────────────────────────────────────────────────

/**
 * The page meter, in the column that reports on the issue rather than under
 * the articles it measures.
 *
 * It sat at the foot of the middle panel, which meant it moved further down
 * the page with every article added — so the number that tells you whether to
 * add another was hardest to see exactly when the issue was nearly full. Up
 * here it is beside the print spec and the page count that spec is computed
 * from, which is the same question asked three ways.
 */
function PageMeter({
  pages,
  threshold,
  printCount,
}: {
  pages: number
  threshold: number
  /** How many orders have been placed for it and not refused. */
  printCount: number
}) {
  return (
    <div className="mt-3 rounded-lg border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground text-xs">Length</span>
        <span className="text-xs tabular-nums">
          {pages} / {threshold} pages
          {printCount > 0 && ` · printed ${printCount}×`}
        </span>
      </div>
      <div className="bg-muted mt-2 h-1.5 overflow-hidden rounded-full">
        <div
          className="bg-foreground h-full rounded-full transition-[width]"
          style={{ width: `${Math.min(100, (pages / threshold) * 100)}%` }}
        />
      </div>
    </div>
  )
}

// ── The one action the workbench is for ──────────────────────────────────────

/**
 * Ordering, stated as a step rather than hidden as a button.
 *
 * It began as the last control in the right-hand column, where nothing said
 * what would produce one on a draft; then as a card at the top of the middle
 * column, where it said so plainly but took a quarter of the height the pages
 * themselves wanted. Now it is the first thing in the column of actions —
 * still always present, still saying why when it cannot go ahead, and no
 * longer competing with the issue for the same space.
 *
 * The reasons are the client-side half of `orderBlockers` — the ones an issue
 * carries on its face. The dialog remains the authority and still checks the
 * address, the email and the orders already in flight, which only the server
 * can see.
 */
/**
 * What an issue is, for somebody who will print it themselves.
 *
 * The finish line for every account but V's. Ordering through Lulu bills the
 * one account on file, so a friend's press stops at two print-ready PDFs and a
 * spec — which is genuinely enough: it is what she uploads by hand when the
 * API is not involved.
 */
function TakeItToAPrinter({ issue, packageId }: { issue: WorkbenchIssue; packageId: string }) {
  if (issue.state === 'open') {
    return (
      <div className="bg-muted/40 mt-3 rounded-lg border p-3">
        <p className="text-sm font-medium">To get this printed</p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          Lock it first. Locking freezes the contents and builds the two PDFs a printer needs —
          you can unlock again afterwards.
        </p>
      </div>
    )
  }
  if (!issue.built) return null

  const href = (file: string) =>
    `/api/press/file/${issue.number}/${file}?v=${encodeURIComponent(issue.updatedAt)}`

  return (
    <div className="bg-muted/40 mt-3 rounded-lg border p-3">
      <p className="text-sm font-medium">Ready for a printer</p>
      <p className="text-muted-foreground mt-0.5 mb-2.5 text-xs">
        Two files: the pages, and the wrap. Upload both to Lulu — or any printer who takes a PDF —
        with the spec below.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <a
          className="bg-foreground text-background flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium"
          href={href('interior.pdf')}
          target="_blank"
          rel="noreferrer"
        >
          <FileText className="size-4" />
          Interior
        </a>
        <a
          className="hover:bg-muted flex h-9 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-medium"
          href={href('cover.pdf')}
          target="_blank"
          rel="noreferrer"
          aria-disabled={!issue.hasCover}
        >
          <BookImage className="size-4" />
          Cover
        </a>
      </div>
      <div className="mt-3">
        <PrintSpec packageId={packageId} pageCount={issue.pageTotal} />
      </div>
    </div>
  )
}

function OrderCta({
  issue,
  locked,
  orderingEnabled,
  canOrder,
  packageId,
  onOrder,
}: {
  issue: WorkbenchIssue
  locked: boolean
  orderingEnabled: boolean
  canOrder: boolean
  packageId: string
  onOrder: () => void
}) {
  // No Lulu account, so no order button — absent rather than disabled with a
  // tooltip, because a button that exists and refuses is a support question.
  // What replaces it is the thing a friend actually wants: the two files, and
  // enough of a spec to hand them to a printer.
  if (!canOrder) return <TakeItToAPrinter issue={issue} packageId={packageId} />
  // The built count where there is one: it is the number Lulu will bind.
  const pages = issue.built && !issue.dirty ? issue.pageTotal : issue.pages
  const reasons: string[] = []

  if (pages < PRINT_SPEC.minPages) {
    reasons.push(
      `Lulu will not perfect-bind under ${PRINT_SPEC.minPages} pages, and this is ${pages}. ` +
        `Drag ${PRINT_SPEC.minPages - pages} more pages in from the pool.`,
    )
  }
  if (!orderingEnabled) {
    reasons.push(
      'Ordering is switched off. PRESS_ORDER_ENABLED=1 in the environment is what allows a real order, and it is not settable from this screen.',
    )
  }

  const blocked = reasons.length > 0

  // A draft is not blocked, it is unfinished: locking is the next step, and
  // that button is directly below this — one Lock, in the list of actions,
  // rather than a second one dressed as an order.
  if (issue.state === 'open') {
    return (
      <div className="bg-muted/40 mt-3 rounded-lg border p-3">
        <p className="text-sm font-medium">To order a printed copy</p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          Lock it first. Locking freezes the contents and builds the PDF that gets printed — you
          can unlock again afterwards.
        </p>
        {blocked && <Reasons reasons={reasons} heading="And before it can be ordered:" />}
      </div>
    )
  }

  if (!orderable(issue.state)) return null

  return (
    <div className="bg-muted/40 mt-3 rounded-lg border p-3">
      <Button
        size="lg"
        className="w-full justify-start"
        disabled={locked || blocked}
        onClick={onOrder}
      >
        <Package data-icon="inline-start" />
        {issue.state === 'shipped' ? 'Order another copy' : 'Order a copy'}
      </Button>
      <p className="text-muted-foreground mt-2 text-xs">
        The next screen prices it and sends an approval email. Nothing is ordered until you follow
        the link in that email.
      </p>
      {blocked && <Reasons reasons={reasons} />}
    </div>
  )
}

function Reasons({ reasons, heading }: { reasons: string[]; heading?: string }) {
  return (
    <div className="mt-3 border-t pt-3">
      {heading && <p className="text-muted-foreground mb-1 text-xs font-medium">{heading}</p>}
      <ul className="text-muted-foreground space-y-1 text-xs">
        {reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  )
}

// ── The right panel: what you can do to it ───────────────────────────────────

/**
 * Every action an issue has, stacked and full width.
 *
 * They used to sit as a row of extra-small ghost buttons beside the issue's
 * title, where the one that mattered — Rebuild, on an issue whose PDF no longer
 * matched its contents — looked exactly like the ones that did not. Here the
 * order is the order they are used in: fill it, build it, freeze it, print it.
 */
/**
 * The issue's name, and the way to change it.
 *
 * A pencil beside the title rather than a form in the right-hand column: the
 * name is the one thing on the workbench that is *about* the issue and not an
 * action on it, and it should be edited where it is read. Enter or blur saves,
 * Escape puts back what was there, and an empty field is allowed — it asks
 * the next build to name the issue again.
 *
 * Only a moving draft can be renamed; once locked, the name is frozen with the
 * contents it describes, and the pencil goes away rather than saying no.
 */
function IssueTitle({
  issue,
  editable,
  onRename,
}: {
  issue: WorkbenchIssue
  editable: boolean
  onRename: (name: string) => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(issue.name)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // Escape after a blur-save is the one order of events that would save twice.
  const settledRef = useRef(false)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const start = () => {
    settledRef.current = false
    setDraft(issue.name)
    setEditing(true)
  }

  const cancel = () => {
    settledRef.current = true
    setEditing(false)
  }

  const save = async () => {
    if (settledRef.current || busy) return
    settledRef.current = true
    // The same name is not a rename, and the fallback title is not a name.
    if (draft.trim() === issue.name || (draft.trim() === '' && issue.name === `Issue ${issue.number}`)) {
      setEditing(false)
      return
    }
    setBusy(true)
    try {
      const ok = await onRename(draft)
      if (ok) setEditing(false)
      else settledRef.current = false
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          }
        }}
        disabled={busy}
        maxLength={48}
        aria-label="Issue name"
        placeholder={`Issue ${issue.number}`}
        className={`${FIELD} h-10 max-w-md font-serif text-2xl`}
      />
    )
  }

  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <h2 className="font-serif text-2xl">{issue.name}</h2>
      {editable && (
        <button
          type="button"
          onClick={start}
          aria-label="Rename issue"
          title="Rename"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 self-center rounded p-1 focus-visible:ring-3 focus-visible:outline-none"
        >
          <Pencil className="size-4" />
        </button>
      )}
    </span>
  )
}

function IssueActions({
  issue,
  editable,
  locked,
  working,
  poolCount,
  threshold,
  onAutoFill,
  onRebuild,
  onLock,
  onUnlock,
}: {
  issue: WorkbenchIssue
  editable: boolean
  locked: boolean
  working: Working | null
  poolCount: number
  threshold: number
  onAutoFill: () => void
  onRebuild: () => void
  onLock: () => void
  onUnlock: () => void
}) {
  const empty = issue.contents.length === 0

  return (
    <div className="mt-3 grid gap-2 rounded-lg border p-3">
      {editable && (
        <>
          <Button
            size="lg"
            variant="outline"
            className="w-full justify-start"
            disabled={locked || poolCount === 0}
            onClick={onAutoFill}
            title={`Add from the pool, oldest first, up to ${threshold} pages`}
          >
            <Sparkles data-icon="inline-start" />
            Auto-fill
          </Button>
          {/* The one button whose weight should change: a draft that has moved
              since its last build is the whole reason to press it. */}
          <Button
            size="lg"
            variant={issue.dirty ? 'default' : 'outline'}
            className="w-full justify-start"
            disabled={locked || empty}
            onClick={onRebuild}
            title={empty ? 'Nothing to render yet' : undefined}
          >
            <RefreshCw data-icon="inline-start" />
            {working?.what === 'rebuild' ? 'Rebuilding…' : issue.dirty ? 'Rebuild' : 'Rebuild anyway'}
          </Button>
          <Button
            size="lg"
            variant={issue.dirty ? 'outline' : 'default'}
            className="w-full justify-start"
            disabled={locked || empty}
            onClick={onLock}
          >
            <Lock data-icon="inline-start" />
            {working?.what === 'lock' ? 'Locking…' : 'Lock for printing'}
          </Button>
        </>
      )}

      {/* Ordering is not here any more: it is the card at the top of the issue,
          where it is one button in one place rather than the last control in
          the column that stacks last. What stays is its opposite — the way
          back out of a locked issue. */}
      {issue.state === 'closed' && (
        <Button size="lg" variant="outline" className="w-full justify-start" disabled={locked} onClick={onUnlock}>
          <LockOpen data-icon="inline-start" />
          {working?.what === 'unlock' ? 'Unlocking…' : 'Unlock to edit'}
        </Button>
      )}

    </div>
  )
}

// ── What the middle column is showing ────────────────────────────────────────

/**
 * The preview's controls, stacked in the column where the controls live.
 *
 * They were a row across the top of the preview — two sheet tabs, a note, an
 * open-in-a-tab link and a hide toggle — which is a strip of chrome sitting
 * exactly where the pages want to be. Vertical and over here they cost the
 * viewer nothing, and the cover finally has a button that both shows it and
 * links to it, which is what it lacked for weeks.
 */
/**
 * Hand the issue to somebody.
 *
 * One switch, not two. "Anyone with the link" and "listed on my shelf" sound
 * like different settings and are not — the shelf at /press/by/<handle> is a
 * page anyone can open — so offering both would be a privacy control that does
 * not do what it says.
 *
 * Only for a built issue: a shared draft is a page offering a PDF that does
 * not exist, and the reader cannot tell that from a broken link. The route
 * refuses it too; this is so the button is not there to be pressed.
 */
function ShareControls({
  issue,
  handle,
  onError,
  onNote,
  onRefresh,
}: {
  issue: WorkbenchIssue
  handle: string
  onError: (m: string | null) => void
  onNote: (m: string | null) => void
  onRefresh: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  if (!issue.built) return null

  const path = `/press/i/${handle}/${issue.number}`

  const toggle = async () => {
    setBusy(true)
    onError(null)
    onNote(null)
    try {
      const res = await fetch(`/api/press/issue/${issue.number}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shared: !issue.shared }),
      })
      const body = await readJson(res)
      if (!res.ok) onError(body.error ?? 'Could not change that.')
      else {
        onNote(issue.shared ? 'No longer readable.' : 'Anyone with the link can read it.')
        onRefresh()
      }
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${path}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked — the link is written out below either way, so
      // there is always something to select by hand.
      onError('Could not copy. The link is below.')
    }
  }

  return (
    <div className="mt-3 grid gap-2 rounded-lg border p-3">
      <Toggle active={issue.shared} onClick={() => void toggle()} disabled={busy} className="w-full justify-start">
        {issue.shared ? <Link2 className="size-4" /> : <Link2Off className="size-4" />}
        {issue.shared ? 'Anyone with the link' : 'Share this issue'}
      </Toggle>
      {issue.shared && (
        <>
          <button
            type="button"
            onClick={() => void copy()}
            className="hover:bg-muted text-muted-foreground hover:text-foreground flex h-9 items-center gap-1.5 rounded-lg border px-3 text-left text-xs font-medium"
          >
            <Copy className="size-4 shrink-0" />
            <span className="truncate">{copied ? 'Copied' : path}</span>
          </button>
          <p className="text-muted-foreground text-xs">
            The contents and the PDF, and nothing else — no pool, no drafts, and nothing anyone
            can change.
          </p>
        </>
      )}
    </div>
  )
}

function PreviewControls({
  issue,
  sheet,
  open,
  onSheet,
  onToggle,
}: {
  issue: WorkbenchIssue
  sheet: Sheet
  open: boolean
  onSheet: (sheet: Sheet) => void
  onToggle: () => void
}) {
  if (!issue.built) return null

  const href = (file: string) =>
    `/api/press/file/${issue.number}/${file}?v=${encodeURIComponent(issue.updatedAt)}`

  return (
    <div className="mt-3 grid gap-2 rounded-lg border p-3">
      <Toggle
        active={open && sheet === 'interior'}
        onClick={() => onSheet('interior')}
        className="w-full justify-start"
      >
        <FileText className="size-4" />
        Interior
      </Toggle>
      <Toggle
        active={open && sheet === 'cover'}
        onClick={() => onSheet('cover')}
        disabled={!issue.hasCover}
        className="w-full justify-start"
        title={issue.hasCover ? 'The wrap — back, spine, front' : 'No cover built yet'}
      >
        <BookImage className="size-4" />
        Cover
      </Toggle>
      <a
        className="hover:bg-muted text-muted-foreground hover:text-foreground flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium"
        href={href(sheet === 'cover' && issue.hasCover ? 'cover.pdf' : 'interior.pdf')}
        target="_blank"
        rel="noreferrer"
      >
        <ExternalLink className="size-4" />
        Open in a new tab
      </a>
      <Toggle active={false} onClick={onToggle} className="w-full justify-start">
        {open ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        {open ? 'Hide the preview' : 'Show the preview'}
      </Toggle>
      <p className="text-muted-foreground text-xs">
        {sheet === 'cover' ? 'One spread — back, spine, front.' : 'Contents and articles.'}
        {issue.dirty && ' Older than the list beside it.'}
      </p>
    </div>
  )
}
