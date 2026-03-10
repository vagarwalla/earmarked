'use client'

import { useState } from 'react'
import { X, RefreshCw, Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { CartItem, Condition, Format } from '@/lib/types'

interface Props {
  item: CartItem
  onUpdate: (id: string, patch: Partial<CartItem>) => void
  onRemove: (id: string) => void
  onChangeCover: (item: CartItem) => void  // change edition + cover
  onPickCover: (item: CartItem) => void    // change cover image only
}

const CONDITIONS: { value: Condition; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'like_new', label: 'Like New' },
  { value: 'very_good', label: 'Very Good' },
  { value: 'good', label: 'Good' },
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
  const [maxPriceInput, setMaxPriceInput] = useState(item.max_price != null ? String(item.max_price) : '')

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
          className="mt-1 w-20 flex justify-center gap-1 items-center text-[10px] text-muted-foreground hover:text-foreground"
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
          <button onClick={() => onRemove(item.id)} className="text-muted-foreground hover:text-destructive shrink-0">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          {/* Condition multi-select */}
          <div className="flex gap-0.5 border rounded-md overflow-hidden text-xs">
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
          <div className="flex gap-0.5 border rounded-md overflow-hidden text-xs">
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
            className={`text-xs px-2 py-1 rounded border transition-colors ${
              item.flexible ? 'bg-blue-50 text-blue-700 border-blue-200' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {item.flexible ? 'Flexible ✓' : 'Flexible'}
          </button>
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
            <span className="text-xs text-muted-foreground ml-1">cop{item.quantity === 1 ? 'y' : 'ies'}</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">max</span>
            <div className="relative">
              <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
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
                className="h-6 w-16 pl-4 pr-1 text-xs border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>
          {item.isbn_preferred && (
            <Badge variant="outline" className="text-[10px] font-normal">
              ISBN {item.isbn_preferred}
            </Badge>
          )}
        </div>
      </div>
    </div>
  )
}
