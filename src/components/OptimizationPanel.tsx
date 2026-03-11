'use client'

import { useState } from 'react'
import { Loader2, ExternalLink, TrendingDown, Copy, Check, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { CartItem, Listing, OptimizationResult, PriceResponse } from '@/lib/types'

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

function BookListings({ item, listings }: { item: CartItem; listings: Listing[] }) {
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
    </div>
  )
}

export function OptimizationPanel({ items, cartSlug }: Props) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<OptimizationResult | null>(null)
  const [listingsByIsbn, setListingsByIsbn] = useState<Record<string, Listing[]>>({})
  const [searched, setSearched] = useState(false)
  const [copied, setCopied] = useState(false)

  async function findDeals() {
    if (items.length === 0) return
    setLoading(true)
    setResult(null)
    setListingsByIsbn({})
    setSearched(false)

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
    const candidateIsbns = [...new Set([
      ...(item.isbn_preferred ? [item.isbn_preferred] : []),
      ...(item.isbns_candidates ?? []),
    ])]
    const listings = [...new Map(
      candidateIsbns.flatMap((isbn) => listingsByIsbn[isbn] ?? [])
        .map((l) => [l.listing_id, l])
    ).values()].filter((l) =>
      (item.conditions ?? []).includes(l.condition_normalized) &&
      (item.max_price == null || l.price <= item.max_price)
    )
    return { item, listings }
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
          {itemListingCounts.map(({ item, listings }) =>
            listings.length > 0 ? (
              <div key={item.id} className="px-3 py-2">
                <BookListings item={item} listings={listings} />
              </div>
            ) : null
          )}
        </div>
      )}

      {/* Missing books warning */}
      {searched && missingItems.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 space-y-1">
          <div className="flex items-center gap-1.5 text-sm font-medium text-amber-800">
            <AlertCircle className="h-3 w-3" />
            No AbeBooks listings found for:
          </div>
          {missingItems.map(({ item }) => (
            <div key={item.id} className="text-sm text-amber-700 pl-4">
              • {item.title}
              {item.isbn_preferred && (
                <a
                  href={`https://www.abebooks.com/servlet/SearchResults?isbn=${item.isbn_preferred}&sortby=17`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1 underline"
                >
                  search manually
                </a>
              )}
            </div>
          ))}
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
