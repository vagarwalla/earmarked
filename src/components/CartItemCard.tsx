'use client'

import { useState, useEffect } from 'react'
import { X, RefreshCw, Minus, Plus, Star, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { CartItem, Condition, Format } from '@/lib/types'

const OL_COVERS = 'https://covers.openlibrary.org'

function EditionStrip({
  item,
  onRemoveCandidate,
  onChangeCover,
}: {
  item: CartItem
  onRemoveCandidate: (isbn: string) => void
  onChangeCover: (item: CartItem) => void
}) {
  const candidates = item.isbns_candidates
  if (!candidates || candidates.length < 2) return null

  return (
    <div className="flex items-center gap-2 flex-wrap pt-1">
      <span className="text-xs text-muted-foreground shrink-0">
        {candidates.length} editions
      </span>
      <div className="flex items-center gap-1.5 flex-wrap">
        {candidates.map((isbn, idx) => {
          const isPrimary = idx === 0
          const coverUrl = `${OL_COVERS}/b/isbn/${isbn}-S.jpg`
          return (
            <div
              key={isbn}
              className={`relative group shrink-0 rounded overflow-hidden border-2 transition-all ${
                isPrimary ? 'border-amber-500 w-9 h-12' : 'border-border w-7 h-10 opacity-70 hover:opacity-100'
              }`}
            >
              <img
                src={coverUrl}
                alt={`ISBN ${isbn}`}
                className="w-full h-full object-cover"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
              {isPrimary && (
                <div className="absolute bottom-0 left-0 right-0 bg-amber-500/80 flex justify-center py-0.5">
                  <Star className="h-2 w-2 text-white fill-white" />
                </div>
              )}
              {!isPrimary && (
                <button
                  onClick={() => onRemoveCandidate(isbn)}
                  className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                  title={`Remove ISBN ${isbn}`}
                >
                  <X className="h-3 w-3 text-white" />
                </button>
              )}
            </div>
          )
        })}
        <button
          onClick={() => onChangeCover(item)}
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 shrink-0"
        >
          edit
        </button>
      </div>
    </div>
  )
}

interface Props {
  item: CartItem
  onUpdate: (id: string, patch: Partial<CartItem>) => void
  onRemove: (id: string) => void
  onChangeCover: (item: CartItem) => void
  onPickCover: (item: CartItem) => void
}

const CONDITIONS: { value: Condition; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'fine', label: 'Fine' },
  { value: 'good', label: 'Good' },
  { value: 'fair', label: 'Fair' },
]

function toggleCondition(current: Condition[], value: Condition): Condition[] {
  if (current.includes(value)) {
    const next = current.filter((c) => c !== value)
    return next.length === 0 ? current : next
  }
  return [...current, value]
}

