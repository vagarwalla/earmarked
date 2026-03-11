'use client'

import { useState } from 'react'
import { Loader2, ExternalLink, TrendingDown, Copy, Check, AlertCircle, ChevronDown, ChevronUp, Lightbulb } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { CartItem, Condition, Listing, OptimizationResult, PriceResponse } from '@/lib/types'

// ─── Constraint relaxation helpers ───────────────────────────────────────────

const CONDITION_ORDER: Condition[] = ['new', 'like_new', 'very_good', 'good', 'acceptable']
const CONDITION_LABELS: Record<Condition, string> = {
  new: 'New', like_new: 'Like New', very_good: 'Very Good', good: 'Good', acceptable: 'Acceptable',
}

type RelaxSuggestion =
  | { type: 'condition'; newConditions: Condition[]; addedLabels: string[]; count: number }
  | { type: 'max_price'; count: number }

function computeListings(
  item: CartItem,
  byIsbn: Record<string, Listing[]>,
  conditions: Condition[],
  maxPrice: number | null,
): Listing[] {
  const isbns = [...new Set([
    ...(item.isbn_preferred ? [item.isbn_preferred] : []),
    ...(item.isbns_candidates ?? []),
  ])]
  return [...new Map(
    isbns.flatMap((isbn) => byIsbn[isbn] ?? []).map((l) => [l.listing_id, l])
  ).values()].filter((l) =>
    conditions.includes(l.condition_normalized) &&
    (maxPrice == null || l.price <= maxPrice)
  )
}

/** Find the minimal constraint relaxation that yields at least one listing. */
function findSuggestion(
  item: CartItem,
  byIsbn: Record<string, Listing[]>,
  conditions: Condition[],
  maxPrice: number | null,
): RelaxSuggestion | null {
  // First check: are there ANY raw listings for these ISBNs at all?
  const anyRaw = computeListings(item, byIsbn, CONDITION_ORDER, null)
  if (anyRaw.length === 0) return null  // needs editions relaxation

  // Try expanding conditions one step at a time
  const missing = CONDITION_ORDER.filter((c) => !conditions.includes(c))
  for (let i = 1; i <= missing.length; i++) {
    const expanded = [...conditions, ...missing.slice(0, i)]
    const count = computeListings(item, byIsbn, expanded, maxPrice).length
    if (count > 0) {
      return {
        type: 'condition',
        newConditions: expanded,
        addedLabels: missing.slice(0, i).map((c) => CONDITION_LABELS[c]),
        count,
      }
    }
  }

  // Try removing max_price cap
  if (maxPrice != null) {
    const count = computeListings(item, byIsbn, CONDITION_ORDER, null).length
    if (count > 0) return { type: 'max_price', count }
  }

  return null
}

