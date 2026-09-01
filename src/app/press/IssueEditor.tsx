'use client'

/**
 * press — the issue editor.
 *
 * Two lists that share a pool of articles: what is in the issue, in the order
 * it will be printed, and what is still waiting in `hw`. Drag to reorder,
 * remove to send an article back to the waiting list, add to pull one forward.
 *
 * Every edit is a round trip: the server owns `.press/state.json` and
 * re-validates against it, so the optimistic update here is rolled back if the
 * server disagrees — which it will if `press-run` has been busy in another
 * terminal.
 *
 * Nothing here re-renders a PDF. Edits leave the built issue stale on purpose
 * (a hundred pages is minutes of Chromium) and "Rebuild" is what reconciles
 * them; until it is pressed the page says so plainly.
 */

import { useCallback, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { IssueEntry } from '@/lib/press/local'

export interface WaitingItem {
  id: string
  title: string | null
  url: string
  pageCount: number
}

interface EditorProps {
  issueNumber: number
  contents: IssueEntry[]
  waiting: WaitingItem[]
  /** The draft and the PDFs on disk disagree. */
  dirty: boolean
  /** The issue has been rendered at least once. */
  built: boolean
  /** Pages of articles that close an issue, from PRESS_PAGE_THRESHOLD. */
  threshold: number
}

interface EditResponse {
  contents: IssueEntry[]
  waiting: WaitingItem[]
  dirty: boolean
  error?: string
}

/** What GET /order answers with: the price, and whether pressing order is real. */
interface PrintQuote {
  quote: string
  pageCount: number
  sandbox: boolean
  liveOrderingEnabled: boolean
}

type Action =
  | { action: 'reorder'; itemIds: string[] }
  | { action: 'remove'; itemId: string }
  | { action: 'add'; itemId: string }

function hostOf(url: string | null): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

// -- One draggable row --------------------------------------------------------

function ContentsRow({
  entry,
  position,
  busy,
  onRemove,
}: {
  entry: IssueEntry
  position: number
  busy: boolean
  onRemove: (itemId: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.itemId,
  })

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`bg-background flex items-baseline gap-3 px-2 py-3 ${
        isDragging ? 'relative z-10 rounded-md shadow-lg' : ''
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${entry.title}`}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -my-1 cursor-grab touch-none self-center rounded p-1 focus-visible:ring-3 focus-visible:outline-none active:cursor-grabbing"
      >
        <GripVertical className="size-4" />
      </button>

      <span className="text-muted-foreground w-10 shrink-0 text-right text-xs tabular-nums">
        {/* Page numbers come from the last build, so they are only shown while
            the draft still matches it; otherwise the running order stands in. */}
        {entry.startPage === null ? `${position}.` : `p.${entry.startPage}`}
      </span>

      <span className="min-w-0 flex-1">
        {entry.url ? (
          <a href={entry.url} target="_blank" rel="noreferrer" className="font-serif hover:underline">
            {entry.title}
          </a>
        ) : (
          <span className="font-serif">{entry.title}</span>
        )}
        <span className="text-muted-foreground block text-xs">
          {[entry.byline, entry.sourceName]
            .filter((p): p is string => Boolean(p))
            .filter((p, i, all) => all.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i)
            .join(' · ') || hostOf(entry.url)}
        </span>
      </span>

      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {entry.pageCount}pp
      </span>

      <Button
        variant="ghost"
        size="icon-xs"
        disabled={busy}
        onClick={() => onRemove(entry.itemId)}
        aria-label={`Remove ${entry.title} from the issue`}
        className="text-muted-foreground hover:text-destructive self-center"
      >
        <X />
      </Button>
    </li>
  )
}

// -- The editor ---------------------------------------------------------------

