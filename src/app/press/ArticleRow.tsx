'use client'

/**
 * press — one article, wherever it is.
 *
 * The same row in the issue and in the pool, because it is the same thing in
 * both: an issue is an arrangement of the pool, not a different kind of
 * container. What changes between them is the affordance — a number and a grip
 * in the issue, a delete in the pool — and not the article.
 */

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import type { PoolItem } from './Workbench'

export function hostOf(url: string | null): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Byline and publication, minus the duplicate a personal blog produces. */
export function articleMeta(item: PoolItem): string {
  const parts = [item.byline, item.sourceName].filter((p): p is string => Boolean(p))
  const unique = parts.filter(
    (p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i,
  )
  return unique.join(' · ') || hostOf(item.url)
}

export function articleLabel(item: PoolItem): string {
  return `${item.title}${item.pageCount ? ` · ${item.pageCount}pp` : ''}`
}

export function ArticleRow({
  item,
  index,
  draggable,
  trailing,
}: {
  item: PoolItem
  /** Position in the running order. Absent in the pool, which has no order. */
  index?: number
  draggable: boolean
  trailing?: React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: !draggable,
  })

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`bg-background flex items-baseline gap-2 px-2 py-2.5 ${
        isDragging ? 'relative z-10 rounded-md opacity-40' : ''
      }`}
    >
      {draggable && (
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Move ${item.title}`}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -my-1 cursor-grab touch-none self-center rounded p-1 focus-visible:ring-3 focus-visible:outline-none active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" />
        </button>
      )}

      {index !== undefined && (
        <span className="text-muted-foreground w-5 shrink-0 text-right text-xs tabular-nums">{index}</span>
      )}

      <span className="min-w-0 flex-1">
        {item.url ? (
          <a href={item.url} target="_blank" rel="noreferrer" className="font-serif text-sm hover:underline">
            {item.title}
          </a>
        ) : (
          <span className="font-serif text-sm">{item.title}</span>
        )}
        <span className="text-muted-foreground block truncate text-xs">
          {item.reason ? item.reason : articleMeta(item)}
        </span>
      </span>

      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {item.pageCount || '?'}pp
      </span>

      {trailing}
    </li>
  )
}
