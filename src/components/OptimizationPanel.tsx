'use client'

import { useState } from 'react'
import { Loader2, ExternalLink, TrendingDown, Copy, Check, Search, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { CartItem, Listing, OptimizationResult, PriceResponse, SourceInfo } from '@/lib/types'

interface Props {
  items: CartItem[]
  cartSlug: string
}

export function OptimizationPanel({ items, cartSlug }: Props) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<OptimizationResult | null>(null)
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [listingsByIsbn, setListingsByIsbn] = useState<Record<string, Listing[]>>({})
  const [copied, setCopied] = useState(false)

  async function findDeals() {
    if (items.length === 0) return
    setLoading(true)
    setResult(null)
    setSources([])
    setListingsByIsbn({})

    try {
      const isbns = items
        .map((i) => i.isbn_preferred)
        .filter(Boolean) as string[]

      const priceRes = await fetch('/api/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isbns }),
      })
      const priceData: PriceResponse = await priceRes.json()
      setSources(priceData.sources ?? [])

      const byIsbn: Record<string, Listing[]> = priceData.listings ?? {}
      setListingsByIsbn(byIsbn)

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
  const searchedSources = sources.filter((s) => s.found >= 0)
  const browseSources = sources.filter((s) => s.found === -1)

  // Per-book listing status (only shown after a search)
  const searched = result !== null || sources.length > 0
  const itemsWithIsbn = items.filter((i) => i.isbn_preferred)
  const itemListingCounts = itemsWithIsbn.map((item) => ({
    item,
    count: (listingsByIsbn[item.isbn_preferred!] ?? []).length,
  }))
  const foundAnyListings = itemListingCounts.some((x) => x.count > 0)
  const missingItems = itemListingCounts.filter((x) => x.count === 0)

  return (
    <div className="space-y-4">
      {/* Share */}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" className="w-full" onClick={copyShareUrl}>
          {copied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
          {copied ? 'Copied!' : 'Copy cart link'}
        </Button>
      </div>

      {/* Find deals CTA */}
      <Button
        className="w-full"
        size="lg"
        onClick={findDeals}
        disabled={loading || items.length === 0}
      >
        {loading
          ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Finding best deals…</>
          : '🔍 Find Best Deals'
        }
      </Button>

      {hasUnpricedItems && (
        <p className="text-xs text-muted-foreground text-center">
          Some books don&apos;t have an edition selected — choose an edition to get accurate pricing.
        </p>
      )}

      {/* Per-book search results */}
      {searched && itemListingCounts.length > 0 && (
        <div className="rounded-lg border bg-muted/30 px-3 py-2 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1">
            <Search className="h-3 w-3" />
            Searched AbeBooks
          </div>
          {itemListingCounts.map(({ item, count }) => (
            <a
              key={item.id}
              href={`https://www.abebooks.com/servlet/SearchResults?isbn=${item.isbn_preferred}&sortby=17`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between text-xs hover:underline gap-2"
            >
              <span className="truncate text-foreground">{item.title}</span>
              <span className={`shrink-0 ${count > 0 ? 'text-green-700' : 'text-amber-600 font-medium'}`}>
                {count > 0 ? `${count} listing${count !== 1 ? 's' : ''}` : 'none found'}
              </span>
            </a>
          ))}
          {browseSources.length > 0 && (
            <div className="pt-1.5 border-t flex flex-wrap gap-2">
              <span className="text-[10px] text-muted-foreground self-center">Also browse:</span>
              {browseSources.map((s) => (
                <a
                  key={s.name}
                  href={s.search_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] underline text-muted-foreground hover:text-foreground"
                >
                  {s.name}
                  <ExternalLink className="inline h-2.5 w-2.5 ml-0.5 -mt-0.5" />
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {/* No-results warning for specific books */}
      {searched && missingItems.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-medium text-amber-800">
            <AlertCircle className="h-3 w-3" />
            No listings found for {missingItems.length === 1 ? 'this book' : `${missingItems.length} books`}:
          </div>
          {missingItems.map(({ item }) => (
            <div key={item.id} className="text-xs text-amber-700 pl-4">• {item.title}</div>
          ))}
          <p className="text-[10px] text-amber-600 pt-0.5">
            Try browsing AbeBooks or ThriftBooks manually using the links above.
          </p>
        </div>
      )}

      {/* Results */}
      {result && foundAnyListings && (
        <div className="space-y-3">
          {/* Summary */}
          <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-lg px-3 py-2">
            <div>
              <div className="font-semibold text-green-900">
                Total: ${result.grand_total.toFixed(2)}
              </div>
              <div className="text-xs text-green-700">incl. estimated shipping</div>
            </div>
            {result.savings > 0.5 && (
              <Badge className="bg-green-600 text-white">
                <TrendingDown className="h-3 w-3 mr-1" />
                Save ${result.savings.toFixed(2)}
              </Badge>
            )}
          </div>

          {/* Seller groups */}
          {result.groups.map((group) => (
            <Card key={group.seller_id} className="overflow-hidden">
              <CardHeader className="py-2 px-3 bg-muted/50 flex-row items-center justify-between space-y-0">
                <CardTitle className="text-sm font-medium">{group.seller_name}</CardTitle>
                <span className="text-xs text-muted-foreground">
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
                        title={`Open "${item.title}" on AbeBooks`}
                      >
                        {item.title}
                      </a>
                      {quantity > 1 && (
                        <Badge variant="outline" className="text-xs shrink-0">×{quantity}</Badge>
                      )}
                      <Badge variant="secondary" className="text-[10px] shrink-0 capitalize">
                        {listing.condition_normalized.replace('_', ' ')}
                      </Badge>
                    </div>
                    <span className="shrink-0 font-medium ml-2">${subtotal.toFixed(2)}</span>
                  </div>
                ))}
                <div className="border-t pt-1.5 flex justify-between text-xs text-muted-foreground">
                  <span>Shipping (est.): ${group.shipping.toFixed(2)}</span>
                  <span className="font-semibold text-foreground">
                    Group total: ${group.group_total.toFixed(2)}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full mt-1 h-7 text-xs"
                  onClick={() => openGroup(group.assignments.map((a) => a.listing.url))}
                >
                  <ExternalLink className="h-3 w-3 mr-1.5" />
                  Open all {group.assignments.length} listing{group.assignments.length !== 1 ? 's' : ''} on AbeBooks
                </Button>
              </CardContent>
            </Card>
          ))}

          <p className="text-[10px] text-muted-foreground text-center">
            Shipping is estimated at $3.99 first book + $1.99 each additional (same seller). Actual rates may vary.
          </p>
        </div>
      )}
    </div>
  )
}
