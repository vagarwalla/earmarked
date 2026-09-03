'use client'

/**
 * press — one article, wherever it is.
 *
 * The same row in the issue and in the pool, because it is the same thing in
 * both: an issue is an arrangement of the pool, not a different kind of
 * container. What changes between them is the affordance — a number, a grip and
 * a way back to the pool in the issue, a delete in the pool — and not the
 * article.
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
  dense = false,
  trailing,
}: {
  item: PoolItem
  /** Position in the running order. Absent in the pool, which has no order. */
  index?: number
  draggable: boolean
  /**
   * The pool's rows, which are a list to scan rather than a list to read.
   * Same two lines, tighter — enough to see several more articles at once
   * without dropping the byline that tells them apart.
   */
  dense?: boolean
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
      className={`bg-background flex items-baseline gap-2 px-2 ${dense ? 'py-1' : 'py-1.5'} ${
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

      <span className="min-w-0 flex-1 leading-snug">
        {item.url ? (
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="block truncate font-serif text-sm hover:underline"
          >
            {item.title}
          </a>
        ) : (
          <span className="block truncate font-serif text-sm">{item.title}</span>
        )}
        <span
          className={`text-muted-foreground block truncate ${dense ? 'text-[0.7rem] leading-snug' : 'text-xs'}`}
        >
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