/** If current cheapest listing > $20, find the minimal relaxation that would save money. */
function findCheaperSuggestion(
  item: CartItem,
  byIsbn: Record<string, Listing[]>,
  currentListings: Listing[],
  conditions: Condition[],
  maxPrice: number | null,
): { addedLabels: string[]; newConditions: Condition[]; cheaperPrice: number } | null {
  if (currentListings.length === 0) return null
  const currentCheapest = Math.min(...currentListings.map((l) => l.price))
  if (currentCheapest <= 20) return null

  const missing = CONDITION_ORDER.filter((c) => !conditions.includes(c))
  if (missing.length === 0) return null

  for (let i = 1; i <= missing.length; i++) {
    const expanded = [...conditions, ...missing.slice(0, i)]
    const expanded_listings = computeListings(item, byIsbn, expanded, maxPrice)
    if (expanded_listings.length === 0) continue
    const cheaperPrice = Math.min(...expanded_listings.map((l) => l.price))
    if (cheaperPrice < currentCheapest - 1) {
      return { addedLabels: missing.slice(0, i).map((c) => CONDITION_LABELS[c]), newConditions: expanded, cheaperPrice }
    }
  }
  return null
}

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
  item, listings, cheaper, onAcceptCheaper,
}: {
  item: CartItem
  listings: Listing[]
  cheaper: { addedLabels: string[]; newConditions: Condition[]; cheaperPrice: number } | null
  onAcceptCheaper: (newConditions: Condition[]) => void
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
              {expanded ? 'Show less' : `${rest.length} more listing${rest.length !== 1 ? 's' : ''}`}
            </button>
          )}
          <span className="text-green-700">{listings.length} listing{listings.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
      {preview.map((l) => <ListingRow key={l.listing_id} listing={l} />)}
      {expanded && rest.map((l) => <ListingRow key={l.listing_id} listing={l} />)}
      {cheaper && (
        <div className="flex items-center justify-between gap-2 mt-1.5 px-2 py-1.5 rounded-md bg-amber-50 border border-amber-200 text-sm">
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
    </div>
  )
}

export function OptimizationPanel({ items, cartSlug }: Props) {
  const [loading, setLoading] = useState(false)
  const [relaxing, setRelaxing] = useState(false)
  const [result, setResult] = useState<OptimizationResult | null>(null)
  const [listingsByIsbn, setListingsByIsbn] = useState<Record<string, Listing[]>>({})
  const [searched, setSearched] = useState(false)
  const [copied, setCopied] = useState(false)
  const [conditionOverrides, setConditionOverrides] = useState<Record<string, Condition[]>>({})
  const [maxPriceOverrides, setMaxPriceOverrides] = useState<Record<string, number | null>>({})

  async function findDeals() {
    if (items.length === 0) return
    setLoading(true)
    setResult(null)
    setListingsByIsbn({})
    setSearched(false)
    setConditionOverrides({})
    setMaxPriceOverrides({})

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

      const optRes = await fetch('/api/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, listingsByIsbn: byIsbn }),
      })
      const optimized: OptimizationResult = await optRes.json()
      setResult(optimized)
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
      // Build items with overrides applied so the optimizer sees the new constraints
      const overriddenItems = itemsWithIsbn.map((i) => ({
        ...i,
        conditions: newCondOverrides[i.id] ?? i.conditions,
        max_price: i.id in newMaxPriceOverrides ? newMaxPriceOverrides[i.id] : i.max_price,
      }))
      const optRes = await fetch('/api/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: overriddenItems, listingsByIsbn }),
      })
      setResult(await optRes.json())
    } catch {
      // silent — listings display already updated via state
    } finally {
      setRelaxing(false)
    }
  }

  function openGroup(urls: string[]) {
    urls.forEach((url) => window.open(url, '_blank', 'noopener'))
  }

  async function copyShareUrl() {
    const url = `${window.location.origin}/cart/${cartSlug}`
    await navigator.clipboard.writeText(url)
    setCopied(true)
    toast.success('Cart link copied!')
    setTimeout(() => setCopied(false), 2000)
  }

  const hasUnpricedItems = items.some((i) => !i.isbn_preferred)
  const itemsWithIsbn = items.filter((i) => i.isbn_preferred)

  const itemListingCounts = itemsWithIsbn.map((item) => {
    const conditions = conditionOverrides[item.id] ?? item.conditions ?? []
    const maxPrice = item.id in maxPriceOverrides ? maxPriceOverrides[item.id] : item.max_price
    const listings = computeListings(item, listingsByIsbn, conditions, maxPrice)
    return { item, listings, conditions, maxPrice }
  })

  const missingItems = itemListingCounts.filter((x) => x.listings.length === 0)
  const foundAnyListings = itemListingCounts.some((x) => x.listings.length > 0)

  return (
    <div className="space-y-4">
      {/* Share */}
      <Button variant="outline" size="sm" className="w-full" onClick={copyShareUrl}>
        {copied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
        {copied ? 'Copied!' : 'Copy cart link'}
      </Button>

      {/* Find deals CTA */}
      <Button
        className="w-full"
        size="lg"
        onClick={findDeals}
        disabled={loading || items.length === 0}
      >
        {loading
          ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Searching AbeBooks…</>
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
            return (
              <div key={item.id} className="px-3 py-2">
                <BookListings
                  item={item}
                  listings={listings}
                  cheaper={cheaper}
                  onAcceptCheaper={(newConditions) => {
                    const next = { ...conditionOverrides, [item.id]: newConditions }
                    applyRelaxation(item.id, next, maxPriceOverrides)
                  }}
                />
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
            No listings found — try relaxing constraints
          </div>
          {missingItems.map(({ item, conditions, maxPrice }) => {
            const suggestion = findSuggestion(item, listingsByIsbn, conditions, maxPrice)
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
                ) : (
                  <p className="text-xs text-amber-700 italic">
                    No listings found even with all conditions — try other editions.
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Re-optimizing spinner overlay on results */}
      {relaxing && result && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Re-optimizing with relaxed constraints…
        </div>
      )}

      {/* Optimization results */}
      {result && foundAnyListings && (
        <div className="space-y-3">
          <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-lg px-3 py-2">
            <div>
              <div className="font-semibold text-green-900">
                Best deal: ${result.grand_total.toFixed(2)}
              </div>
              <div className="text-sm text-green-700">incl. estimated shipping</div>
            </div>
            {result.savings > 0.5 && (
              <Badge className="bg-green-600 text-white">
                <TrendingDown className="h-3 w-3 mr-1" />
                Save ${result.savings.toFixed(2)}
              </Badge>
            )}
          </div>

          {result.groups.map((group) => (
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
                  Open {group.assignments.length} listing{group.assignments.length !== 1 ? 's' : ''} on AbeBooks
                </Button>
              </CardContent>
            </Card>
          ))}

          <p className="text-xs text-muted-foreground text-center">
            Shipping estimated at $3.99 first book + $1.99 each additional from same seller. Actual rates may vary.
          </p>
        </div>
      )}
    </div>
  )
}