export function CartItemCard({ item, onUpdate, onRemove, onChangeCover, onPickCover }: Props) {
  const [saving, setSaving] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [maxPriceInput, setMaxPriceInput] = useState(item.max_price != null ? String(item.max_price) : '')

  useEffect(() => {
    setMaxPriceInput(item.max_price != null ? String(item.max_price) : '')
  }, [item.max_price])

  async function removeCandidate(isbn: string) {
    const updated = (item.isbns_candidates ?? []).filter((i) => i !== isbn)
    await patch({ isbns_candidates: updated.length > 0 ? updated : null })
  }

  async function patch(updates: Partial<CartItem>) {
    setSaving(true)
    const slug = window.location.pathname.split('/').pop()!
    const res = await fetch(`/api/cart/${encodeURIComponent(slug)}/items/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    const saved = await res.json()
    onUpdate(item.id, res.ok ? saved : updates)
    setSaving(false)
  }

  const formatOptions: Format[] = ['any', 'hardcover', 'paperback']

  if (collapsed) {
    return (
      <div className={`flex items-end gap-3 px-1 pb-1 transition-opacity ${saving ? 'opacity-60' : ''}`}>
        {item.cover_url && (
          <img src={item.cover_url} alt={item.title} className="book-cover w-8 h-12 object-cover shrink-0" />
        )}
        <div className="flex-1 min-w-0 pb-0.5">
          <span className="font-serif font-medium text-base leading-tight truncate block">{item.title}</span>
          {item.author && <span className="text-sm text-muted-foreground truncate block">{item.author}</span>}
        </div>
        <div className="flex items-center gap-1 pb-1 shrink-0">
          <button onClick={() => setCollapsed(false)} className="text-muted-foreground hover:text-foreground" title="Expand">
            <ChevronDown className="h-4 w-4" />
          </button>
          <button onClick={() => onRemove(item.id)} className="text-muted-foreground hover:text-destructive">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`flex gap-4 sm:gap-5 px-1 transition-opacity ${saving ? 'opacity-60' : ''}`}>
      {/* Cover — bottom-aligned so it rests on the shelf ledge */}
      <div className="shrink-0 self-end">
        <button
          className="book-cover group relative w-24 h-36 bg-muted overflow-hidden block"
          onClick={() => onPickCover(item)}
          title="Change cover image"
        >
          {item.cover_url ? (
            <img src={item.cover_url} alt={item.title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-sm text-muted-foreground font-serif italic">?</div>
          )}
          <span className="absolute inset-x-0 bottom-0 pb-1.5 pt-4 text-center text-[11px] text-white bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
            change cover
          </span>
        </button>
      </div>

      {/* Details */}
      <div className="flex-1 min-w-0 space-y-2.5 pb-4">
        {/* Title row */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-serif font-medium text-lg leading-snug">{item.title}</div>
            {item.author && <div className="text-sm text-muted-foreground">{item.author}</div>}
          </div>
          <div className="flex items-center gap-1.5 shrink-0 pt-1">
            <button
              onClick={() => onChangeCover(item)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              title="Change edition"
            >
              <RefreshCw className="h-3 w-3" />
              <span>edition</span>
            </button>
            <button onClick={() => setCollapsed(true)} className="text-muted-foreground hover:text-foreground" title="Collapse">
              <ChevronUp className="h-4 w-4" />
            </button>
            <button onClick={() => onRemove(item.id)} className="text-muted-foreground hover:text-destructive">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Condition */}
        <div className="flex items-center gap-2.5">
          <span className="overline-label w-16 shrink-0">Condition</span>
          <div className="flex border border-border/80 rounded-full overflow-hidden text-[13px] min-h-[44px] sm:min-h-0 items-center bg-card/50">
            {CONDITIONS.map((c) => {
              const active = (item.conditions ?? []).includes(c.value)
              return (
                <button
                  key={c.value}
                  className={`px-2.5 py-1 transition-colors ${active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'}`}
                  onClick={() => patch({ conditions: toggleCondition(item.conditions ?? [], c.value) })}
                  title={`${active ? 'Remove' : 'Include'} ${c.label} condition`}
                >
                  {c.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Format */}
        <div className="flex items-center gap-2.5">
          <span className="overline-label w-16 shrink-0">Format</span>
          <div className="flex border border-border/80 rounded-full overflow-hidden text-[13px] min-h-[44px] sm:min-h-0 items-center bg-card/50">
            {formatOptions.map((f) => (
              <button
                key={f}
                className={`px-2.5 py-1 capitalize transition-colors ${item.format === f ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'}`}
                onClick={() => patch({ format: f })}
              >
                {f === 'any' ? 'Any' : f === 'hardcover' ? 'Hardcover' : 'Paperback'}
              </button>
            ))}
          </div>
        </div>

        {/* Special filters */}
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="overline-label w-16 shrink-0">Only</span>
          <div className="flex border border-border/80 rounded-full overflow-hidden text-[13px] bg-card/50">
            {([
              { key: 'signed_only', label: 'Signed' },
              { key: 'first_edition_only', label: '1st edition' },
              { key: 'dust_jacket_only', label: 'Dust jacket' },
            ] as { key: 'signed_only' | 'first_edition_only' | 'dust_jacket_only'; label: string }[]).map(({ key, label }) => (
              <button
                key={key}
                className={`px-2.5 py-1 transition-colors ${
                  item[key] ? 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200' : 'text-muted-foreground hover:bg-muted'
                }`}
                onClick={() => patch({ [key]: !item[key] })}
                title={item[key] ? `Showing only ${label} — click to remove filter` : `Click to require ${label}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={() => patch({ flexible: !item.flexible })}
            className={`text-[13px] px-2.5 py-1 rounded-full border transition-colors ${
              item.flexible
                ? 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900'
                : 'text-muted-foreground hover:bg-muted border-border/80'
            }`}
            title="Flexible: also accept looser conditions if exact match unavailable"
          >
            Flexible
          </button>
        </div>

        {/* Quantity + max price */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="h-6 w-6" disabled={item.quantity <= 1}
              onClick={() => patch({ quantity: item.quantity - 1 })}>
              <Minus className="h-3 w-3" />
            </Button>
            <span className="text-sm w-6 text-center">{item.quantity}</span>
            <Button variant="outline" size="icon" className="h-6 w-6"
              onClick={() => patch({ quantity: item.quantity + 1 })}>
              <Plus className="h-3 w-3" />
            </Button>
            <span className="text-xs text-muted-foreground ml-1">cop{item.quantity === 1 ? 'y' : 'ies'}</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground" title="Max price per copy incl. shipping">Max $</span>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="—"
              value={maxPriceInput}
              onChange={(e) => setMaxPriceInput(e.target.value)}
              onBlur={() => {
                const val = maxPriceInput.trim() === '' ? null : parseFloat(maxPriceInput)
                if (val === null || (!isNaN(val) && val >= 0)) {
                  patch({ max_price: val })
                }
              }}
              className="h-11 sm:h-7 w-16 px-2.5 text-sm border border-border/80 rounded-full bg-card/50 focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          {item.isbn_preferred && (!item.isbns_candidates || item.isbns_candidates.length < 2) && (
            <Badge variant="outline" className="text-xs font-normal">
              ISBN {item.isbn_preferred}
            </Badge>
          )}
        </div>

        {/* Edition strip */}
        <EditionStrip
          item={item}
          onRemoveCandidate={removeCandidate}
          onChangeCover={onChangeCover}
        />
      </div>
    </div>
  )
}
