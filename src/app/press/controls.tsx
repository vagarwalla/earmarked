'use client'

/**
 * press — the small controls the workbench repeats.
 *
 * Filters, tabs and piles were each a hand-rolled `<button>` with its own
 * padding and its own text size: `px-2 py-1 text-xs` in one place, `px-2.5
 * py-1.5` in another, and the same "on" state written four different ways.
 * Three of them ended up smaller than the fingertip that has to hit them.
 *
 * One toggle, one height, one on-state — the same 36px as `size="lg"` on
 * `Button`, so a row of chips and a row of buttons line up.
 */

import { cn } from '@/lib/utils'

/**
 * A toggle in a group: a filter, a tab, a pile.
 *
 * `aria-pressed` rather than a role, because every group here is a set of
 * independent switches over one list rather than a tablist with panels.
 */
export function Toggle({
  active,
  disabled,
  onClick,
  className,
  children,
  ...rest
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  className?: string
  children: React.ReactNode
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'className' | 'children'>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        'focus-visible:ring-ring/50 inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-medium whitespace-nowrap transition-colors select-none focus-visible:ring-3 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40',
        active
          ? 'bg-foreground text-background border-foreground'
          : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/** The search boxes, which were three different heights. */
export const FIELD =
  'bg-background focus-visible:ring-ring/50 h-9 w-full rounded-lg border px-3 text-sm focus-visible:ring-3 focus-visible:outline-none'