export function IssueEditor(props: EditorProps) {
  const router = useRouter()
  const [contents, setContents] = useState(props.contents)
  const [waiting, setWaiting] = useState(props.waiting)
  const [dirty, setDirty] = useState(props.dirty)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)
  const [quoting, setQuoting] = useState(false)
  const [ordering, setOrdering] = useState(false)
  const [quote, setQuote] = useState<PrintQuote | null>(null)
  const [, startTransition] = useTransition()

  // The order the server last agreed to, so a rejected drag can be put back.
  const committed = useRef(props.contents)

  const sensors = useSensors(
    // A few pixels of slop, or the drag handle can never be clicked.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const pages = useMemo(() => contents.reduce((n, e) => n + e.pageCount, 0), [contents])

  const send = useCallback(async (edit: Action) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/press/issue/${props.issueNumber}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(edit),
      })
      const body = (await res.json()) as EditResponse
      if (!res.ok) {
        setError(body.error ?? 'The edit did not stick.')
        setContents(committed.current)
        return
      }
      committed.current = body.contents
      setContents(body.contents)
      setWaiting(body.waiting)
      setDirty(body.dirty)
    } catch (err) {
      setError((err as Error).message)
      setContents(committed.current)
    } finally {
      setBusy(false)
    }
  }, [props.issueNumber])

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = contents.findIndex((e) => e.itemId === active.id)
    const to = contents.findIndex((e) => e.itemId === over.id)
    if (from === -1 || to === -1) return

    // Move it now and confirm afterwards; a drag that snaps back on every
    // round trip is unusable.
    const next = arrayMove(contents, from, to)
    setContents(next)
    void send({ action: 'reorder', itemIds: next.map((e) => e.itemId) })
  }

  const rebuild = async () => {
    setBuilding(true)
    setError(null)
    setProgress('Starting')
    try {
      const res = await fetch(`/api/press/issue/${props.issueNumber}/rebuild`, { method: 'POST' })
      if (!res.body) throw new Error('No response from the builder.')

      // NDJSON: one JSON object per line, and a line can arrive in pieces.
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
          if (event.progress) setProgress(event.progress)
          if (event.error) setError(event.error)
          if (event.done) {
            const { name, pageCount, preflight } = event.done
            setProgress(
              `Built “${name}” — ${pageCount} pages, preflight ` +
                `${preflight.length ? preflight.map((p) => p.code).join(', ') : 'clean'}`,
            )
            setDirty(false)
            // The PDF, its page numbers and its name all changed on disk; the
            // server component is the only thing that knows the new ones.
            startTransition(() => router.refresh())
          }
        }
      }
    } catch (err) {
      setError((err as Error).message)
      setProgress(null)
    } finally {
      setBuilding(false)
    }
  }

  // ── Printing ───────────────────────────────────────────────────────────────

  const quoteForPrint = async () => {
    setQuoting(true)
    setError(null)
    try {
      const res = await fetch(`/api/press/issue/${props.issueNumber}/order`)
      const body = (await res.json()) as PrintQuote & { error?: string }
      if (!res.ok) {
        setError(body.error ?? 'Could not get a quote.')
        return
      }
      setQuote(body)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setQuoting(false)
    }
  }

  const placeOrder = async () => {
    setOrdering(true)
    setError(null)
    try {
      const res = await fetch(`/api/press/issue/${props.issueNumber}/order`, { method: 'POST' })
      const body = (await res.json()) as {
        jobId?: string
        status?: string
        sandbox?: boolean
        error?: string
      }
      if (!res.ok) {
        setError(body.error ?? 'The order did not go through.')
        return
      }
      setQuote(null)
      setProgress(
        `${body.sandbox ? 'Test order' : 'Ordered'} — Lulu job ${body.jobId} (${body.status})`,
      )
      startTransition(() => router.refresh())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setOrdering(false)
    }
  }

  const locked = busy || building

  return (
    <div className="mt-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">
          {contents.length} article{contents.length === 1 ? '' : 's'} · {pages} of {props.threshold} pages
          {dirty && (
            <span className="text-foreground">
              {' · '}
              {props.built ? 'edited since the last build' : 'never built'}
            </span>
          )}
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant={dirty ? 'default' : 'outline'} disabled={locked || contents.length === 0} onClick={rebuild}>
            {building ? 'Rebuilding…' : dirty ? 'Rebuild' : 'Rebuild anyway'}
          </Button>
          {/* Printing an edited issue would bind the *previous* PDF, so this
              stays shut until a rebuild has caught the contents up. */}
          <Button
            size="sm"
            variant={dirty ? 'outline' : 'default'}
            disabled={locked || dirty || contents.length === 0}
            onClick={quoteForPrint}
            title={dirty ? 'Rebuild first — the PDF does not match these contents' : undefined}
          >
            {quoting ? 'Getting a quote…' : 'Print…'}
          </Button>
        </div>
      </div>

      {/* The quote is always shown before anything is ordered, and ordering is
          a second, separate press. */}
      {quote && (
        <div className="mb-3 rounded-lg border p-3 text-xs">
          <p className="text-foreground">
            {quote.quote} · {quote.pageCount} pages
          </p>
          <p className="text-muted-foreground mt-1">
            {quote.sandbox
              ? 'Sandbox — this places a test order with Lulu and prints nothing.'
              : quote.liveOrderingEnabled
                ? 'This orders a real printed copy and charges the card on file.'
                : 'Live ordering is switched off (PRESS_ORDER_ENABLED).'}
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="xs" disabled={ordering} onClick={placeOrder}>
              {ordering ? 'Ordering…' : quote.sandbox ? 'Place test order' : 'Order a copy'}
            </Button>
            <Button size="xs" variant="ghost" disabled={ordering} onClick={() => setQuote(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {dirty && props.built && (
        <p className="border-muted-foreground/30 text-muted-foreground mb-3 border-l-2 py-1 pl-3 text-xs">
          The PDF above is the previous build. Rebuild to see these changes in print.
        </p>
      )}

      {progress && (
        <p className="text-muted-foreground mb-3 text-xs" role="status" aria-live="polite">
          {building ? `${progress}…` : progress}
        </p>
      )}

      {error && (
        <p className="text-destructive mb-3 text-xs" role="alert">
          {error}
        </p>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={contents.map((e) => e.itemId)} strategy={verticalListSortingStrategy}>
          <ol className="divide-y rounded-lg border">
            {contents.map((entry, i) => (
              <ContentsRow
                key={entry.itemId}
                entry={entry}
                position={i + 1}
                busy={locked}
                onRemove={(itemId) => void send({ action: 'remove', itemId })}
              />
            ))}
            {contents.length === 0 && (
              <li className="text-muted-foreground px-4 py-6 text-center text-sm">
                Empty. Add something from the waiting list below.
              </li>
            )}
          </ol>
        </SortableContext>
      </DndContext>

      <section className="mt-8">
        <h3 className="font-serif text-lg">
          Waiting{' '}
          <span className="text-muted-foreground font-sans text-sm">
            {waiting.length} article{waiting.length === 1 ? '' : 's'}
          </span>
        </h3>
        <div className="bg-muted mt-3 h-1.5 w-full overflow-hidden rounded-full">
          <div
            className="bg-foreground h-full rounded-full transition-[width]"
            style={{ width: `${Math.min(100, (pages / props.threshold) * 100)}%` }}
          />
        </div>
        <ol className="mt-3 divide-y rounded-lg border">
          {waiting.map((item) => (
            <li key={item.id} className="flex items-baseline gap-3 px-4 py-3">
              <span className="min-w-0 flex-1">
                <a href={item.url} target="_blank" rel="noreferrer" className="font-serif hover:underline">
                  {item.title ?? item.url}
                </a>
                <span className="text-muted-foreground block text-xs">{hostOf(item.url)}</span>
              </span>
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {item.pageCount || '?'}pp
              </span>
              <Button
                variant="ghost"
                size="xs"
                disabled={locked}
                onClick={() => void send({ action: 'add', itemId: item.id })}
                className="text-muted-foreground hover:text-foreground self-center"
              >
                <Plus data-icon="inline-start" />
                Add
              </Button>
            </li>
          ))}
          {waiting.length === 0 && (
            <li className="text-muted-foreground px-4 py-6 text-center text-sm">
              Nothing waiting. Save something to hw.
            </li>
          )}
        </ol>
      </section>
    </div>
  )
}
