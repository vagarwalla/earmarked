'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { Loader2, Star, ChevronDown, X, Check, RefreshCw, Sparkles } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { BookSearchResult, Condition, Edition, Format, Listing } from '@/lib/types'
import { CONDITION_ORDER, CONDITION_LABELS } from '@/lib/relaxation'
import type { GoodreadsData } from '@/lib/goodreads'
import { formatRatingsCount } from '@/lib/goodreads'

// ─── Listings cache (localStorage, 2-hour TTL) ───────────────────────────────

const CACHE_TTL_MS = 2 * 60 * 60 * 1000

function getCachedListings(workId: string): { listings: Record<string, Listing[]>; fetchedAt: number } | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(`earmarked_listings_${workId}`)
    if (!raw) return null
    const parsed: { listings: Record<string, Listing[]>; fetchedAt: number } = JSON.parse(raw)
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null
    return parsed
  } catch { return null }
}

function setCachedListings(workId: string, listings: Record<string, Listing[]>) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(`earmarked_listings_${workId}`, JSON.stringify({ listings, fetchedAt: Date.now() }))
  } catch {}
}

function relativeTime(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ago`
}

// ─── Popularity helpers ───────────────────────────────────────────────────────

/** Scale OCLC library-holdings count to a 0–50 Tier-2 score */
function tier2Score(isbn: string, popularityMap: Record<string, number>): number {
  const h = popularityMap[isbn] ?? -1
  if (h < 0) return 0   // not yet fetched
  if (h <= 1) return 0
  if (h < 10) return 10
  if (h < 100) return 20
  if (h < 1000) return 30
  if (h < 10000) return 40
  return 50
}

function combinedScore(edition: Edition, popularityMap: Record<string, number>): number {
  return edition.popularity_score + tier2Score(edition.isbn, popularityMap)
}

function groupCombinedScore(group: CoverGroup, popularityMap: Record<string, number>): number {
  return Math.max(...group.editions.map((e) => combinedScore(e, popularityMap)))
}

/** True if any edition in the group was digitized by Internet Archive */
function groupIsDigitized(group: CoverGroup): boolean {
  return group.editions.some((e) => e.ocaid != null)
}

// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  book: BookSearchResult | null
  open: boolean
  onOpenChange: (v: boolean) => void
  onConfirm: (editions: Edition[]) => void
  initialIsbns?: string[]
  itemConditions?: Condition[]
}

const FORMAT_LABELS: Record<Format, string> = {
  any: 'All',
  hardcover: 'Hardcover',
  paperback: 'Paperback',
}

export type CoverGroup = {
  key: string
  cover_url: string | null
  editions: Edition[]
  formats: Format[]
}

export function groupEditionsByCover(editions: Edition[]): CoverGroup[] {
  const map = new Map<string, CoverGroup>()
  for (const edition of editions) {
    if (edition.cover_url) {
      const key = edition.cover_id != null ? `id:${edition.cover_id}` : `url:${edition.cover_url}`
      if (!map.has(key)) {
        map.set(key, { key, cover_url: edition.cover_url, editions: [], formats: [] })
      }
      const group = map.get(key)!
      group.editions.push(edition)
      if (!group.formats.includes(edition.format)) group.formats.push(edition.format)
    } else {
      // No cover — give each edition its own group keyed by ISBN
      const key = `no-cover:${edition.isbn}`
      map.set(key, { key, cover_url: null, editions: [edition], formats: edition.format !== 'any' ? [edition.format] : [] })
    }
  }
  return Array.from(map.values())
}

// Internal alias (old lowercase name kept for internal calls)
const groupEditionsBycover = groupEditionsByCover

function bestEdition(group: CoverGroup, formatFilter: Format): Edition {
  if (formatFilter !== 'any') {
    const exact = group.editions.find((e) => e.format === formatFilter)
    if (exact) return exact
  }
  return group.editions.sort((a, b) => {
    const aScore = (a.edition_name ? 1 : 0) + (a.pages ? 1 : 0) + (a.publisher ? 1 : 0)
    const bScore = (b.edition_name ? 1 : 0) + (b.pages ? 1 : 0) + (b.publisher ? 1 : 0)
    return bScore - aScore
  })[0]
}

function YearRangeDropdown({
  availableYears,
  range,
  onChange,
}: {
  availableYears: number[]
  range: { min: number | null; max: number | null }
  onChange: (range: { min: number | null; max: number | null }) => void
}) {
  const [open, setOpen] = useState(false)
  const [panelPos, setPanelPos] = useState({ top: 0, left: 0 })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  function handleOpen() {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setPanelPos({ top: rect.bottom + 4, left: rect.left })
    }
    setOpen((o) => !o)
  }

  const hasFilter = range.min !== null || range.max !== null
  const minYear = availableYears[0]
  const maxYear = availableYears[availableYears.length - 1]
  const label = hasFilter
    ? `${range.min ?? minYear}–${range.max ?? maxYear}`
    : 'Year'

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={handleOpen}
        className={`flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-sm transition-colors whitespace-nowrap ${
          hasFilter
            ? 'border-primary bg-primary/5 text-primary'
            : 'border-input hover:bg-muted text-foreground'
        }`}
      >
        {label}
        <ChevronDown className="h-3.5 w-3.5 opacity-50 shrink-0" />
      </button>
      {open && (
        <div
          ref={panelRef}
          style={{ position: 'fixed', top: panelPos.top, left: panelPos.left }}
          className="z-50 bg-popover text-popover-foreground shadow-md rounded-lg ring-1 ring-foreground/10 p-3 min-w-[200px]"
        >
          <div className="flex items-center gap-2">
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-xs text-muted-foreground">From</label>
              <select
                value={range.min ?? ''}
                onChange={(e) => {
                  const val = e.target.value ? Number(e.target.value) : null
                  onChange({ min: val, max: range.max && val && range.max < val ? val : range.max })
                }}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">Any</option>
                {availableYears.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
            <span className="text-muted-foreground mt-4">–</span>
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-xs text-muted-foreground">To</label>
              <select
                value={range.max ?? ''}
                onChange={(e) => {
                  const val = e.target.value ? Number(e.target.value) : null
                  onChange({ min: range.min && val && range.min > val ? val : range.min, max: val })
                }}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">Any</option>
                {availableYears.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
          </div>
          {hasFilter && (
            <button
              onClick={() => onChange({ min: null, max: null })}
              className="flex items-center gap-1.5 mt-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-3 w-3" /> Clear
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function MultiSelectDropdown<T extends string | number>({
  label,
  options,
  selected,
  onChange,
  renderOption,
}: {
  label: string
  options: T[]
  selected: Set<T>
  onChange: (next: Set<T>) => void
  renderOption?: (opt: T) => string
}) {
  const [open, setOpen] = useState(false)
  const [panelPos, setPanelPos] = useState({ top: 0, left: 0 })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  function handleOpen() {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setPanelPos({ top: rect.bottom + 4, left: rect.left })
    }
    setOpen((o) => !o)
  }

  const count = selected.size

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={handleOpen}
        className={`flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-sm transition-colors whitespace-nowrap ${
          count > 0
            ? 'border-primary bg-primary/5 text-primary'
            : 'border-input hover:bg-muted text-foreground'
        }`}
      >
        {label}
        {count > 0 && (
          <span className="bg-primary text-primary-foreground rounded-full text-xs w-4 h-4 flex items-center justify-center leading-none">
            {count}
          </span>
        )}
        <ChevronDown className="h-3.5 w-3.5 opacity-50 shrink-0" />
      </button>
      {open && (
        <div
          ref={panelRef}
          style={{ position: 'fixed', top: panelPos.top, left: panelPos.left }}
          className="z-50 bg-popover text-popover-foreground shadow-md rounded-lg ring-1 ring-foreground/10 min-w-[180px] max-h-60 overflow-y-auto p-1"
        >
          {options.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">No options available</div>
          ) : (
            <>
              {count > 0 && (
                <button
                  onClick={() => onChange(new Set())}
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground mb-0.5"
                >
                  <X className="h-3 w-3" /> Clear
                </button>
              )}
              {options.map((opt) => {
                const isSelected = selected.has(opt)
                return (
                  <button
                    key={String(opt)}
                    onClick={() => {
                      const next = new Set(selected)
                      if (isSelected) next.delete(opt)
                      else next.add(opt)
                      onChange(next)
                    }}
                    className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-sm hover:bg-accent hover:text-accent-foreground text-left"
                  >
                    <div
                      className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 ${
                        isSelected ? 'bg-primary border-primary' : 'border-input'
                      }`}
                    >
                      {isSelected && <X className="h-2.5 w-2.5 text-white" />}
                    </div>
                    <span className="truncate">{renderOption ? renderOption(opt) : String(opt)}</span>
                  </button>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}

