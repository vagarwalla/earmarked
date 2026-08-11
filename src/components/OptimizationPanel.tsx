'use client'

import { useState, useEffect, useRef } from 'react'
import { Loader2, ExternalLink, TrendingDown, AlertCircle, ChevronDown, ChevronUp, Lightbulb, BookOpen } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { CartItem, Condition, Edition, Listing, OptimizationResult, PriceResponse, SourceInfo } from '@/lib/types'
import { getSellerSource } from '@/lib/optimizer/batch'
import {
  CONDITION_LABELS,
  CONDITION_ORDER,
  computeListings,
  findSuggestion,
  findEditionOptions,
  findRelaxedDeal,
  findNearMissPrice,
  findShippingRelaxSuggestions,
  type EditionOption,
  type RelaxSuggestion,
  type RelaxedDeal,
  type NearMissPrice,
  type ShippingRelaxSuggestion,
} from '@/lib/relaxation'

// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  items: CartItem[]
  cartSlug: string
  onUpdateItem?: (id: string, patch: Partial<CartItem>) => void
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
  item, listings, deal, nearMiss, onAcceptDeal, onAcceptNearMiss, onTryOtherEditions,
}: {
  item: CartItem
  listings: Listing[]
  deal: RelaxedDeal | null
  nearMiss: NearMissPrice | null
  onAcceptDeal: (newConditions: Condition[]) => void
  onAcceptNearMiss: () => void
  onTryOtherEditions: (() => void) | null
}) {
  const [expanded, setExpanded] = useState(false)
  const sorted = [...listings].sort((a, b) => totalCost(a) - totalCost(b)).slice(0, 20)
  const preview = sorted.slice(0, 3)
  const rest = sorted.slice(3)

  const showDeal = deal && deal.tier !== 'trivial'

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
      {(showDeal || nearMiss || onTryOtherEditions) && (
        <div className="mt-1.5 space-y-1">
          {showDeal && (
            <div className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-sm ${
              deal.tier === 'better_deal'
                ? 'bg-green-50 border border-green-200'
                : 'bg-amber-50 border border-amber-200'
            }`}>
              <div className={`flex items-center gap-1.5 min-w-0 ${
                deal.tier === 'better_deal' ? 'text-green-800' : 'text-amber-800'
              }`}>
                <Lightbulb className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  <span className="font-medium">${deal.relaxedCheapest.toFixed(2)}</span> accepting {deal.addedLabels.join(' or ')}
                  {' '}
                  <span className="opacity-75">(save ${deal.savingsAmount.toFixed(2)})</span>
                </span>
              </div>
              <button
                onClick={() => onAcceptDeal(deal.newConditions)}
                className={`shrink-0 text-xs font-medium underline ${
                  deal.tier === 'better_deal'
                    ? 'text-green-700 hover:text-green-900'
                    : 'text-amber-700 hover:text-amber-900'
                }`}
              >
                Accept
              </button>
            </div>
          )}
          {nearMiss && (
            <div className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-blue-50 border border-blue-200 text-sm">
              <div className="flex items-center gap-1.5 text-blue-800 min-w-0">
                <Lightbulb className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  Listing at <span className="font-medium">${nearMiss.cheapestBlocked.toFixed(2)}</span> is just ${nearMiss.delta.toFixed(2)} over your price cap
                </span>
              </div>
              <button
                onClick={onAcceptNearMiss}
                className="shrink-0 text-xs font-medium text-blue-700 hover:text-blue-900 underline"
              >
                Remove cap
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

function CoverThumb({ url, isbn, size = 'w-20 h-28' }: { url: string | null; isbn: string; size?: string }) {
  const [failed, setFailed] = useState(false)
  const src = url ?? `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg`
  if (failed) {
    return (
      <div className={`${size} bg-muted rounded shrink-0 flex items-center justify-center text-[10px] text-muted-foreground text-center leading-tight px-1`}>
        No cover
      </div>
    )
  }
  return (
    <img
      src={src}
      alt=""
      className={`${size} object-cover rounded shrink-0`}
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

type SourceId = 'best' | 'abe' | 'thriftbooks' | 'bwb' | 'combined'

const SOURCE_META: Record<SourceId, { label: string; shortLabel: string; searchUrl: (isbn: string) => string }> = {
  best:         { label: 'Best Overall',       shortLabel: 'Best',       searchUrl: () => '#' },
  abe:          { label: 'AbeBooks',           shortLabel: 'AbeBooks',   searchUrl: (isbn) => `https://www.abebooks.com/servlet/SearchResults?isbn=${isbn}&sortby=17` },
  thriftbooks:  { label: 'ThriftBooks',        shortLabel: 'ThriftBooks',searchUrl: (isbn) => `https://www.thriftbooks.com/browse/?b.search=${isbn}` },
  bwb:          { label: 'Better World Books', shortLabel: 'BWB',        searchUrl: (isbn) => `https://www.betterworldbooks.com/search/results?q=${isbn}` },
  combined:     { label: 'Combined (all sources)', shortLabel: 'Combined', searchUrl: () => '#' },
}

// Source badge shown on seller groups in the Combined tab
const SOURCE_BADGE: Record<'abe' | 'thriftbooks' | 'bwb', { label: string; className: string }> = {
  abe:         { label: 'AbeBooks',    className: 'bg-amber-100 text-amber-800 border border-amber-300' },
  thriftbooks: { label: 'ThriftBooks', className: 'bg-blue-100 text-blue-800 border border-blue-300' },
  bwb:         { label: 'BWB',         className: 'bg-emerald-100 text-emerald-800 border border-emerald-300' },
}


// Alternate-cover probing for books that came up empty. Bounded on every axis
// because /api/prices scrapes uncached ISBNs one at a time: a stack where
// dozens of books come up empty would otherwise fan out into hundreds of
// sequential scrapes. Books past the batch size are probed on request.
const ALT_COVERS_PER_BOOK = 6
const COVER_PROBE_CONCURRENCY = 2
const COVER_PROBE_BATCH = 20

// One request returns every source view — the server qualifies listings once
// and partitions per source, and guarantees combined ≤ each single source.
async function runOptimizeBatch(
  itemsToOpt: CartItem[],
  byIsbn: Record<string, Listing[]>,
): Promise<Record<SourceId, OptimizationResult>> {
  const res = await fetch('/api/optimize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: itemsToOpt, listingsByIsbn: byIsbn }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new Error(data?.error ?? `optimize failed (${res.status})`)
  }
  return res.json()
}

// ─────────────────────────────────────────────────────────────────────────────

export function OptimizationPanel({ items, cartSlug, onUpdateItem }: Props) {
  const [loading, setLoading] = useState(false)
  const [relaxing, setRelaxing] = useState(false)
  const [sourceTab, setSourceTab] = useState<SourceId>('best')
  const [resultsBySource, setResultsBySource] = useState<Partial<Record<SourceId, OptimizationResult>>>({})
  const [listingsByIsbn, setListingsByIsbn] = useState<Record<string, Listing[]>>({})
  const [searched, setSearched] = useState(false)
  // Health of the last price lookup — a blocked or timed-out source is not the
  // same as a book nobody is selling, and the panel must not conflate them.
  const [searchError, setSearchError] = useState<string | null>(null)
  const [sourceHealth, setSourceHealth] = useState<SourceInfo[]>([])
  const [uncheckedIsbns, setUncheckedIsbns] = useState<string[]>([])
  const [conditionOverrides, setConditionOverrides] = useState<Record<string, Condition[]>>({})
  const [maxPriceOverrides, setMaxPriceOverrides] = useState<Record<string, number | null>>({})
  const [isbnCandidateOverrides, setIsbnCandidateOverrides] = useState<Record<string, string[]>>({})
  const [editionPickerFor, setEditionPickerFor] = useState<string | null>(null)
  // Alternate editions auto-probed for books with no listings, keyed by item id
  const [altEditions, setAltEditions] = useState<Record<string, Edition[]>>({})
  const [coverProbeStatus, setCoverProbeStatus] = useState<Record<string, 'searching' | 'done' | 'error'>>({})
  const [coverProbeBudget, setCoverProbeBudget] = useState(COVER_PROBE_BATCH)
  // Bumped on every new search so in-flight probes from a previous run can't write stale listings
  const probeGen = useRef(0)
  // Queued item ids, tracked synchronously — state updates land too late to keep
  // a re-run of the effect (React strict mode runs it twice) from double-fetching.
  const queuedForProbe = useRef(new Set<string>())

  async function updateAllResults(byIsbn: Record<string, Listing[]>, itemsToOpt: CartItem[]) {
    setResultsBySource(await runOptimizeBatch(itemsToOpt, byIsbn))
  }

  async function findDeals() {
    if (items.length === 0) return
    setLoading(true)
    setResultsBySource({})
    setSourceTab('best')
    setListingsByIsbn({})
    setSearched(false)
    setEditionPickerFor(null)
    setSearchError(null)
    setSourceHealth([])
    setUncheckedIsbns([])
    setAltEditions({})
    setCoverProbeStatus({})
    setCoverProbeBudget(COVER_PROBE_BATCH)
    probeGen.current++
    queuedForProbe.current = new Set()

    try {
      const isbns = [...new Set(
        items.flatMap((i) => [i.isbn_preferred, ...(i.isbns_candidates ?? [])].filter(Boolean))
      )] as string[]

      const priceRes = await fetch('/api/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isbns }),
      })
      // A failed request used to parse into an empty listing map, which the panel
      // then reported as "no listings — try relaxing constraints".
      if (!priceRes.ok) {
        const detail = await priceRes.json().catch(() => null)
        throw new Error(detail?.error ?? `price lookup failed (${priceRes.status})`)
      }
      const priceData: PriceResponse = await priceRes.json()
      const byIsbn: Record<string, Listing[]> = priceData.listings ?? {}
      setListingsByIsbn(byIsbn)
      setSourceHealth(priceData.sources ?? [])
      setUncheckedIsbns(priceData.unchecked_isbns ?? [])
      setSearched(true)

      await updateAllResults(byIsbn, items)
    } catch (err) {
      // Held in state as well as a toast: a toast vanishes, and a silent failure
      // here is indistinguishable from "these books have no listings".
      setSearchError((err as Error).message)
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
      // Persist relaxed conditions/max_price to DB and update parent state
      const patch: Partial<CartItem> = {}
      if (newCondOverrides[itemId]) patch.conditions = newCondOverrides[itemId]
      if (itemId in newMaxPriceOverrides) patch.max_price = newMaxPriceOverrides[itemId]
      if (Object.keys(patch).length > 0) {
        fetch(`/api/cart/${encodeURIComponent(cartSlug)}/items/${itemId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        }).catch(() => {})
        onUpdateItem?.(itemId, patch)
      }

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

  /**
   * Search the other editions of a work for a book that came up empty. Their
   * listings are merged into `listingsByIsbn` right away — keyed by ISBN, they
   * only affect an item once that ISBN becomes one of its candidates — so the
   * cover options render as soon as prices land.
   */
  async function probeCoversForItem(item: CartItem, gen: number) {
    try {
      const res = await fetch(`/api/editions?workId=${encodeURIComponent(item.work_id!)}`)
      if (!res.ok) throw new Error(`editions lookup failed (${res.status})`)
      const all: Edition[] = await res.json()
      if (!Array.isArray(all)) throw new Error('editions lookup returned no list')
      if (probeGen.current !== gen) return

      const known = new Set([
        ...(item.isbn_preferred ? [item.isbn_preferred] : []),
        ...(item.isbns_candidates ?? []),
      ])
      const fresh = all
        .filter((e) => !known.has(e.isbn))
        .sort((a, b) => b.popularity_score - a.popularity_score)
        .slice(0, ALT_COVERS_PER_BOOK)
      if (fresh.length === 0) {
        setCoverProbeStatus((prev) => ({ ...prev, [item.id]: 'done' }))
        return
      }
      setAltEditions((prev) => ({ ...prev, [item.id]: fresh }))

      const priceRes = await fetch('/api/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isbns: fresh.map((e) => e.isbn) }),
      })
      if (!priceRes.ok) throw new Error(`price lookup failed (${priceRes.status})`)
      const priceData: PriceResponse = await priceRes.json()
      if (probeGen.current !== gen) return
      setListingsByIsbn((prev) => ({ ...prev, ...(priceData.listings ?? {}) }))
      setCoverProbeStatus((prev) => ({ ...prev, [item.id]: 'done' }))
    } catch {
      if (probeGen.current === gen) setCoverProbeStatus((prev) => ({ ...prev, [item.id]: 'error' }))
    }
  }

  async function probeCovers(pending: CartItem[], gen: number) {
    const queue = [...pending]
    const workers = Array.from({ length: Math.min(COVER_PROBE_CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const next = queue.shift()!
        if (probeGen.current !== gen) return
        await probeCoversForItem(next, gen)
      }
    })
    await Promise.all(workers)
  }

  /** Adopt an alternate cover — and the looser condition it needs, if any. */
  async function applyEditionOption(item: CartItem, option: EditionOption) {
    const existing = isbnCandidateOverrides[item.id] ?? item.isbns_candidates ?? []
    const allCandidates = [...new Set([...existing, option.isbn])]
    const newIsbnOverrides = { ...isbnCandidateOverrides, [item.id]: allCandidates }
    const newCondOverrides = option.addedLabels.length > 0
      ? { ...conditionOverrides, [item.id]: option.newConditions }
      : conditionOverrides

    setIsbnCandidateOverrides(newIsbnOverrides)
    setConditionOverrides(newCondOverrides)
    setRelaxing(true)
    try {
      const patch: Partial<CartItem> = { isbns_candidates: allCandidates }
      if (option.addedLabels.length > 0) patch.conditions = option.newConditions
      fetch(`/api/cart/${encodeURIComponent(cartSlug)}/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).catch(() => {})
      onUpdateItem?.(item.id, patch)

      const overriddenItems = itemsWithIsbn.map((i) => ({
        ...i,
        conditions: newCondOverrides[i.id] ?? i.conditions,
        max_price: i.id in maxPriceOverrides ? maxPriceOverrides[i.id] : i.max_price,
        isbns_candidates: newIsbnOverrides[i.id] ?? i.isbns_candidates,
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

  const failedSources = sourceHealth.filter((s) => s.failed > 0)
  const searchIncomplete = failedSources.length > 0 || uncheckedIsbns.length > 0

  // A book has an entry in coverProbeStatus from the moment it is queued, so the
  // keys double as the count of books already claimed against the batch budget.
  const probeRoom = Math.max(0, coverProbeBudget - Object.keys(coverProbeStatus).length)
  const unqueued = missingItems
    .filter(({ item }) => item.work_id && coverProbeStatus[item.id] === undefined)
    .map(({ item }) => item.id)
  const willProbe = new Set(unqueued.slice(0, probeRoom))
  const deferredProbeCount = unqueued.length - willProbe.size

  // Every book with no listings gets both relaxation axes searched automatically:
  // looser conditions on the edition it already has, and other covers of the same
  // work (each of those probed at the user's conditions first, looser only if needed).
  const missingWithOptions = missingItems.map(({ item, conditions, maxPrice }) => {
    const suggestion = findSuggestion(item, listingsByIsbn, conditions, maxPrice)
    return {
      item,
      maxPrice,
      suggestion,
      nearMiss: suggestion ? null : findNearMissPrice(item, listingsByIsbn, conditions, maxPrice),
      coverOptions: findEditionOptions(item, altEditions[item.id] ?? [], listingsByIsbn, conditions, maxPrice),
      // Books queued for this batch count as probing too, so the panel never
      // flashes "nothing found" before their search has even started.
      probing: coverProbeStatus[item.id] === 'searching' || willProbe.has(item.id),
    }
  })

  const missingIdsKey = missingItems.map((x) => x.item.id).join(',')
  useEffect(() => {
    if (!searched) return
    const room = coverProbeBudget - queuedForProbe.current.size
    if (room <= 0) return
    const pending = missingItems
      .map((x) => x.item)
      .filter((item) => item.work_id && !queuedForProbe.current.has(item.id))
      .slice(0, room)
    if (pending.length === 0) return

    // Claimed synchronously, before any await, so a second run of this effect
    // can't queue the same book twice.
    for (const item of pending) queuedForProbe.current.add(item.id)
    setCoverProbeStatus((prev) => {
      const next = { ...prev }
      for (const item of pending) next[item.id] = 'searching'
      return next
    })
    void probeCovers(pending, probeGen.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searched, missingIdsKey, coverProbeBudget])

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
            <div className="grid grid-cols-5 rounded-lg border overflow-hidden text-xs">
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

            {(() => {
              // Per-source truth from the optimizer when available (a book can be
              // findable overall but unavailable from the active source).
              const missingCount = activeResult?.unassigned
                ? activeResult.unassigned.length
                : missingItems.length
              return missingCount > 0 && (
                <div className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    {missingCount === 1 ? '1 book is' : `${missingCount} books are`} missing from this total.
                    {missingItems.length > 0 && (
                      <>
                        {' '}<a href="#missing-books" className="underline font-medium hover:text-amber-900">See below</a>
                      </>
                    )}
                  </span>
                </div>
              )
            })()}

            {activeResult && activeResult.groups.length > 0 ? (
              <>
                {activeResult.groups.map((group) => (
                  <Card key={group.seller_id} className="overflow-hidden">
                    <CardHeader className="py-2 px-3 bg-muted/50 flex-row items-center justify-between space-y-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <CardTitle className="text-base font-medium truncate">{group.seller_name}</CardTitle>
                        {sourceTab === 'combined' && (() => {
                          const src = getSellerSource(group.seller_id)
                          const badge = SOURCE_BADGE[src]
                          return (
                            <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded ${badge.className}`}>
                              {badge.label}
                            </span>
                          )
                        })()}
                      </div>
                      <span className="text-sm text-muted-foreground shrink-0">
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
                      {group.shipping > 8 && (() => {
                        const suggestions = findShippingRelaxSuggestions(
                          group.assignments,
                          listingsByIsbn,
                          conditionOverrides,
                          maxPriceOverrides,
                        )
                        if (suggestions.length === 0) return null
                        const totalSavings = suggestions.reduce((s, sg) => s + sg.savings, 0)
                        return (
                          <div className="mt-1.5 rounded-md bg-amber-50 border border-amber-200 px-2.5 py-2 space-y-1.5">
                            <div className="flex items-center gap-1.5 text-xs font-medium text-amber-800">
                              <Lightbulb className="h-3.5 w-3.5 shrink-0" />
                              Shipping is ${group.shipping.toFixed(2)} — save up to ${totalSavings.toFixed(2)} by relaxing conditions
                            </div>
                            {suggestions.map((sg) => (
                              <div key={sg.itemId} className="flex items-center justify-between gap-2 text-xs">
                                <span className="text-amber-700 truncate min-w-0">
                                  <span className="font-medium">{sg.title}</span>: ${sg.relaxedPrice.toFixed(2)} accepting {sg.addedLabels.join(' / ')}
                                  <span className="text-amber-600"> (saves ${sg.savings.toFixed(2)})</span>
                                </span>
                                <button
                                  disabled={relaxing}
                                  onClick={() => {
                                    const next = { ...conditionOverrides, [sg.itemId]: sg.newConditions }
                                    applyRelaxation(sg.itemId, next, maxPriceOverrides)
                                  }}
                                  className="shrink-0 text-xs font-medium px-2 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
                                >
                                  Accept
                                </button>
                              </div>
                            ))}
                          </div>
                        )
                      })()}
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full mt-1 h-8 text-sm"
                        onClick={() => openGroup([...new Set(group.assignments.flatMap((a) => a.listings.map((l) => l.url)))])}
                      >
                        <ExternalLink className="h-3 w-3 mr-1.5" />
                        Open {group.assignments.length} listing{group.assignments.length !== 1 ? 's' : ''} on {group.seller_name}
                      </Button>
                    </CardContent>
                  </Card>
                ))}

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

      {searchError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 space-y-1.5">
          <div className="flex items-center gap-1.5 text-sm font-medium text-red-800">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            Couldn&apos;t search for listings
          </div>
          <p className="text-xs text-red-700">{searchError}</p>
          <button
            disabled={loading}
            onClick={findDeals}
            className="text-xs font-medium px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 flex items-center gap-1"
          >
            {loading && <Loader2 className="h-3 w-3 animate-spin" />}
            Try again
          </button>
        </div>
      )}

      {/* Source outages — kept distinct from "nobody is selling this book" */}
      {searched && searchIncomplete && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 space-y-1.5">
          <div className="flex items-center gap-1.5 text-sm font-medium text-red-800">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            The listing search didn&apos;t complete — results below are missing sellers
          </div>
          {failedSources.map((s) => (
            <div key={s.name} className="text-xs text-red-700">
              <span className="font-medium">{s.name}</span>: {s.failed} lookup{s.failed !== 1 ? 's' : ''} failed
              {s.error ? ` (${s.error})` : ''}
            </div>
          ))}
          {uncheckedIsbns.length > 0 && (
            <div className="text-xs text-red-700">
              {uncheckedIsbns.length} edition{uncheckedIsbns.length !== 1 ? 's were' : ' was'} not checked before the
              search ran out of time.
            </div>
          )}
          <button
            disabled={loading}
            onClick={findDeals}
            className="text-xs font-medium px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 flex items-center gap-1"
          >
            {loading && <Loader2 className="h-3 w-3 animate-spin" />}
            Search again
          </button>
        </div>
      )}

      {/* Books with no listings — both relaxation axes searched automatically */}
      {searched && missingItems.length > 0 && (() => {
        const anyProbing = missingWithOptions.some((m) => m.probing)
        const anyOptions = missingWithOptions.some((m) => m.suggestion || m.nearMiss || m.coverOptions.length > 0)
        return (
        <div id="missing-books" className="rounded-lg border border-amber-200 bg-amber-50 divide-y divide-amber-100">
          <div className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-amber-800">
            {anyProbing
              ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              : <AlertCircle className="h-3.5 w-3.5 shrink-0" />}
            <span>
              No listings found for {missingItems.length === 1 ? 'this book' : `${missingItems.length} books`}
              {anyProbing
                ? ' — checking other conditions and covers…'
                : anyOptions
                  ? ' — here is what other conditions and covers turned up'
                  : searchIncomplete
                    ? ' — the search above didn\'t complete, so this may not be the whole picture'
                    : ' — try relaxing constraints'}
            </span>
          </div>
          {missingWithOptions.map(({ item, maxPrice, suggestion, nearMiss, coverOptions, probing }) => {
            const showEditionPicker = editionPickerFor === item.id
            const noOptions = !suggestion && !nearMiss && coverOptions.length === 0
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

                {suggestion && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-amber-700">
                      {suggestion.type === 'condition'
                        ? <>{suggestion.count} cop{suggestion.count === 1 ? 'y' : 'ies'} of this cover accepting <strong>{suggestion.addedLabels.join(' or ')}</strong> condition</>
                        : <>{suggestion.count} cop{suggestion.count === 1 ? 'y' : 'ies'} of this cover if price cap is removed</>
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
                )}

                {nearMiss && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-blue-700">
                      Listing at <strong>${nearMiss.cheapestBlocked.toFixed(2)}</strong> is just ${nearMiss.delta.toFixed(2)} over your ${maxPrice!.toFixed(2)} cap
                    </span>
                    <button
                      disabled={relaxing}
                      onClick={() => {
                        const next = { ...maxPriceOverrides, [item.id]: null }
                        applyRelaxation(item.id, conditionOverrides, next)
                      }}
                      className="shrink-0 text-xs font-medium px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"
                    >
                      {relaxing && <Loader2 className="h-3 w-3 animate-spin" />}
                      Remove cap
                    </button>
                  </div>
                )}

                {coverOptions.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[11px] font-medium text-amber-800">
                      {coverOptions.length === 1
                        ? 'A different cover has listings:'
                        : `${coverOptions.length} different covers have listings:`}
                    </p>
                    {coverOptions.map((opt) => (
                      <div key={opt.isbn} className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <CoverThumb url={opt.edition.cover_url} isbn={opt.isbn} size="w-7 h-10" />
                          <span className="text-xs text-amber-700 min-w-0">
                            <span className="font-medium">${opt.cheapest.toFixed(2)}</span>
                            {` · ${opt.count} listing${opt.count !== 1 ? 's' : ''} · `}
                            {opt.addedLabels.length > 0
                              ? <>accepting <strong>{opt.addedLabels.join(' or ')}</strong></>
                              : CONDITION_LABELS[opt.cheapestCondition]}
                            <span className="block text-amber-600 truncate">
                              {opt.edition.publisher ?? 'Unknown publisher'}
                              {opt.edition.publish_year ? ` · ${opt.edition.publish_year}` : ''}
                            </span>
                          </span>
                        </div>
                        <button
                          disabled={relaxing}
                          onClick={() => applyEditionOption(item, opt)}
                          className="shrink-0 text-xs font-medium px-2 py-1 rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 flex items-center gap-1"
                        >
                          {relaxing && <Loader2 className="h-3 w-3 animate-spin" />}
                          Use this cover
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {probing && (
                  <p className="flex items-center gap-1.5 text-xs text-amber-700">
                    <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                    Checking other covers of this book…
                  </p>
                )}

                {!probing && noOptions && (
                  <p className="text-xs text-amber-700 italic">
                    {coverProbeStatus[item.id] === 'error'
                      ? 'No listings for this edition, and the other-cover search failed.'
                      : coverProbeStatus[item.id] === 'done'
                        ? 'No listings for this edition in any condition, or for the other covers we checked.'
                        : 'No listings found for this edition.'}
                  </p>
                )}

                {item.work_id && !showEditionPicker && !probing && (
                  <button
                    onClick={() => setEditionPickerFor(item.id)}
                    className="text-xs font-medium text-amber-700 hover:text-amber-900 flex items-center gap-1 underline"
                  >
                    <BookOpen className="h-3 w-3" />
                    Browse all editions
                  </button>
                )}

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
                      // Merge rather than replace: a cover probe may have landed
                      // since the picker captured its snapshot.
                      setListingsByIsbn((prev) => ({ ...prev, ...newListings }))
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
          {deferredProbeCount > 0 && (
            <div className="px-3 py-2">
              <button
                onClick={() => setCoverProbeBudget((b) => b + COVER_PROBE_BATCH)}
                className="text-xs font-medium text-amber-700 hover:text-amber-900 flex items-center gap-1 underline"
              >
                <BookOpen className="h-3 w-3" />
                Check other covers for the remaining {deferredProbeCount} book{deferredProbeCount !== 1 ? 's' : ''}
              </button>
            </div>
          )}
        </div>
        )
      })()}

      {/* Per-book listing previews */}
      {searched && itemListingCounts.length > 0 && (
        <div className="rounded-lg border bg-card divide-y">
          {itemListingCounts.map(({ item, listings, conditions, maxPrice }) => {
            if (listings.length === 0) return null
            const deal = findRelaxedDeal(item, listingsByIsbn, listings, conditions, maxPrice)
            const nearMiss = findNearMissPrice(item, listingsByIsbn, conditions, maxPrice)
            const showEditionPicker = editionPickerFor === item.id
            return (
              <div key={item.id} className="px-3 py-2 space-y-1">
                <BookListings
                  item={item}
                  listings={listings}
                  deal={deal}
                  nearMiss={nearMiss}
                  onAcceptDeal={(newConditions) => {
                    const next = { ...conditionOverrides, [item.id]: newConditions }
                    applyRelaxation(item.id, next, maxPriceOverrides)
                  }}
                  onAcceptNearMiss={() => {
                    const next = { ...maxPriceOverrides, [item.id]: null }
                    applyRelaxation(item.id, conditionOverrides, next)
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
                      // Merge rather than replace: a cover probe may have landed
                      // since the picker captured its snapshot.
                      setListingsByIsbn((prev) => ({ ...prev, ...newListings }))
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

      {/* Re-optimizing spinner */}
      {relaxing && Object.keys(resultsBySource).length > 0 && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Re-optimizing with relaxed constraints…
        </div>
      )}
    </div>
  )
}
