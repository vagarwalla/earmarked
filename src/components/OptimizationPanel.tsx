'use client'

import { useState, useEffect } from 'react'
import { Loader2, ExternalLink, TrendingDown, AlertCircle, ChevronDown, ChevronUp, Lightbulb, BookOpen } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { CartItem, Condition, Edition, Listing, OptimizationResult, PriceResponse } from '@/lib/types'
import {
  CONDITION_ORDER,
  computeListings,
  findSuggestion,
  findCheaperSuggestion,
  type RelaxSuggestion,
} from '@/lib/relaxation'

// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  items: CartItem[]
  cartSlug: string
}

function totalCost(l: Listing) {
  return l.price + l.shipping_base
}

function ListingRow({ listing }: { listing: Listing }) {
  return (
    <a
      href={listing.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 py-1 px-2 rounded hover:bg-muted/60 transition-colors group text-sm"
    >
      <span className="truncate text-muted-foreground group-hover:text-foreground flex-1">
        {listing.seller_name}
      </span>
      <span className="shrink-0 px-1.5 py-0.5 rounded bg-muted text-muted-foreground capitalize">
        {listing.condition.replace('Used - ', '')}
      </span>
      <span className="shrink-0 font-medium tabular-nums">
        ${listing.price.toFixed(2)}
        {listing.shipping_base > 0
          ? ` + $${listing.shipping_base.toFixed(2)}`
          : ' + free ship'}
      </span>
      <ExternalLink className="h-3 w-3 shrink-0 opacity-40 group-hover:opacity-100" />
    </a>
  )
}

function BookListings({
  item, listings, cheaper, onAcceptCheaper, onTryOtherEditions,
}: {
  item: CartItem
  listings: Listing[]
  cheaper: { addedLabels: string[]; newConditions: Condition[]; cheaperPrice: number } | null
  onAcceptCheaper: (newConditions: Condition[]) => void
  onTryOtherEditions: (() => void) | null
}) {
  const [expanded, setExpanded] = useState(false)
  const sorted = [...listings].sort((a, b) => totalCost(a) - totalCost(b)).slice(0, 20)
  const preview = sorted.slice(0, 3)
  const rest = sorted.slice(3)

  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-sm mb-0.5">
        <span className="font-medium truncate">{item.title}</span>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {rest.length > 0 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {expanded ? 'Show less' : `${rest.length} more`}
            </button>
          )}
          <span className="text-green-700">{listings.length} listing{listings.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
      {preview.map((l) => <ListingRow key={l.listing_id} listing={l} />)}
      {expanded && rest.map((l) => <ListingRow key={l.listing_id} listing={l} />)}

      {/* Hints footer */}
      {(cheaper || onTryOtherEditions) && (
        <div className="mt-1.5 space-y-1">
          {cheaper && (
            <div className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-amber-50 border border-amber-200 text-sm">
              <div className="flex items-center gap-1.5 text-amber-800 min-w-0">
                <Lightbulb className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  From <span className="font-medium">${cheaper.cheaperPrice.toFixed(2)}</span> accepting {cheaper.addedLabels.join(' or ')}
                </span>
              </div>
              <button
                onClick={() => onAcceptCheaper(cheaper.newConditions)}
                className="shrink-0 text-xs font-medium text-amber-700 hover:text-amber-900 underline"
              >
                Accept
              </button>
            </div>
          )}
          {onTryOtherEditions && (
            <button
              onClick={onTryOtherEditions}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2"
            >
              <BookOpen className="h-3 w-3" />
              Try other editions
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Cover thumbnail with ISBN fallback ──────────────────────────────────────

function CoverThumb({ url, isbn }: { url: string | null; isbn: string }) {
  const [failed, setFailed] = useState(false)
  const src = url ?? `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg`
  if (failed) {
    return (
      <div className="w-20 h-28 bg-muted rounded shrink-0 flex items-center justify-center text-[10px] text-muted-foreground text-center leading-tight px-1">
        No cover
      </div>
    )
  }
  return (
    <img
      src={src}
      alt=""
      className="w-20 h-28 object-cover rounded shrink-0"
      onError={() => setFailed(true)}
    />
  )
}

// ─── Edition picker (inline) ─────────────────────────────────────────────────

function EditionPickerInline({
  item,
  cartSlug,
  listingsByIsbn,
  conditionOverrides,
  maxPriceOverrides,
  isbnCandidateOverrides,
  onSaved,
  onCancel,
}: {
  item: CartItem
  cartSlug: string
  listingsByIsbn: Record<string, Listing[]>
  conditionOverrides: Record<string, Condition[]>
  maxPriceOverrides: Record<string, number | null>
  isbnCandidateOverrides: Record<string, string[]>
  onSaved: (
    newIsbnOverrides: Record<string, string[]>,
    newListingsByIsbn: Record<string, Listing[]>,
  ) => void
  onCancel: () => void
}) {
  const [loadState, setLoadState] = useState<'loading' | 'done' | 'error'>('loading')
  const [editions, setEditions] = useState<Edition[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [editionStats, setEditionStats] = useState<Record<string, { count: number; cheapest: number; condition: string } | null>>({})

  useEffect(() => {
    if (!item.work_id) { setLoadState('done'); return }
    let cancelled = false
    fetch(`/api/editions?workId=${encodeURIComponent(item.work_id)}`)
      .then((r) => r.json())
      .then((all: Edition[]) => {
        if (cancelled) return
        const knownIsbns = new Set([
          ...(item.isbn_preferred ? [item.isbn_preferred] : []),
          ...(isbnCandidateOverrides[item.id] ?? item.isbns_candidates ?? []),
        ])
        const fresh = all
          .filter((e) => !knownIsbns.has(e.isbn))
          .sort((a, b) => b.popularity_score - a.popularity_score)
          .slice(0, 8)
        setEditions(fresh)
        setSelected(new Set(fresh.map((e) => e.isbn)))
        setLoadState('done')

        // Fetch listing counts + prices for all fresh editions
        const isbns = fresh.map((e) => e.isbn)
        if (isbns.length === 0) return
        fetch('/api/prices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isbns }),
        })
          .then((r) => r.json())
          .then((priceData: PriceResponse) => {
            if (cancelled) return
            const stats: Record<string, { count: number; cheapest: number; condition: string } | null> = {}
            for (const isbn of isbns) {
              const listings = (priceData.listings ?? {})[isbn] ?? []
              if (listings.length > 0) {
                const cheapest = listings.reduce((a, b) => a.price <= b.price ? a : b)
                stats[isbn] = { count: listings.length, cheapest: cheapest.price, condition: cheapest.condition.replace('Used - ', '') }
              } else {
                stats[isbn] = null
              }
            }
            setEditionStats(stats)
          })
          .catch(() => {})
      })
      .catch(() => { if (!cancelled) setLoadState('error') })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id])

  async function handleSave() {
    const newIsbns = [...selected]
    if (newIsbns.length === 0) { onCancel(); return }

    setSaving(true)
    try {
      const priceRes = await fetch('/api/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isbns: newIsbns }),
      })
      const priceData: PriceResponse = await priceRes.json()
      const mergedListings = { ...listingsByIsbn, ...(priceData.listings ?? {}) }

      const existingCandidates = isbnCandidateOverrides[item.id] ?? item.isbns_candidates ?? []
      const allCandidates = [...new Set([...existingCandidates, ...newIsbns])]
      const newIsbnOverrides = { ...isbnCandidateOverrides, [item.id]: allCandidates }

      // Save to Supabase (fire and forget)
      fetch(`/api/cart/${cartSlug}/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isbns_candidates: allCandidates }),
      }).catch(() => {})

      const effectiveItem: CartItem = {
        ...item,
        conditions: conditionOverrides[item.id] ?? item.conditions,
        max_price: item.id in maxPriceOverrides ? maxPriceOverrides[item.id] : item.max_price,
        isbns_candidates: allCandidates,
      }
      onSaved(newIsbnOverrides, mergedListings)
    } catch (err) {
      toast.error('Failed: ' + (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (loadState === 'loading') {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1 px-2">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading editions…
      </div>
    )
  }

  if (loadState === 'error') {
    return <p className="text-xs text-muted-foreground italic mt-1 px-2">Failed to load editions.</p>
  }

  if (editions.length === 0) {
    return <p className="text-xs text-muted-foreground italic mt-1 px-2">No other editions found for this book.</p>
  }

  return (
    <div className="mt-2 mx-2 rounded-md border bg-muted/30 p-2.5 space-y-2">
      <p className="text-xs font-medium">Select editions to search ({editions.length} found):</p>
      <div className="grid grid-cols-2 gap-2 max-h-72 overflow-y-auto pr-1">
        {editions.map((ed) => (
          <label
            key={ed.isbn}
            className={`flex gap-2 cursor-pointer rounded-md border p-1.5 transition-colors ${
              selected.has(ed.isbn) ? 'border-primary bg-primary/5' : 'border-border hover:border-border/80 hover:bg-muted/40'
            }`}
          >
            <input
              type="checkbox"
              className="sr-only"
              checked={selected.has(ed.isbn)}
              onChange={(e) => {
                const next = new Set(selected)
                if (e.target.checked) next.add(ed.isbn)
                else next.delete(ed.isbn)
                setSelected(next)
              }}
            />
            <CoverThumb url={ed.cover_url} isbn={ed.isbn} />
            <span className="text-xs leading-snug flex-1 min-w-0 space-y-0.5">
              <span className="font-medium block truncate">{ed.publisher ?? 'Unknown publisher'}</span>
              <span className="text-muted-foreground block">
                {ed.publish_year ? `${ed.publish_year} · ` : ''}
                {ed.format !== 'any' ? (ed.format === 'hardcover' ? 'HC' : 'PB') : ''}
                {ed.pages ? ` · ${ed.pages}pp` : ''}
              </span>
              {ed.ocaid && <span className="block text-sky-600 font-medium text-[10px]">Digitized</span>}
              {ed.isbn in editionStats ? (
                editionStats[ed.isbn] ? (
                  <span className="block text-green-700 font-medium text-[11px] leading-tight">
                    {editionStats[ed.isbn]!.count} listing{editionStats[ed.isbn]!.count !== 1 ? 's' : ''} · from ${editionStats[ed.isbn]!.cheapest.toFixed(2)} ({editionStats[ed.isbn]!.condition})
                  </span>
                ) : (
                  <span className="block text-muted-foreground italic text-[11px]">No listings</span>
                )
              ) : (
                <span className="block text-muted-foreground text-[11px]">Checking…</span>
              )}
            </span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button
          disabled={saving || selected.size === 0}
          onClick={handleSave}
          className="text-xs font-medium px-2.5 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1"
        >
          {saving && <Loader2 className="h-3 w-3 animate-spin" />}
          Search {selected.size} edition{selected.size !== 1 ? 's' : ''}
        </button>
        <button onClick={onCancel} className="text-xs text-muted-foreground hover:text-foreground underline">
          Cancel
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

type SourceId = 'best' | 'abe' | 'thriftbooks' | 'bwb'

const SOURCE_META: Record<SourceId, { label: string; shortLabel: string; searchUrl: (isbn: string) => string }> = {
  best:         { label: 'Best Overall',       shortLabel: 'Best',       searchUrl: () => '#' },
  abe:          { label: 'AbeBooks',           shortLabel: 'AbeBooks',   searchUrl: (isbn) => `https://www.abebooks.com/servlet/SearchResults?isbn=${isbn}&sortby=17` },
  thriftbooks:  { label: 'ThriftBooks',        shortLabel: 'ThriftBooks',searchUrl: (isbn) => `https://www.thriftbooks.com/browse/?b.search=${isbn}` },
  bwb:          { label: 'Better World Books', shortLabel: 'BWB',        searchUrl: (isbn) => `https://www.betterworldbooks.com/search/results?q=${isbn}` },
}

function filterBySource(byIsbn: Record<string, Listing[]>, src: SourceId): Record<string, Listing[]> {
  if (src === 'best') return byIsbn
  const out: Record<string, Listing[]> = {}
  for (const [isbn, ls] of Object.entries(byIsbn)) {
    out[isbn] = ls.filter((l) =>
      src === 'abe'
        ? l.seller_id !== 'thriftbooks' && l.seller_id !== 'betterworldbooks'
        : src === 'thriftbooks'
          ? l.seller_id === 'thriftbooks'
          : l.seller_id === 'betterworldbooks'
    )
  }
  return out
}

async function runOptimize(itemsToOpt: CartItem[], byIsbn: Record<string, Listing[]>): Promise<OptimizationResult> {
  const res = await fetch('/api/optimize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: itemsToOpt, listingsByIsbn: byIsbn }),
  })
  return res.json()
}

// ─────────────────────────────────────────────────────────────────────────────

export function OptimizationPanel({ items, cartSlug }: Props) {
  const [loading, setLoading] = useState(false)
  const [relaxing, setRelaxing] = useState(false)
  const [sourceTab, setSourceTab] = useState<SourceId>('best')
  const [resultsBySource, setResultsBySource] = useState<Partial<Record<SourceId, OptimizationResult>>>({})
  const [listingsByIsbn, setListingsByIsbn] = useState<Record<string, Listing[]>>({})
  const [searched, setSearched] = useState(false)
  const [conditionOverrides, setConditionOverrides] = useState<Record<string, Condition[]>>({})
  const [maxPriceOverrides, setMaxPriceOverrides] = useState<Record<string, number | null>>({})
  const [isbnCandidateOverrides, setIsbnCandidateOverrides] = useState<Record<string, string[]>>({})
  const [editionPickerFor, setEditionPickerFor] = useState<string | null>(null)

  async function updateAllResults(byIsbn: Record<string, Listing[]>, itemsToOpt: CartItem[]) {
    const [bestR, abeR, tbR, bwbR] = await Promise.all([
      runOptimize(itemsToOpt, filterBySource(byIsbn, 'best')),
      runOptimize(itemsToOpt, filterBySource(byIsbn, 'abe')),
      runOptimize(itemsToOpt, filterBySource(byIsbn, 'thriftbooks')),
      runOptimize(itemsToOpt, filterBySource(byIsbn, 'bwb')),
    ])
    setResultsBySource({ best: bestR, abe: abeR, thriftbooks: tbR, bwb: bwbR })
  }

  async function findDeals() {
    if (items.length === 0) return
    setLoading(true)
    setResultsBySource({})
    setSourceTab('best')
    setListingsByIsbn({})
    setSearched(false)
    setConditionOverrides({})
    setMaxPriceOverrides({})
    setIsbnCandidateOverrides({})
    setEditionPickerFor(null)

    try {
      const isbns = [...new Set(
        items.flatMap((i) => [i.isbn_preferred, ...(i.isbns_candidates ?? [])].filter(Boolean))
      )] as string[]

      const priceRes = await fetch('/api/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isbns }),
      })
      const priceData: PriceResponse = await priceRes.json()
      const byIsbn: Record<string, Listing[]> = priceData.listings ?? {}
      setListingsByIsbn(byIsbn)
      setSearched(true)

      await updateAllResults(byIsbn, items)
    } catch (err) {
      toast.error('Failed to find deals: ' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function applyRelaxation(
    itemId: string,
    newCondOverrides: Record<string, Condition[]>,
    newMaxPriceOverrides: Record<string, number | null>,
  ) {
    setConditionOverrides(newCondOverrides)
    setMaxPriceOverrides(newMaxPriceOverrides)
    setRelaxing(true)
    try {
      const overriddenItems = itemsWithIsbn.map((i) => ({
        ...i,
        conditions: newCondOverrides[i.id] ?? i.conditions,
        max_price: i.id in newMaxPriceOverrides ? newMaxPriceOverrides[i.id] : i.max_price,
        isbns_candidates: isbnCandidateOverrides[i.id] ?? i.isbns_candidates,
      }))
      await updateAllResults(listingsByIsbn, overriddenItems)
    } catch {
      // silent
    } finally {
      setRelaxing(false)
    }
  }

  function openGroup(urls: string[]) {
    urls.forEach((url) => window.open(url, '_blank', 'noopener'))
  }

const hasUnpricedItems = items.some((i) => !i.isbn_preferred)
  const itemsWithIsbn = items.filter((i) => i.isbn_preferred)

  const itemListingCounts = itemsWithIsbn.map((item) => {
    const conditions = conditionOverrides[item.id] ?? item.conditions ?? []
    const maxPrice = item.id in maxPriceOverrides ? maxPriceOverrides[item.id] : item.max_price
    const effectiveItem: CartItem = {
      ...item,
      isbns_candidates: isbnCandidateOverrides[item.id] ?? item.isbns_candidates,
    }
    const listings = computeListings(effectiveItem, listingsByIsbn, conditions, maxPrice)
    return { item: effectiveItem, listings, conditions, maxPrice }
  })

  const missingItems = itemListingCounts.filter((x) => x.listings.length === 0)
  const foundAnyListings = itemListingCounts.some((x) => x.listings.length > 0)

  return (
    <div className="space-y-4">
      {/* Find deals CTA */}
      <Button
        className="w-full"
        size="lg"
        onClick={findDeals}
        disabled={loading || items.length === 0}
      >
        {loading
          ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Searching listings…</>
          : '🔍 Find Best Deals'
        }
      </Button>

      {hasUnpricedItems && (
        <p className="text-sm text-muted-foreground text-center">
          Some books don&apos;t have an edition selected — choose an edition to get accurate pricing.
        </p>
      )}

      {/* Per-book listing previews */}
      {searched && itemListingCounts.length > 0 && (
        <div className="rounded-lg border bg-card divide-y">
          {itemListingCounts.map(({ item, listings, conditions, maxPrice }) => {
            if (listings.length === 0) return null
            const cheaper = findCheaperSuggestion(item, listingsByIsbn, listings, conditions, maxPrice)
            const showEditionPicker = editionPickerFor === item.id
            return (
              <div key={item.id} className="px-3 py-2 space-y-1">
                <BookListings
                  item={item}
                  listings={listings}
                  cheaper={cheaper}
                  onAcceptCheaper={(newConditions) => {
                    const next = { ...conditionOverrides, [item.id]: newConditions }
                    applyRelaxation(item.id, next, maxPriceOverrides)
                  }}
                  onTryOtherEditions={item.work_id ? () => setEditionPickerFor(showEditionPicker ? null : item.id) : null}
                />
                {showEditionPicker && (
                  <EditionPickerInline
                    item={item}
                    cartSlug={cartSlug}
                    listingsByIsbn={listingsByIsbn}
                    conditionOverrides={conditionOverrides}
                    maxPriceOverrides={maxPriceOverrides}
                    isbnCandidateOverrides={isbnCandidateOverrides}
                    onSaved={(newIsbnOverrides, newListings) => {
                      setIsbnCandidateOverrides(newIsbnOverrides)
                      setListingsByIsbn(newListings)
                      setEditionPickerFor(null)
                      const overriddenItems = itemsWithIsbn.map((i) => ({
                        ...i,
                        conditions: conditionOverrides[i.id] ?? i.conditions,
                        max_price: i.id in maxPriceOverrides ? maxPriceOverrides[i.id] : i.max_price,
                        isbns_candidates: newIsbnOverrides[i.id] ?? i.isbns_candidates,
                      }))
                      updateAllResults(newListings, overriddenItems).catch(() => {})
                    }}
                    onCancel={() => setEditionPickerFor(null)}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Missing books — with relaxation suggestions */}
      {searched && missingItems.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 divide-y divide-amber-100">
          <div className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-amber-800">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            No listings found for {missingItems.length === 1 ? 'this book' : `${missingItems.length} books`} — try relaxing constraints
          </div>
          {missingItems.map(({ item, conditions, maxPrice }) => {
            const suggestion = findSuggestion(item, listingsByIsbn, conditions, maxPrice)
            const showEditionPicker = editionPickerFor === item.id
            return (
              <div key={item.id} className="px-3 py-2 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-amber-900">{item.title}</span>
                  {item.isbn_preferred && (
                    <a
                      href={`https://www.abebooks.com/servlet/SearchResults?isbn=${item.isbn_preferred}&sortby=17`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-amber-600 hover:text-amber-800 underline shrink-0"
                    >
                      search manually
                    </a>
                  )}
                </div>

                {suggestion ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-amber-700">
                      {suggestion.type === 'condition'
                        ? <>{suggestion.count} cop{suggestion.count === 1 ? 'y' : 'ies'} available accepting <strong>{suggestion.addedLabels.join(' or ')}</strong> condition</>
                        : <>{suggestion.count} cop{suggestion.count === 1 ? 'y' : 'ies'} available if price cap is removed</>
                      }
                    </span>
                    <button
                      disabled={relaxing}
                      onClick={() => {
                        if (suggestion.type === 'condition') {
                          const next = { ...conditionOverrides, [item.id]: suggestion.newConditions }
                          applyRelaxation(item.id, next, maxPriceOverrides)
                        } else {
                          const next = { ...maxPriceOverrides, [item.id]: null }
                          applyRelaxation(item.id, conditionOverrides, next)
                        }
                      }}
                      className="shrink-0 text-xs font-medium px-2 py-1 rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 flex items-center gap-1"
                    >
                      {relaxing && <Loader2 className="h-3 w-3 animate-spin" />}
                      Accept
                    </button>
                  </div>
                ) : showEditionPicker ? (
                  <EditionPickerInline
                    item={item}
                    cartSlug={cartSlug}
                    listingsByIsbn={listingsByIsbn}
                    conditionOverrides={conditionOverrides}
                    maxPriceOverrides={maxPriceOverrides}
                    isbnCandidateOverrides={isbnCandidateOverrides}
                    onSaved={(newIsbnOverrides, newListings) => {
                      setIsbnCandidateOverrides(newIsbnOverrides)
                      setListingsByIsbn(newListings)
                      setEditionPickerFor(null)
                      const overriddenItems = itemsWithIsbn.map((i) => ({
                        ...i,
                        conditions: conditionOverrides[i.id] ?? i.conditions,
                        max_price: i.id in maxPriceOverrides ? maxPriceOverrides[i.id] : i.max_price,
                        isbns_candidates: newIsbnOverrides[i.id] ?? i.isbns_candidates,
                      }))
                      updateAllResults(newListings, overriddenItems).catch(() => {})
                    }}
                    onCancel={() => setEditionPickerFor(null)}
                  />
                ) : (
                  <div className="flex items-center gap-3">
                    <p className="text-xs text-amber-700 italic">
                      No listings found for this edition.
                    </p>
                    {item.work_id && (
                      <button
                        onClick={() => setEditionPickerFor(item.id)}
                        className="shrink-0 text-xs font-medium text-amber-700 hover:text-amber-900 flex items-center gap-1 underline"
                      >
                        <BookOpen className="h-3 w-3" />
                        Try other editions
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Re-optimizing spinner */}
      {relaxing && Object.keys(resultsBySource).length > 0 && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Re-optimizing with relaxed constraints…
        </div>
      )}

      {/* Source tabs + optimization results */}
      {searched && Object.keys(resultsBySource).length > 0 && foundAnyListings && (() => {
        const activeResult = resultsBySource[sourceTab] ?? null
        const hasDirectRetailers = activeResult?.groups.some(
          (g) => g.seller_id === 'thriftbooks' || g.seller_id === 'betterworldbooks'
        ) ?? false
        const hasAbeBooksSellers = activeResult?.groups.some(
          (g) => g.seller_id !== 'thriftbooks' && g.seller_id !== 'betterworldbooks'
        ) ?? false
        const shippingNote = hasAbeBooksSellers && hasDirectRetailers
          ? 'Shipping est.: $3.99/order for ThriftBooks & Better World Books; $3.99 + $1.99/book for AbeBooks sellers.'
          : hasDirectRetailers
            ? 'Shipping est.: $3.99 per order (flat rate for direct retailers).'
            : 'Shipping est.: $3.99 first book + $1.99 each additional from same seller.'

        return (
          <div className="space-y-3">
            {/* Source comparison tabs */}
            <div className="grid grid-cols-4 rounded-lg border overflow-hidden text-xs">
              {(Object.keys(SOURCE_META) as SourceId[]).map((src) => {
                const r = resultsBySource[src]
                const hasResult = r && r.groups.length > 0
                const isActive = sourceTab === src
                return (
                  <button
                    key={src}
                    onClick={() => hasResult && setSourceTab(src)}
                    className={`py-2 px-1 text-center transition-colors border-r last:border-r-0 ${
                      isActive
                        ? 'bg-primary text-primary-foreground'
                        : hasResult
                          ? 'hover:bg-muted text-muted-foreground cursor-pointer'
                          : 'text-muted-foreground/40 cursor-default bg-muted/30'
                    }`}
                  >
                    <div className="font-medium truncate">{SOURCE_META[src].shortLabel}</div>
                    <div className={`tabular-nums ${isActive ? 'text-primary-foreground' : hasResult ? 'text-foreground font-semibold' : ''}`}>
                      {hasResult ? `$${r!.grand_total.toFixed(2)}` : '—'}
                    </div>
                  </button>
                )
              })}
            </div>

            {activeResult && activeResult.groups.length > 0 ? (
              <>
                <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                  <div>
                    <div className="font-semibold text-green-900">
                      {SOURCE_META[sourceTab].label}: ${activeResult.grand_total.toFixed(2)}
                    </div>
                    <div className="text-sm text-green-700">incl. estimated shipping</div>
                  </div>
                  {activeResult.savings > 0.5 && (
                    <Badge className="bg-green-600 text-white">
                      <TrendingDown className="h-3 w-3 mr-1" />
                      Save ${activeResult.savings.toFixed(2)}
                    </Badge>
                  )}
                </div>

                {activeResult.groups.map((group) => (
                  <Card key={group.seller_id} className="overflow-hidden">
                    <CardHeader className="py-2 px-3 bg-muted/50 flex-row items-center justify-between space-y-0">
                      <CardTitle className="text-sm font-medium">{group.seller_name}</CardTitle>
                      <span className="text-sm text-muted-foreground">
                        {group.assignments.length} book{group.assignments.length !== 1 ? 's' : ''}
                      </span>
                    </CardHeader>
                    <CardContent className="py-2 px-3 space-y-1.5">
                      {group.assignments.map(({ item, listing, quantity, subtotal }) => (
                        <div key={item.id} className="flex items-center justify-between text-sm">
                          <div className="flex items-center gap-2 min-w-0">
                            <a
                              href={listing.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="truncate text-sm hover:underline"
                            >
                              {item.title}
                            </a>
                            {quantity > 1 && (
                              <Badge variant="outline" className="text-xs shrink-0">×{quantity}</Badge>
                            )}
                            <Badge variant="secondary" className="text-xs shrink-0 capitalize">
                              {listing.condition.replace('Used - ', '')}
                            </Badge>
                            {listing.isbn !== item.isbn_preferred && (
                              <Badge variant="outline" className="text-xs shrink-0 text-muted-foreground">
                                alt. edition
                              </Badge>
                            )}
                          </div>
                          <span className="shrink-0 font-medium ml-2">${subtotal.toFixed(2)}</span>
                        </div>
                      ))}
                      <div className="border-t pt-1.5 flex justify-between text-sm text-muted-foreground">
                        <span>Shipping (est.): ${group.shipping.toFixed(2)}</span>
                        <span className="font-semibold text-foreground">
                          Group total: ${group.group_total.toFixed(2)}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full mt-1 h-8 text-sm"
                        onClick={() => openGroup(group.assignments.map((a) => a.listing.url))}
                      >
                        <ExternalLink className="h-3 w-3 mr-1.5" />
                        Open {group.assignments.length} listing{group.assignments.length !== 1 ? 's' : ''} on {group.seller_name}
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </>
            ) : (
              <div className="text-sm text-muted-foreground text-center py-4 border rounded-lg">
                No listings found from {SOURCE_META[sourceTab].label}.{' '}
                {sourceTab !== 'best' && items[0]?.isbn_preferred && (
                  <a
                    href={SOURCE_META[sourceTab].searchUrl(items[0].isbn_preferred)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-foreground"
                  >
                    Search manually
                  </a>
                )}
              </div>
            )}

            <p className="text-xs text-muted-foreground text-center">{shippingNote} Actual rates may vary.</p>
          </div>
        )
      })()}
    </div>
  )
}
