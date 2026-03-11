'use client'

import { useState } from 'react'
import type { Cart, Condition, Format } from '@/lib/types'

interface Props {
  cart: Cart
  slug: string
  onUpdate: (updated: Cart) => void
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
    return next.length === 0 ? current : next
  }
  return [...current, value]
}

export function CartDefaults({ cart, slug, onUpdate }: Props) {
  const [maxInput, setMaxInput] = useState(
    cart.default_max_price != null ? String(cart.default_max_price) : ''
  )

  async function patch(updates: Partial<Cart>) {
    const res = await fetch(`/api/cart/${slug}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    const updated = await res.json()
    onUpdate(updated)
  }

  const conditions = cart.default_conditions ?? ['new', 'fine', 'good']
  const format: Format = cart.default_format ?? 'any'

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">Defaults:</span>

      <div className="flex gap-0.5 border rounded-md overflow-hidden">
        {CONDITIONS.map((c) => {
          const active = conditions.includes(c.value)
          return (
            <button
              key={c.value}
              className={`px-2 py-1 transition-colors ${active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
              onClick={() => patch({ default_conditions: toggleCondition(conditions, c.value) })}
            >
              {c.label}
            </button>
          )
        })}
      </div>

      <div className="flex gap-0.5 border rounded-md overflow-hidden">
        {(['any', 'hardcover', 'paperback'] as Format[]).map((f) => (
          <button
            key={f}
            className={`px-2 py-1 capitalize ${format === f ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
            onClick={() => patch({ default_format: f })}
          >
            {f === 'any' ? 'Any' : f === 'hardcover' ? 'HC' : 'PB'}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1">
        <span>max</span>
        <div className="relative">
          <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="—"
            value={maxInput}
            onChange={(e) => setMaxInput(e.target.value)}
            onBlur={() => {
              const val = maxInput.trim() === '' ? null : parseFloat(maxInput)
              if (val === null || (!isNaN(val) && val >= 0)) {
                patch({ default_max_price: val })
              }
            }}
            className="h-6 w-16 pl-4 pr-1 border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      <div className="flex gap-0.5 border rounded-md overflow-hidden">
        {([
          { key: 'default_signed_only', label: 'Signed' },
          { key: 'default_first_edition_only', label: '1st Ed' },
          { key: 'default_dust_jacket_only', label: 'DJ' },
        ] as { key: 'default_signed_only' | 'default_first_edition_only' | 'default_dust_jacket_only'; label: string }[]).map(({ key, label }) => (
          <button
            key={key}
            className={`px-2 py-1 transition-colors ${cart[key] ? 'bg-amber-100 text-amber-800' : 'hover:bg-muted'}`}
            onClick={() => patch({ [key]: !cart[key] })}
            title={cart[key] ? `Default: ${label} only` : `Default: any (click to require ${label})`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
