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
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Lock,
  LockOpen,
  Package,
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
 * What the issue's buttons are doing, and the line they are reporting.
 *
 * `number` is carried because a render no longer happens inside the request
 * that asked for it: one queued for issue 4 goes on running while you open
 * issue 5, and without this its progress would light up issue 5's buttons and
 * freeze a panel that has nothing to do with it.
 */
interface Working {
  what: 'rebuild' | 'lock' | 'unlock'
  number: number
  message: string
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
  settings: SettingsProps
  threshold: number
  /** Lulu POD package id, decoded for the print-spec panel. */
  packageId: string
  /** PRESS_ORDER_ENABLED. Shown, never set, from here. */
  orderingEnabled: boolean
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
    if (working !== null) return

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
  /**
   * What the issue's buttons are doing, and the line they are streaming.
   *
   * Lifted out of the issue panel because the buttons and the progress they
   * report now live in different columns — the actions on the right, the issue
   * itself in the middle. `what` is carried alongside the message so only the
   * button that was pressed says it is working; a single boolean made Lock
   * announce a rebuild.
   */
  const [working, setWorking] = useState<Working | null>(null)

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
    async (jobId: string, what: 'rebuild' | 'lock', number: number) => {
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
          setWorking({ what, number, message: (err as Error).message })
          continue
        }
        if (!job) {
          setError('That render is no longer on the queue.')
          return
        }
        if (job.state === 'failed') {
          setError(job.error ?? 'The render failed.')
          return
        }
        if (job.state === 'done') {
          if (job.result) announce(job.result)
          refresh()
          return
        }
        setWorking({ what, number, message: job.progress ?? 'Working' })
      }
    },
    [announce, refresh],
  )

  /**
   * Ask for a compose, and follow it whichever way it happens.
   *
   * Two shapes come back. On the machine with `.press/`, the build runs inside
   * the request and streams NDJSON. Deployed, there is no browser: the route
   * answers 202 with a job row the worker will claim, and this polls it. One
   * button, one route, and the difference is which response arrives.
   */
  const compose = async (what: 'rebuild' | 'lock', number: number, body?: object) => {
    const url =
      what === 'lock' ? `/api/press/issue/${number}/lock` : `/api/press/issue/${number}/rebuild`
    setWorking({ what, number, message: 'Starting' })
    setError(null)
    setNote(null)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      const isJson = res.headers.get('content-type')?.includes('application/json')
      // A refusal — an empty issue, an article this machine cannot render, a
      // render already in flight — arrives as JSON, not as a stream.
      if (!res.ok && isJson) {
        const err = (await res.json()) as { error?: string }
        setError(err.error ?? 'That did not work.')
        return
      }
      if (res.status === 202 && isJson) {
        const { job } = (await res.json()) as { job: PressJobView }
        setWorking({ what, number, message: job.progress ?? 'Queued' })
        await track(job.id, what, number)
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
          if (event.progress) setWorking({ what, number, message: event.progress })
          if (event.error) setError(event.error)
          if (event.done) {
            announce(event.done)
            refresh()
          }
        }
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setWorking(null)
    }
  }

  /**
   * Pick up a render that was already in flight when this page loaded.
   *
   * The point of composing on the worker is that it survives the tab that
   * asked for it — pressed on a phone, watched on a laptop, or simply reloaded
   * halfway through. Without this the page shows an idle Rebuild button over a
   * machine four minutes into a hundred pages, and pressing it earns a refusal
   * from the one-live-job index rather than the progress that already exists.
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
        const live = jobs[0]
        if (!live) return
        const number = props.issues.find((i) => i.id === live.issue_id)?.number
        if (number === undefined) return
        setWorking({ what: live.intent, number, message: live.progress ?? 'Working' })
        await track(live.id, live.intent, number)
      } catch {
        // Nothing to recover, and nothing worth saying about it: the buttons
        // work either way, and a render nobody is watching still finishes.
      } finally {
        setWorking(null)
      }
    })()
  }, [props.issues, track])

  const unlock = async (number: number) => {
    setWorking({ what: 'unlock', number, message: 'Unlocking' })
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
      setWorking(null)
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
  const locked = busy || (working !== null && working.number === issue?.number)

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
                    ticking an issue must not also select it for editing. */}
                {orderable(i.state) ? (
                  <input
                    type="checkbox"
                    className="size-4 shrink-0"
                    checked={bundle.includes(i.number)}
                    onChange={(e) =>
                      setBundle((b) =>
                        e.target.checked ? [...b, i.number].sort((x, y) => x - y) : b.filter((n) => n !== i.number),
                      )
                    }
                    aria-label={`Order issue ${i.number} with others`}
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
            <div className="mt-2 rounded-lg border p-2.5">
              <p className="text-muted-foreground text-xs">
                {selection.length === 1
                  ? `Issue ${selection[0]} selected. Tick another to share one parcel.`
                  : `${selection.map((n) => `#${n}`).join(', ')} — one job, one shipping charge.`}
              </p>
              <div className="mt-2 flex gap-2">
                <Button size="lg" className="flex-1" onClick={() => setOrdering(selection)}>
                  <Package data-icon="inline-start" />
                  Order {selection.length === 1 ? 'it' : `these ${selection.length}`}
                </Button>
                <Button size="lg" variant="outline" onClick={() => setBundle([])}>
                  Clear
                </Button>
              </div>
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
              working={working?.message ?? null}
              sheet={issue.hasCover ? sheet : 'interior'}
              previewOpen={previewOpen}
              onRemove={(itemId) => returnToPool(issue, itemId)}
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
                    onOrder={() => setOrdering([issue.number])}
                  />
                  <IssueActions
                    issue={issue}
                    editable={editable}
                    locked={locked}
                    working={working}
                    poolCount={pool.length}
                    threshold={props.threshold}
                    onAutoFill={autoFill}
                    onRebuild={() => void compose('rebuild', issue.number)}
                    onLock={() => void compose('lock', issue.number, { action: 'lock' })}
                    onUnlock={() => void unlock(issue.number)}
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
        <h2 className="font-serif text-2xl">{issue.name}</h2>
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
function OrderCta({
  issue,
  locked,
  orderingEnabled,
  onOrder,
}: {
  issue: WorkbenchIssue
  locked: boolean
  orderingEnabled: boolean
  onOrder: () => void
}) {
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
