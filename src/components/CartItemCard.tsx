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
              {/* Primary badge */}
              {isPrimary && (
                <div className="absolute bottom-0 left-0 right-0 bg-amber-500/80 flex justify-center py-0.5">
                  <Star className="h-2 w-2 text-white fill-white" />
                </div>
              )}
              {/* Remove button for non-primary */}
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
  onChangeCover: (item: CartItem) => void  // change edition + cover
  onPickCover: (item: CartItem) => void    // change cover image only
}

const CONDITIONS: { value: Condition; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'fine', label: 'Fine or Near Fine' },
  { value: 'good', label: 'Very Good or Good' },
  { value: 'fair', label: 'Fair or Poor' },
]

function toggleCondition(current: Condition[], value: Condition): Condition[] {
  if (current.includes(value)) {
    const next = current.filter((c) => c !== value)
    return next.length === 0 ? current : next // require at least one
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
    const res = await fetch(`/api/cart/${encodeURIComponent(window.location.pathname.split('/').pop()!)}/items/${item.id}`, {
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
      <div className={`flex items-center gap-3 px-3 py-2 rounded-lg border bg-card transition-opacity ${saving ? 'opacity-60' : ''}`}>
        {item.cover_url && (
          <img src={item.cover_url} alt={item.title} className="w-7 h-9 object-cover rounded shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <span className="font-medium text-sm leading-tight truncate block">{item.title}</span>
          {item.author && <span className="text-xs text-muted-foreground truncate block">{item.author}</span>}
        </div>
        <button onClick={() => setCollapsed(false)} className="text-muted-foreground hover:text-foreground shrink-0" title="Expand">
          <ChevronDown className="h-4 w-4" />
        </button>
        <button onClick={() => onRemove(item.id)} className="text-muted-foreground hover:text-destructive shrink-0">
          <X className="h-4 w-4" />
        </button>
      </div>
    )
  }

  return (
    <div className={`flex gap-3 p-3 rounded-lg border bg-card transition-opacity ${saving ? 'opacity-60' : ''}`}>
      {/* Cover */}
      <div className="shrink-0">
        <button
          className="w-20 h-28 bg-muted rounded overflow-hidden block hover:opacity-80 transition-opacity"
          onClick={() => onPickCover(item)}
          title="Change cover image"
        >
          {item.cover_url ? (
            <img src={item.cover_url} alt={item.title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-sm text-muted-foreground">?</div>
          )}
        </button>
        <button
          className="mt-1 w-20 flex justify-center gap-1 items-center text-xs text-muted-foreground hover:text-foreground"
          onClick={() => onChangeCover(item)}
          title="Change edition"
        >
          <RefreshCw className="h-3 w-3" />
          <span>edition</span>
        </button>

      </div>

      {/* Details */}
      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-medium text-base leading-tight">{item.title}</div>
            {item.author && <div className="text-sm text-muted-foreground">{item.author}</div>}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={() => setCollapsed(true)} className="text-muted-foreground hover:text-foreground" title="Collapse">
              <ChevronUp className="h-4 w-4" />
            </button>
            <button onClick={() => onRemove(item.id)} className="text-muted-foreground hover:text-destructive">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          {/* Condition multi-select */}
          <div className="flex gap-0.5 border rounded-md overflow-hidden text-sm">
            {CONDITIONS.map((c) => {
              const active = (item.conditions ?? []).includes(c.value)
              return (
                <button
                  key={c.value}
                  className={`px-2 py-1 transition-colors ${active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'}`}
                  onClick={() => patch({ conditions: toggleCondition(item.conditions ?? [], c.value) })}
                >
                  {c.label}
                </button>
              )
            })}
          </div>

          {/* Format toggle */}
          <div className="flex gap-0.5 border rounded-md overflow-hidden text-sm">
            {formatOptions.map((f) => (
              <button
                key={f}
                className={`px-2 py-1 capitalize ${item.format === f ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                onClick={() => patch({ format: f })}
              >
                {f === 'any' ? 'Any' : f === 'hardcover' ? 'HC' : 'PB'}
              </button>
            ))}
          </div>

          {/* Flexible */}
          <button
            onClick={() => patch({ flexible: !item.flexible })}
            className={`text-sm px-2 py-1 rounded border transition-colors ${
              item.flexible ? 'bg-blue-50 text-blue-700 border-blue-200' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {item.flexible ? 'Flexible ✓' : 'Flexible'}
          </button>

          {/* Collectible attribute filters */}
          <div className="flex gap-0.5 border rounded-md overflow-hidden text-sm">
            {([
              { key: 'signed_only', label: 'Signed' },
              { key: 'first_edition_only', label: '1st Ed' },
              { key: 'dust_jacket_only', label: 'DJ' },
            ] as { key: 'signed_only' | 'first_edition_only' | 'dust_jacket_only'; label: string }[]).map(({ key, label }) => (
              <button
                key={key}
                className={`px-2 py-1 transition-colors ${
                  item[key] ? 'bg-amber-100 text-amber-800' : 'text-muted-foreground hover:bg-muted'
                }`}
                onClick={() => patch({ [key]: !item[key] })}
                title={item[key] ? `Only ${label} copies` : `Any (click to require ${label})`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Quantity + max price */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-6 w-6"
              disabled={item.quantity <= 1}
              onClick={() => patch({ quantity: item.quantity - 1 })}
            >
              <Minus className="h-3 w-3" />
            </Button>
            <span className="text-sm w-6 text-center">{item.quantity}</span>
            <Button
              variant="outline"
              size="icon"
              className="h-6 w-6"
              onClick={() => patch({ quantity: item.quantity + 1 })}
            >
              <Plus className="h-3 w-3" />
            </Button>
            <span className="text-sm text-muted-foreground ml-1">cop{item.quantity === 1 ? 'y' : 'ies'}</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-sm text-muted-foreground" title="Max total per book incl. shipping">max</span>
            <div className="relative">
              <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="15"
                value={maxPriceInput}
                onChange={(e) => setMaxPriceInput(e.target.value)}
                onBlur={() => {
                  const val = maxPriceInput.trim() === '' ? null : parseFloat(maxPriceInput)
                  if (val === null || (!isNaN(val) && val >= 0)) {
                    patch({ max_price: val })
                  }
                }}
                className="h-7 w-16 pl-4 pr-1 text-sm border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>
          {item.isbn_preferred && (!item.isbns_candidates || item.isbns_candidates.length < 2) && (
            <Badge variant="outline" className="text-xs font-normal">
              ISBN {item.isbn_preferred}
            </Badge>
          )}
        </div>

        {/* Edition strip — shown when multiple candidates selected */}
        <EditionStrip
          item={item}
          onRemoveCandidate={removeCandidate}
          onChangeCover={onChangeCover}
        />
      </div>
    </div>
  )
}