type ConditionStat = { condition: Condition; count: number; cheapest: number; url: string }
type EditionStats = { count: number; primaryIsbn: string; byCondition: ConditionStat[] } | null | undefined

function EditionCard({
  group, formatFilter, selectedKeys, firstEditionKey, onToggle, popularityMap, onHover, onUnhover, stats,
}: {
  group: CoverGroup
  formatFilter: Format
  selectedKeys: string[]
  firstEditionKey: string | null
  onToggle: (key: string) => void
  popularityMap: Record<string, number>
  onHover: (group: CoverGroup) => void
  onUnhover: () => void
  stats: EditionStats
}) {
  const rep = bestEdition(group, formatFilter)
  const selIdx = selectedKeys.indexOf(group.key)
  const isSelected = selIdx !== -1
  const isPrimary = selIdx === 0
  const isFirstEdition = group.key === firstEditionKey
  const isDigitized = groupIsDigitized(group)
  return (
    <div
      onClick={() => onToggle(group.key)}
      onMouseEnter={() => onHover(group)}
      onMouseLeave={onUnhover}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(group.key) } }}
      role="button"
      tabIndex={0}
      className={`relative rounded-lg p-2 text-left transition-all border-2 cursor-pointer ${isPrimary ? 'border-amber-500 bg-amber-50' : isSelected ? 'border-primary bg-primary/5' : 'border-transparent hover:border-border'}`}
    >
      {isSelected && (
        <div className={`absolute top-2 right-2 rounded-full px-1.5 py-0.5 z-10 flex items-center gap-0.5 text-xs font-semibold leading-none ${isPrimary ? 'bg-amber-500 text-white' : 'bg-primary text-primary-foreground'}`}>
          {isPrimary && <Star className="h-2.5 w-2.5 fill-white" />}
          {isPrimary ? 'Top' : `#${selIdx + 1}`}
        </div>
      )}
      {isFirstEdition && !isSelected && (
        <div className="absolute top-2 right-2 bg-amber-400 rounded-full p-1 z-10" title="First edition">
          <Star className="h-3 w-3 text-white fill-white" />
        </div>
      )}
      <div className="aspect-[2/3] bg-muted rounded overflow-hidden mb-3 flex items-center justify-center">
        {group.cover_url ? (
          <img src={group.cover_url} alt={rep.title} className="w-full h-full object-cover" />
        ) : (
          <div className="text-center px-2">
            <div className="text-xl font-medium text-muted-foreground leading-tight">No cover art found</div>
          </div>
        )}
      </div>
      <div className="text-sm leading-snug space-y-1 min-h-[72px]">
        {(rep.edition_name || rep.title) && (
          <div className="font-medium text-foreground line-clamp-2">{rep.edition_name || rep.title}</div>
        )}
        {rep.publisher && <div className="text-muted-foreground line-clamp-2">{rep.publisher}</div>}
        <div className="flex justify-between items-baseline gap-1">
          <span className="text-muted-foreground">{rep.publish_year ?? ''}</span>
          <span className="text-xs text-muted-foreground/60 shrink-0">{rep.isbn}</span>
        </div>
        {rep.pages && <div className="text-muted-foreground text-sm">{rep.pages} pp</div>}
        <div className="flex flex-wrap items-center gap-1 pt-0.5">
          {group.formats.filter((f) => f !== 'any').map((f) => (
            <span key={f} className="text-sm px-2 py-0.5 rounded bg-muted text-muted-foreground capitalize">
              {f === 'hardcover' ? 'HC' : 'PB'}
            </span>
          ))}
          {isDigitized && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 font-medium" title="A copy of this edition is preserved in the Internet Archive">
              Digitized
            </span>
          )}
        </div>
        <div className="pt-1 text-[11px] leading-snug">
          {stats === undefined && (
            <span className="text-muted-foreground">Checking…</span>
          )}
          {stats === null && (
            <span className="text-muted-foreground italic">No listings</span>
          )}
          {stats && (
            <>
              <a
                href={`https://www.abebooks.com/servlet/SearchResults?isbn=${stats.primaryIsbn}&sortby=17`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-green-700 font-medium hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {stats.count} listing{stats.count !== 1 ? 's' : ''} total
              </a>
              {stats.byCondition.length > 0 && (
                <span className="text-muted-foreground">
                  {' ('}
                  {stats.byCondition.map((c, i) => (
                    <span key={c.condition}>
                      {i > 0 && ', '}
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-green-700 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {CONDITION_LABELS[c.condition]} from ${c.cheapest.toFixed(2)}
                      </a>
                    </span>
                  ))}
                  {')'}
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function EditionDetailPanel({ group }: { group: CoverGroup | null }) {
  if (!group) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground text-center px-4">
        Hover an edition to preview details
      </div>
    )
  }

  const editions = group.editions.slice().sort((a, b) => {
    const score = (e: typeof a) => (e.publish_year ? 1 : 0) + (e.publisher ? 1 : 0) + (e.pages ? 1 : 0)
    return score(b) - score(a)
  })

  return (
    <div className="flex flex-col gap-3 p-3 overflow-y-auto h-full">
      {group.cover_url && (
        <img
          src={group.cover_url}
          alt=""
          className="w-full rounded-lg object-cover object-top shadow-sm"
          style={{ maxHeight: 200 }}
        />
      )}
      <div className="space-y-3">
        {editions.map((e) => (
          <div key={e.isbn} className="text-xs space-y-1 border-b border-border last:border-0 pb-3 last:pb-0">
            {e.edition_name && <div className="font-semibold text-sm text-foreground">{e.edition_name}</div>}
            {e.publisher && <div className="text-muted-foreground">{e.publisher}</div>}
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
              {e.publish_year && <span>{e.publish_year}</span>}
              {e.pages && <span>{e.pages} pp</span>}
              {e.format !== 'any' && <span>{e.format === 'hardcover' ? 'Hardcover' : 'Paperback'}</span>}
            </div>
            <div className="font-mono text-muted-foreground/60 text-[10px]">{e.isbn}</div>
            {e.ocaid && (
              <span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 font-medium">Digitized</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function SectionHeader({
  label, groups, selectedKeys, onToggleGroup,
}: {
  label: string; groups: CoverGroup[]; selectedKeys: string[]; onToggleGroup: (keys: string[]) => void
}) {
  const groupKeys = groups.map((g) => g.key)
  const selectedCount = groupKeys.filter((k) => selectedKeys.includes(k)).length
  const allSelected = selectedCount === groupKeys.length
  const someSelected = selectedCount > 0 && !allSelected
  return (
    <button
      onClick={() => onToggleGroup(groupKeys)}
      className="flex items-center gap-2.5 w-full px-3 py-2.5 bg-muted/60 hover:bg-muted transition-colors text-left"
    >
      <div className={`h-4 w-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
        allSelected ? 'bg-primary border-primary' : someSelected ? 'border-primary bg-primary/10' : 'border-input bg-background'
      }`}>
        {allSelected && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
        {someSelected && <div className="h-0.5 w-2 bg-primary rounded-full" />}
      </div>
      <span className="text-sm font-medium text-foreground flex-1">{label}</span>
      <span className="text-sm text-muted-foreground shrink-0">
        {selectedCount > 0 ? `${selectedCount} / ${groupKeys.length} selected` : `${groupKeys.length} edition${groupKeys.length !== 1 ? 's' : ''}`}
      </span>
    </button>
  )
}


export function EditionPicker({ book, open, onOpenChange, onConfirm, initialIsbns, itemConditions }: Props) {
  const [editions, setEditions] = useState<Edition[]>([])
  const [loading, setLoading] = useState(false)
  const [formatFilter, setFormatFilter] = useState<Set<Format>>(new Set())
  const [language, setLanguage] = useState('eng')
  // Ordered list of selected cover-group keys: index 0 = primary/top pick
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [publisherFilter, setPublisherFilter] = useState<Set<string>>(new Set())
  const [yearRange, setYearRange] = useState<{ min: number | null; max: number | null }>({ min: null, max: null })
  const [titleFilter, setTitleFilter] = useState<Set<string>>(new Set())
  const [groupBy, setGroupBy] = useState<'publisher' | 'visual'>('publisher')
  const [sortBy, setSortBy] = useState<'year' | 'popularity'>('year')
  const [clusterMap, setClusterMap] = useState<Record<string, string>>({})
  const [hashesLoading, setHashesLoading] = useState(false)
  const [popularityMap, setPopularityMap] = useState<Record<string, number>>({})
  const [popularityLoading, setPopularityLoading] = useState(false)
  const [olReads, setOlReads] = useState<number | null>(null)
  const [hoveredGroup, setHoveredGroup] = useState<CoverGroup | null>(null)
  const [listingStats, setListingStats] = useState<Record<string, Exclude<EditionStats, undefined>>>({})
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [, setTick] = useState(0)
  const [hideNoListings, setHideNoListings] = useState(true)
  const [goodreadsData, setGoodreadsData] = useState<GoodreadsData | null>(null)

  useEffect(() => {
    if (!book || !open) return
    setLoading(true)
    setEditions([])
    setSelectedKeys([])
    setFormatFilter(new Set())
    setPublisherFilter(new Set())
    setYearRange({ min: null, max: null })
    setTitleFilter(new Set())
    setClusterMap({})
    setHashesLoading(false)
    setPopularityMap({})
    setPopularityLoading(false)
    setOlReads(null)
    setListingStats({})
    setLastFetchedAt(null)
    setStatsLoading(false)
    setHideNoListings(true)
    setGoodreadsData(null)

    // Lazily fetch Goodreads rating in parallel
    fetch(`/api/goodreads?title=${encodeURIComponent(book.title)}&author=${encodeURIComponent(book.author)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data: GoodreadsData | null) => setGoodreadsData(data))
      .catch(() => {})

    fetch(`/api/editions?workId=${encodeURIComponent(book.work_id)}&language=${language}`)
      .then((r) => r.json())
      .then((data: Edition[]) => {
        setEditions(data)
        setLoading(false)
        if (initialIsbns && initialIsbns.length > 0) {
          const groups = groupEditionsBycover(data)
          const isbnToKey = new Map<string, string>()
          for (const g of groups) {
            for (const e of g.editions) isbnToKey.set(e.isbn, g.key)
          }
          const keys: string[] = []
          const seen = new Set<string>()
          for (const isbn of initialIsbns) {
            const key = isbnToKey.get(isbn)
            if (key && !seen.has(key)) { seen.add(key); keys.push(key) }
          }
          if (keys.length > 0) setSelectedKeys(keys)
        }
      })
  }, [book, open, language])

  // Lazily fetch OCLC library-holdings for all edition ISBNs (Tier-2 popularity)
  useEffect(() => {
    if (editions.length === 0) return
    const isbns = [...new Set(editions.map((e) => e.isbn))].slice(0, 50)
    setPopularityLoading(true)
    fetch('/api/popularity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isbns }),
    })
      .then((r) => r.json())
      .then((data: Record<string, number>) => {
        setPopularityMap(data)
        setPopularityLoading(false)
      })
      .catch(() => setPopularityLoading(false))
  }, [editions])

  // Tick every 30s to keep "X min ago" display live
  useEffect(() => {
    if (!lastFetchedAt) return
    const id = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(id)
  }, [lastFetchedAt])

  async function loadStats(force: boolean) {
    if (editions.length === 0 || !book) return
    const activeConditions = itemConditions ?? CONDITION_ORDER
    const groups = groupEditionsBycover(editions)
    const allIsbns = [...new Set(editions.map((e) => e.isbn))]

    let byIsbn: Record<string, Listing[]>
    let fetchedAt: number

    if (!force) {
      const cached = getCachedListings(book.work_id)
      if (cached) {
        byIsbn = cached.listings
        fetchedAt = cached.fetchedAt
      } else {
        setStatsLoading(true)
        try {
          const res = await fetch('/api/prices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isbns: allIsbns }) })
          const data: { listings: Record<string, Listing[]> } = await res.json()
          byIsbn = data.listings ?? {}
          fetchedAt = Date.now()
          setCachedListings(book.work_id, byIsbn)
        } catch { setStatsLoading(false); return }
        setStatsLoading(false)
      }
    } else {
      setStatsLoading(true)
      try {
        const res = await fetch('/api/prices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isbns: allIsbns }) })
        const data: { listings: Record<string, Listing[]> } = await res.json()
        byIsbn = data.listings ?? {}
        fetchedAt = Date.now()
        setCachedListings(book.work_id, byIsbn)
      } catch { setStatsLoading(false); return }
      setStatsLoading(false)
    }

    setLastFetchedAt(fetchedAt)
    const stats: Record<string, Exclude<EditionStats, undefined>> = {}
    for (const group of groups) {
      const groupListings = group.editions.flatMap((e) => byIsbn[e.isbn] ?? [])
      const qualifying = groupListings.filter((l) => activeConditions.includes(l.condition_normalized))
      if (qualifying.length === 0) { stats[group.key] = null; continue }
      const isbnCounts = new Map<string, number>()
      for (const l of qualifying) isbnCounts.set(l.isbn, (isbnCounts.get(l.isbn) ?? 0) + 1)
      const primaryIsbn = [...isbnCounts.entries()].reduce((a, b) => b[1] > a[1] ? b : a)[0]
      const byCondition: ConditionStat[] = activeConditions.flatMap((cond) => {
        const condListings = qualifying.filter((l) => l.condition_normalized === cond)
        if (condListings.length === 0) return []
        const cheapest = condListings.reduce((a, b) => a.price <= b.price ? a : b)
        return [{ condition: cond, count: condListings.length, cheapest: cheapest.price, url: cheapest.url }]
      })
      stats[group.key] = { count: qualifying.length, primaryIsbn, byCondition }
    }
    setListingStats(stats)
  }

  useEffect(() => {
    loadStats(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editions])

  // Fallback: fetch work-level "already read" count from Open Library
  // This is guaranteed to work (same origin as the editions API) and fires immediately.
  useEffect(() => {
    if (!book) return
    fetch(`https://openlibrary.org${book.work_id}/bookshelves.json`)
      .then((r) => r.json())
      .then((data) => {
        const count = data?.counts?.already_read ?? 0
        if (count > 0) setOlReads(count)
      })
      .catch(() => {})
  }, [book])

  const coverGroups = useMemo(() => groupEditionsBycover(editions), [editions])

  const availablePublishers = useMemo(() => {
    const set = new Set<string>()
    for (const group of coverGroups) {
      for (const e of group.editions) {
        if (e.publisher) set.add(e.publisher)
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [coverGroups])

  const availableYears = useMemo(() => {
    const set = new Set<number>()
    for (const group of coverGroups) {
      for (const e of group.editions) {
        if (e.publish_year) set.add(e.publish_year)
      }
    }
    return Array.from(set).sort((a, b) => a - b)
  }, [coverGroups])

  const availableTitles = useMemo(() => {
    const set = new Set<string>()
    for (const group of coverGroups) {
      for (const e of group.editions) {
        if (e.title) set.add(e.title)
      }
    }
    return set.size > 1 ? Array.from(set).sort((a, b) => a.localeCompare(b)) : []
  }, [coverGroups])

  const effectiveFormat: Format = formatFilter.size === 1 ? [...formatFilter][0] : 'any'

  const filtered = useMemo(() => {
    return coverGroups.filter((group) => {
      if (hideNoListings && listingStats[group.key] === null) return false
      if (formatFilter.size > 0 && !group.editions.some((e) => formatFilter.has(e.format))) return false
      if (publisherFilter.size > 0 && !group.editions.some((e) => e.publisher && publisherFilter.has(e.publisher))) return false
      if (yearRange.min !== null || yearRange.max !== null) {
        const inRange = group.editions.some((e) => {
          if (!e.publish_year) return false
          if (yearRange.min !== null && e.publish_year < yearRange.min) return false
          if (yearRange.max !== null && e.publish_year > yearRange.max) return false
          return true
        })
        if (!inRange) return false
      }
      if (titleFilter.size > 0 && !group.editions.some((e) => e.title && titleFilter.has(e.title))) return false
      return true
    })
  }, [coverGroups, formatFilter, publisherFilter, yearRange, titleFilter, hideNoListings, listingStats])

  const sorted = useMemo(() => {
    if (sortBy === 'popularity') {
      return [...filtered].sort((a, b) => groupCombinedScore(b, popularityMap) - groupCombinedScore(a, popularityMap))
    }
    const earliestYear = (group: CoverGroup) =>
      group.editions.reduce((min, e) =>
        e.publish_year && (min === null || e.publish_year < min) ? e.publish_year : min
      , null as number | null)
    return [...filtered].sort((a, b) => {
      const ya = earliestYear(a)
      const yb = earliestYear(b)
      if (ya === null && yb === null) return 0
      if (ya === null) return 1
      if (yb === null) return -1
      return ya - yb
    })
  }, [filtered, sortBy, popularityMap])

  const firstEditionKey = sorted[0]?.key ?? null

  const publisherSections = useMemo(() => {
    const fmt: Format = formatFilter.size === 1 ? [...formatFilter][0] : 'any'
    const normalizePublisher = (p: string | null) =>
      p?.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ') ?? ''
    const map = new Map<string, { label: string; groups: CoverGroup[] }>()
    for (const group of sorted) {
      const rep = bestEdition(group, fmt)
      const norm = normalizePublisher(rep.publisher)
      const key = norm || 'unknown'
      if (!map.has(key)) map.set(key, { label: rep.publisher || 'Unknown publisher', groups: [] })
      map.get(key)!.groups.push(group)
    }
    const sections = Array.from(map.values())
    if (sortBy === 'popularity') {
      // Sort editions within each section by popularity (desc)
      for (const section of sections) {
        section.groups.sort((a, b) => groupCombinedScore(b, popularityMap) - groupCombinedScore(a, popularityMap))
      }
      // Sort sections by the best score in each section (desc)
      sections.sort((a, b) => {
        const sA = Math.max(...a.groups.map((g) => groupCombinedScore(g, popularityMap)))
        const sB = Math.max(...b.groups.map((g) => groupCombinedScore(g, popularityMap)))
        return sB - sA
      })
    }
    // When sortBy === 'year', sections and editions keep the year-ordered iteration from `sorted`
    return sections
  }, [sorted, formatFilter, popularityMap, sortBy])

  function fetchClusters(force = false) {
    const coverUrls = [...new Set(
      coverGroups.map((g) => g.cover_url).filter((u): u is string => u !== null)
    )]
    if (coverUrls.length === 0) return
    setClusterMap({})
    setHashesLoading(true)
    fetch('/api/cover-hashes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coverUrls, force }),
    })
      .then((r) => r.json())
      .then((data: { clusters: Record<string, string> }) => {
        setClusterMap(data.clusters ?? {})
        setHashesLoading(false)
      })
      .catch(() => setHashesLoading(false))
  }

  useEffect(() => {
    if (groupBy !== 'visual' || coverGroups.length === 0 || Object.keys(clusterMap).length > 0 || hashesLoading) return
    fetchClusters()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupBy, coverGroups])

  const visualSorted = useMemo(() => {
    const hasClusterData = Object.keys(clusterMap).length > 0

    const withCluster = filtered.map((group) => {
      const rep = hasClusterData && group.cover_url
        ? (clusterMap[group.cover_url] ?? group.cover_url)
        : group.cover_url
      return { group, clusterRep: rep }
    })

    // Best popularity score per cluster (for popularity sort)
    const clusterBestScore = new Map<string | null, number>()
    // Lowest cover_id per cluster (for year sort — lower OL id = older/earlier)
    const clusterOrder = new Map<string | null, number>()
    for (const { group, clusterRep } of withCluster) {
      const s = groupCombinedScore(group, popularityMap)
      if (!clusterBestScore.has(clusterRep) || s > clusterBestScore.get(clusterRep)!) {
        clusterBestScore.set(clusterRep, s)
      }
      if (!clusterOrder.has(clusterRep)) {
        const coverId = group.key.startsWith('id:') ? parseInt(group.key.slice(3), 10) : Infinity
        clusterOrder.set(clusterRep, coverId)
      }
    }

    return [...withCluster]
      .sort((a, b) => {
        if (sortBy === 'popularity') {
          const ca = clusterBestScore.get(a.clusterRep) ?? 0
          const cb = clusterBestScore.get(b.clusterRep) ?? 0
          if (ca !== cb) return cb - ca
          return groupCombinedScore(b.group, popularityMap) - groupCombinedScore(a.group, popularityMap)
        }
        // Year sort: order clusters by lowest cover_id, then editions within cluster likewise
        const oa = clusterOrder.get(a.clusterRep) ?? Infinity
        const ob = clusterOrder.get(b.clusterRep) ?? Infinity
        if (oa !== ob) return oa - ob
        const ia = a.group.key.startsWith('id:') ? parseInt(a.group.key.slice(3), 10) : Infinity
        const ib = b.group.key.startsWith('id:') ? parseInt(b.group.key.slice(3), 10) : Infinity
        return ia - ib
      })
      .map(({ group }) => group)
  }, [clusterMap, filtered, popularityMap, sortBy])

  // Build visual sections from visualSorted for rendering
  const visualSections = useMemo((): { clusterRep: string | null; groups: CoverGroup[] }[] => {
    const hasClusterData = Object.keys(clusterMap).length > 0
    const sections: { clusterRep: string | null; groups: CoverGroup[] }[] = []
    for (const group of visualSorted) {
      const rep = hasClusterData && group.cover_url
        ? (clusterMap[group.cover_url] ?? group.cover_url)
        : group.cover_url
      const last = sections[sections.length - 1]
      if (last && last.clusterRep === rep) {
        last.groups.push(group)
      } else {
        sections.push({ clusterRep: rep, groups: [group] })
      }
    }
    return sections
  }, [clusterMap, visualSorted])

  const hasActiveFilters = formatFilter.size > 0 || publisherFilter.size > 0 || yearRange.min !== null || yearRange.max !== null || titleFilter.size > 0

  function clearAllFilters() {
    setFormatFilter(new Set())
    setPublisherFilter(new Set())
    setYearRange({ min: null, max: null })
    setTitleFilter(new Set())
  }

  const statsLoaded = Object.keys(listingStats).length > 0


  function toggleCard(key: string) {
    setSelectedKeys((prev) => {
      if (prev.includes(key)) {
        if (prev.length === 1) return prev // can't deselect the only selection
        return prev.filter((k) => k !== key)
      }
      return [...prev, key]
    })
  }

  function toggleGroup(groupKeys: string[]) {
    setSelectedKeys((prev) => {
      const allSelected = groupKeys.every((k) => prev.includes(k))
      if (allSelected) {
        const remaining = prev.filter((k) => !groupKeys.includes(k))
        return remaining.length > 0 ? remaining : prev
      }
      return [...prev, ...groupKeys.filter((k) => !prev.includes(k))]
    })
  }

  function handleConfirm() {
    if (selectedKeys.length === 0) return
    const chosenEditions = selectedKeys
      .map((key) => {
        const group = coverGroups.find((g) => g.key === key)
        return group ? bestEdition(group, effectiveFormat) : null
      })
      .filter((e): e is Edition => e !== null)
    if (chosenEditions.length === 0) return
    onConfirm(chosenEditions)
    onOpenChange(false)
  }

  const primaryKey = selectedKeys[0] ?? null
  const selectedCount = selectedKeys.length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-6xl w-[95vw] max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <span>Choose editions — {book?.title}</span>
            {goodreadsData && (
              <a
                href={goodreadsData.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 text-sm font-normal text-amber-600 hover:text-amber-700 transition-colors shrink-0"
                title="View on Goodreads"
              >
                <Star className="h-3.5 w-3.5 fill-amber-500 text-amber-500" />
                <span className="font-medium">{goodreadsData.rating.toFixed(2)}</span>
                <span className="text-muted-foreground">({formatRatingsCount(goodreadsData.ratings_count)} ratings)</span>
              </a>
            )}
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground shrink-0 -mt-1">
          Pick one or more editions you&apos;d accept. First picked = top preference. All are searched for the best price.
        </p>

        {/* Filters: single row */}
        <div className="flex items-center gap-2 shrink-0 overflow-x-auto pb-0.5">
          <button
            onClick={() => loadStats(true)}
            disabled={statsLoading}
            className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-input hover:bg-muted text-sm text-muted-foreground transition-colors shrink-0 disabled:opacity-50"
            title="Refresh listings from AbeBooks"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${statsLoading ? 'animate-spin' : ''}`} />
            {lastFetchedAt ? relativeTime(lastFetchedAt) : statsLoading ? 'Fetching…' : 'Fetch listings'}
          </button>
          <div className="w-px h-4 bg-border shrink-0" />
          <MultiSelectDropdown
            label="Format"
            options={(['hardcover', 'paperback'] as Format[])}
            selected={formatFilter}
            onChange={setFormatFilter}
            renderOption={(f) => FORMAT_LABELS[f as Format]}
          />
          <MultiSelectDropdown
            label="Publisher"
            options={availablePublishers}
            selected={publisherFilter}
            onChange={setPublisherFilter}
          />
          <YearRangeDropdown
            availableYears={availableYears}
            range={yearRange}
            onChange={setYearRange}
          />
          {availableTitles.length > 0 && (
            <MultiSelectDropdown
              label="Title"
              options={availableTitles}
              selected={titleFilter}
              onChange={setTitleFilter}
            />
          )}
          <div className="flex gap-1 border rounded-md overflow-hidden text-sm shrink-0">
            <button
              className={`px-2.5 py-1.5 transition-colors whitespace-nowrap ${language === 'eng' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'}`}
              onClick={() => setLanguage('eng')}
            >
              English
            </button>
            <button
              className={`px-2.5 py-1.5 transition-colors whitespace-nowrap ${language === 'other' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'}`}
              onClick={() => setLanguage('other')}
            >
              Other languages
            </button>
          </div>
          <button
            onClick={() => setHideNoListings((v) => !v)}
            className={`flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-sm transition-colors whitespace-nowrap shrink-0 ${
              hideNoListings
                ? 'border-primary bg-primary/5 text-primary'
                : 'border-input hover:bg-muted text-muted-foreground'
            }`}
            title={hideNoListings ? 'Showing only editions with listings — click to show all' : 'Click to hide editions with no listings'}
          >
            {hideNoListings ? 'Has listings' : 'All editions'}
            {!statsLoaded && hideNoListings && <Loader2 className="h-3 w-3 animate-spin opacity-50" />}
          </button>
          {hasActiveFilters && (
            <button
              onClick={clearAllFilters}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap shrink-0"
            >
              <X className="h-3 w-3" /> Clear
            </button>
          )}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <div className="flex gap-0 border rounded-md overflow-hidden text-sm shrink-0">
              <button
                className={`px-2.5 py-1.5 transition-colors whitespace-nowrap ${sortBy === 'year' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'}`}
                onClick={() => setSortBy('year')}
              >
                Year
              </button>
              <button
                className={`px-2.5 py-1.5 transition-colors whitespace-nowrap ${sortBy === 'popularity' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'}`}
                onClick={() => setSortBy('popularity')}
              >
                Popular
              </button>
            </div>
            <div className="flex gap-0 border rounded-md overflow-hidden text-sm">
              <button
                className={`px-2.5 py-1.5 transition-colors whitespace-nowrap ${groupBy === 'publisher' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'}`}
                onClick={() => setGroupBy('publisher')}
              >
                Publisher
              </button>
              <button
                className={`flex items-center gap-1.5 px-2.5 py-1.5 transition-colors whitespace-nowrap ${groupBy === 'visual' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'}`}
                onClick={() => setGroupBy('visual')}
              >
                Visual
                {groupBy === 'visual' && hashesLoading && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
                {groupBy === 'visual' && !hashesLoading && Object.keys(clusterMap).length > 0 && (
                  <Sparkles className="h-3 w-3" />
                )}
              </button>
            </div>
            {!loading && (
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                {sorted.length} edition{sorted.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>

        {/* Split pane: grid left, detail panel right */}
        <div className="flex-1 flex gap-0 min-h-0">

        {/* Grid */}
        <div className="flex-1 overflow-y-auto pr-3">
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : sorted.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              No editions found for this filter.
            </div>
          ) : groupBy === 'publisher' ? (
            <div className="space-y-4 py-2">
              {publisherSections.map(({ label, groups }) => (
                <div key={label} className="border border-border rounded-lg overflow-hidden">
                  <SectionHeader label={label} groups={groups} selectedKeys={selectedKeys} onToggleGroup={toggleGroup} />
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 p-3">
                    {groups.map((group) => (
                      <EditionCard key={group.key} group={group} formatFilter={effectiveFormat} selectedKeys={selectedKeys} firstEditionKey={firstEditionKey} onToggle={toggleCard} popularityMap={popularityMap} onHover={(g) => setHoveredGroup(g)} onUnhover={() => setHoveredGroup(null)} stats={group.key in listingStats ? listingStats[group.key] : undefined} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : hashesLoading && Object.keys(clusterMap).length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-4 py-2">
            {!hashesLoading && Object.keys(clusterMap).length > 0 && (
              <div className="flex items-center justify-between px-1">
                <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  Grouped by AI visual similarity
                </span>
                <button
                  onClick={() => fetchClusters(true)}
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Redo AI grouping
                </button>
              </div>
            )}
            <div className="space-y-4">
              {visualSections.map((section, sectionIdx) => {
                const sectionLabel = `Cover design ${sectionIdx + 1}`
                return (
                  <div key={section.clusterRep ?? `no-cover-${sectionIdx}`} className="border border-border rounded-lg overflow-hidden">
                    <SectionHeader label={sectionLabel} groups={section.groups} selectedKeys={selectedKeys} onToggleGroup={toggleGroup} />
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 p-3">
                      {section.groups.map((group) => (
                        <EditionCard key={group.key} group={group} formatFilter={effectiveFormat} selectedKeys={selectedKeys} firstEditionKey={firstEditionKey} onToggle={toggleCard} popularityMap={popularityMap} onHover={(g) => setHoveredGroup(g)} onUnhover={() => setHoveredGroup(null)} stats={group.key in listingStats ? listingStats[group.key] : undefined} />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
            </div>
          )}
        </div>

        {/* Detail panel */}
        <div className="w-52 shrink-0 border-l border-border ml-3">
          <EditionDetailPanel
            group={hoveredGroup ?? (primaryKey ? (coverGroups.find((g) => g.key === primaryKey) ?? null) : null)}
          />
        </div>

        </div>{/* end split pane */}

        <div className="flex gap-2 shrink-0 pt-2 border-t items-center">
          {selectedCount > 0 && (
            <div className="flex items-center gap-2 min-w-0">
              {/* Cover thumbnails for selected editions */}
              <div className="flex items-center gap-0.5 shrink-0">
                {selectedKeys.map((key, i) => {
                  const g = coverGroups.find((g) => g.key === key)
                  if (!g) return null
                  const isPrimary = i === 0
                  const rep = bestEdition(g, effectiveFormat)
                  return g.cover_url ? (
                    <img
                      key={key}
                      src={g.cover_url}
                      alt=""
                      title={rep.publisher ?? rep.publish_year?.toString() ?? ''}
                      className={`object-cover rounded border-2 ${isPrimary ? 'h-10 w-7 border-amber-500' : 'h-8 w-5 border-border opacity-75'}`}
                    />
                  ) : (
                    <div
                      key={key}
                      className={`rounded border-2 bg-muted flex items-center justify-center text-xs text-muted-foreground ${isPrimary ? 'h-10 w-7 border-amber-500' : 'h-8 w-5 border-border opacity-75'}`}
                    >?</div>
                  )
                })}
              </div>
              <span className="text-sm text-muted-foreground truncate">
                {selectedCount} edition{selectedCount !== 1 ? 's' : ''}
                {primaryKey && (() => {
                  const g = coverGroups.find((g) => g.key === primaryKey)
                  const rep = g ? bestEdition(g, effectiveFormat) : null
                  return rep ? ` · top: ${rep.publisher || rep.publish_year || 'selected'}` : ''
                })()}
              </span>
            </div>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleConfirm} disabled={selectedCount === 0}>
              {selectedCount === 0
                ? 'Select an edition'
                : selectedCount === 1
                ? 'Add edition'
                : `Add ${selectedCount} editions`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
