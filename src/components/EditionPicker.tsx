'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { Loader2, Star, ChevronDown, X, Check, Sparkles } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { BookSearchResult, Edition, Format } from '@/lib/types'
import { clusterByHash } from '@/lib/clustering'

interface Props {
  book: BookSearchResult | null
  open: boolean
  onOpenChange: (v: boolean) => void
  onConfirm: (editions: Edition[]) => void
}

const FORMAT_LABELS: Record<Format, string> = {
  any: 'All',
  hardcover: 'Hardcover',
  paperback: 'Paperback',
}

type CoverGroup = {
  key: string
  cover_url: string | null
  editions: Edition[]
  formats: Format[]
}

function groupEditionsBycover(editions: Edition[]): CoverGroup[] {
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

function MultiSelectDropdown<T extends string | number>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string
  options: T[]
  selected: Set<T>
  onChange: (next: Set<T>) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const count = selected.size

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
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
        <div className="absolute top-full left-0 mt-1 z-50 bg-popover text-popover-foreground shadow-md rounded-lg ring-1 ring-foreground/10 min-w-[180px] max-h-60 overflow-y-auto p-1">
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
                    <span className="truncate">{String(opt)}</span>
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

function EditionCard({
  group, formatFilter, selectedKeys, firstEditionKey, onToggle,
}: {
  group: CoverGroup; formatFilter: Format; selectedKeys: string[]; firstEditionKey: string | null; onToggle: (key: string) => void
}) {
  const rep = bestEdition(group, formatFilter)
  const selIdx = selectedKeys.indexOf(group.key)
  const isSelected = selIdx !== -1
  const isPrimary = selIdx === 0
  const isFirstEdition = group.key === firstEditionKey
  return (
    <button
      onClick={() => onToggle(group.key)}
      className={`relative rounded-lg p-2 text-left transition-all border-2 ${isPrimary ? 'border-amber-500 bg-amber-50' : isSelected ? 'border-primary bg-primary/5' : 'border-transparent hover:border-border'}`}
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
        <div className="flex flex-wrap gap-1 pt-0.5">
          {group.formats.filter((f) => f !== 'any').map((f) => (
            <span key={f} className="text-sm px-2 py-0.5 rounded bg-muted text-muted-foreground capitalize">
              {f === 'hardcover' ? 'HC' : 'PB'}
            </span>
          ))}
        </div>
      </div>
    </button>
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

// ── AI-grouping cache (localStorage, 24-hour TTL) ──────────────────────────
interface AiGroupCache {
  timestamp: number
  clusterUrls: string[]
  mergeGroups: number[]
  clusterLabels: Record<string, string>
}

function aiCacheKey(workId: string, lang: string) {
  return `earmarked:ai-groups:${workId}:${lang}`
}

function loadAiCache(workId: string, lang: string): AiGroupCache | null {
  try {
    const raw = localStorage.getItem(aiCacheKey(workId, lang))
    if (!raw) return null
    const parsed: AiGroupCache = JSON.parse(raw)
    if (Date.now() - parsed.timestamp > 24 * 60 * 60 * 1000) return null
    return parsed
  } catch { return null }
}

function saveAiCache(workId: string, lang: string, clusterUrls: string[], mergeGroups: number[], clusterLabels: Record<string, string>) {
  try {
    localStorage.setItem(aiCacheKey(workId, lang), JSON.stringify({ timestamp: Date.now(), clusterUrls, mergeGroups, clusterLabels }))
  } catch { /* ignore quota errors */ }
}

export function EditionPicker({ book, open, onOpenChange, onConfirm }: Props) {
  const [editions, setEditions] = useState<Edition[]>([])
  const [loading, setLoading] = useState(false)
  const [formatFilter, setFormatFilter] = useState<Format>('any')
  const [language, setLanguage] = useState('eng')
  // Ordered list of selected cover-group keys: index 0 = primary/top pick
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [publisherFilter, setPublisherFilter] = useState<Set<string>>(new Set())
  const [yearFilter, setYearFilter] = useState<Set<number>>(new Set())
  const [titleFilter, setTitleFilter] = useState<Set<string>>(new Set())
  const [groupBy, setGroupBy] = useState<'publisher' | 'visual'>('publisher')
  const [hashMap, setHashMap] = useState<Map<string, bigint>>(new Map())
  const [hashesLoading, setHashesLoading] = useState(false)
  // AI sanity-check state: clusterRep URL → final merged group ID
  const [aiMergeMap, setAiMergeMap] = useState<Map<string, number>>(new Map())
  const [aiCheckLoading, setAiCheckLoading] = useState(false)
  // AI text labels for visual sections: clusterRep URL → label string
  const [clusterLabels, setClusterLabels] = useState<Record<string, string>>({})
  const [labelsLoading, setLabelsLoading] = useState(false)

  useEffect(() => {
    if (!book || !open) return
    setLoading(true)
    setEditions([])
    setSelectedKeys([])
    setPublisherFilter(new Set())
    setYearFilter(new Set())
    setTitleFilter(new Set())
    setHashMap(new Map())
    setHashesLoading(false)
    setAiMergeMap(new Map())
    setAiCheckLoading(false)
    setClusterLabels({})
    setLabelsLoading(false)
    fetch(`/api/editions?workId=${encodeURIComponent(book.work_id)}&language=${language}`)
      .then((r) => r.json())
      .then((data) => {
        setEditions(data)
        setLoading(false)
      })
  }, [book, open, language])

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

  const filtered = useMemo(() => {
    return coverGroups.filter((group) => {
      if (formatFilter !== 'any' && !group.editions.some((e) => e.format === formatFilter)) return false
      if (publisherFilter.size > 0 && !group.editions.some((e) => e.publisher && publisherFilter.has(e.publisher))) return false
      if (yearFilter.size > 0 && !group.editions.some((e) => e.publish_year != null && yearFilter.has(e.publish_year))) return false
      if (titleFilter.size > 0 && !group.editions.some((e) => e.title && titleFilter.has(e.title))) return false
      return true
    })
  }, [coverGroups, formatFilter, publisherFilter, yearFilter, titleFilter])

  const sorted = useMemo(() => {
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
  }, [filtered])

  const firstEditionKey = sorted[0]?.key ?? null

  const publisherSections = useMemo(() => {
    const normalizePublisher = (p: string | null) =>
      p?.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ') ?? ''
    const map = new Map<string, { label: string; groups: CoverGroup[] }>()
    for (const group of sorted) {
      const rep = bestEdition(group, formatFilter)
      const norm = normalizePublisher(rep.publisher)
      const key = norm || 'unknown'
      if (!map.has(key)) map.set(key, { label: rep.publisher || 'Unknown publisher', groups: [] })
      map.get(key)!.groups.push(group)
    }
    return Array.from(map.values())
  }, [sorted, formatFilter])

  useEffect(() => {
    if (groupBy !== 'visual' || coverGroups.length === 0 || hashMap.size > 0 || hashesLoading) return
    const coverUrls = [...new Set(
      coverGroups.map((g) => g.cover_url).filter((u): u is string => u !== null)
    )]
    if (coverUrls.length === 0) return

    setHashesLoading(true)
    fetch('/api/cover-hashes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coverUrls }),
    })
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        const map = new Map<string, bigint>()
        for (const [url, hex] of Object.entries(data)) {
          try { map.set(url, BigInt('0x' + hex)) } catch { /* skip malformed */ }
        }
        setHashMap(map)
        setHashesLoading(false)
      })
      .catch(() => setHashesLoading(false))
  }, [groupBy, coverGroups, hashMap.size, hashesLoading])

  // Step 1: dHash-based initial clusters
  const dHashSections = useMemo((): { clusterRep: string | null; groups: CoverGroup[] }[] => {
    const coverId = (group: CoverGroup) =>
      group.key.startsWith('id:') ? parseInt(group.key.slice(3), 10) : Infinity

    if (hashMap.size === 0) {
      const sorted = [...filtered].sort((a, b) => coverId(a) - coverId(b))
      return sorted.map((group) => ({ clusterRep: group.cover_url, groups: [group] }))
    }

    const urlToCluster = clusterByHash(hashMap, 15)
    const withCluster = filtered.map((group) => ({
      group,
      clusterRep: group.cover_url ? (urlToCluster.get(group.cover_url) ?? group.cover_url) : null,
    }))

    const clusterOrder = new Map<string | null, number>()
    for (const { group, clusterRep } of withCluster) {
      const existing = clusterOrder.get(clusterRep) ?? Infinity
      clusterOrder.set(clusterRep, Math.min(existing, coverId(group)))
    }

    const sorted = [...withCluster].sort((a, b) => {
      const orderA = clusterOrder.get(a.clusterRep) ?? Infinity
      const orderB = clusterOrder.get(b.clusterRep) ?? Infinity
      if (orderA !== orderB) return orderA - orderB
      return coverId(a.group) - coverId(b.group)
    })

    const sections: { clusterRep: string | null; groups: CoverGroup[] }[] = []
    for (const { group, clusterRep } of sorted) {
      const last = sections[sections.length - 1]
      if (last && last.clusterRep === clusterRep) {
        last.groups.push(group)
      } else {
        sections.push({ clusterRep, groups: [group] })
      }
    }
    return sections
  }, [hashMap, filtered])

  // Restore AI grouping from localStorage cache when dHash is ready
  useEffect(() => {
    if (hashMap.size === 0 || aiMergeMap.size > 0 || !book) return
    const cached = loadAiCache(book.work_id, language)
    if (!cached) return
    const clusterUrls = dHashSections.map(s => s.clusterRep).filter((u): u is string => u !== null)
    const cachedSet = new Set(cached.clusterUrls)
    if (clusterUrls.length !== cachedSet.size || clusterUrls.some(u => !cachedSet.has(u))) return
    const map = new Map<string, number>()
    cached.clusterUrls.forEach((url, i) => map.set(url, cached.mergeGroups[i]))
    setAiMergeMap(map)
    setClusterLabels(cached.clusterLabels)
  }, [hashMap.size, dHashSections, aiMergeMap.size, book, language])

  async function runAiEnhance() {
    const clusterUrls = dHashSections.map(s => s.clusterRep).filter((u): u is string => u !== null)
    if (clusterUrls.length < 2) return
    setAiCheckLoading(true)
    try {
      // Step 1: merge check
      const groupsRes = await fetch('/api/cover-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusterUrls }),
      })
      const groupsData: { groups: number[] } = await groupsRes.json()
      const map = new Map<string, number>()
      clusterUrls.forEach((url, i) => map.set(url, groupsData.groups[i]))
      setAiMergeMap(map)

      // Compute merged sections to pass to label-clusters
      const mergedMap = new Map<number, { clusterRep: string | null; groups: CoverGroup[] }>()
      for (const section of dHashSections) {
        const finalId = section.clusterRep != null
          ? (map.get(section.clusterRep) ?? dHashSections.indexOf(section))
          : dHashSections.indexOf(section)
        if (!mergedMap.has(finalId)) mergedMap.set(finalId, { clusterRep: section.clusterRep, groups: [] })
        mergedMap.get(finalId)!.groups.push(...section.groups)
      }
      const mergedSections = Array.from(mergedMap.entries()).sort(([a], [b]) => a - b).map(([, s]) => s)

      // Step 2: labels
      setLabelsLoading(true)
      const clusters = mergedSections
        .filter(s => s.clusterRep !== null && s.groups.length > 0)
        .map(s => ({
          id: s.clusterRep!,
          editions: s.groups.flatMap(g => g.editions).map(e => ({
            publisher: e.publisher, year: e.publish_year, format: e.format, edition_name: e.edition_name,
          })),
        }))
      const labelsRes = await fetch('/api/label-clusters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusters }),
      })
      const labelsData: Record<string, string> = await labelsRes.json()
      setClusterLabels(labelsData)
      setLabelsLoading(false)

      // Cache results for 24 h
      if (book) saveAiCache(book.work_id, language, clusterUrls, groupsData.groups, labelsData)
    } catch { /* fall back to dHash sections */ } finally {
      setAiCheckLoading(false)
      setLabelsLoading(false)
    }
  }

  // Step 3: Apply AI merge map to produce final sections
  const visualSections = useMemo((): { clusterRep: string | null; groups: CoverGroup[] }[] => {
    // While AI check is pending, show dHash sections as-is
    if (aiMergeMap.size === 0) return dHashSections

    // Merge dHash sections that Claude identified as the same cover design
    const merged = new Map<number, { clusterRep: string | null; groups: CoverGroup[] }>()
    for (const section of dHashSections) {
      const finalId = section.clusterRep != null
        ? (aiMergeMap.get(section.clusterRep) ?? dHashSections.indexOf(section))
        : dHashSections.indexOf(section)
      if (!merged.has(finalId)) {
        merged.set(finalId, { clusterRep: section.clusterRep, groups: [] })
      }
      merged.get(finalId)!.groups.push(...section.groups)
    }

    return Array.from(merged.entries())
      .sort(([a], [b]) => a - b)
      .map(([, section]) => section)
  }, [dHashSections, aiMergeMap])

  const hasActiveFilters = publisherFilter.size > 0 || yearFilter.size > 0 || titleFilter.size > 0

  function clearAllFilters() {
    setPublisherFilter(new Set())
    setYearFilter(new Set())
    setTitleFilter(new Set())
  }


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
        return group ? bestEdition(group, formatFilter) : null
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
      <DialogContent className="sm:max-w-5xl w-[90vw] max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Choose editions — {book?.title}</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground shrink-0 -mt-1">
          Pick one or more editions you&apos;d accept. First picked = top preference. All are searched for the best price.
        </p>

        {/* Filters row 1: format + language */}
        <div className="flex flex-wrap gap-2 shrink-0">
          {(['any', 'hardcover', 'paperback'] as Format[]).map((f) => (
            <Button
              key={f}
              variant={formatFilter === f ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFormatFilter(f)}
            >
              {FORMAT_LABELS[f]}
            </Button>
          ))}
          <div className="ml-auto flex gap-1 border rounded-md overflow-hidden text-sm">
            <button
              className={`px-3 py-1.5 transition-colors ${language === 'eng' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'}`}
              onClick={() => setLanguage('eng')}
            >
              English
            </button>
            <button
              className={`px-3 py-1.5 transition-colors ${language === '' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'}`}
              onClick={() => setLanguage('')}
            >
              All languages
            </button>
          </div>
        </div>

        {/* Filters row 2: publisher + year */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <MultiSelectDropdown
            label="Publisher"
            options={availablePublishers}
            selected={publisherFilter}
            onChange={setPublisherFilter}
          />
          <MultiSelectDropdown
            label="Year"
            options={availableYears}
            selected={yearFilter}
            onChange={setYearFilter}
          />
          {availableTitles.length > 0 && (
            <MultiSelectDropdown
              label="Title"
              options={availableTitles}
              selected={titleFilter}
              onChange={setTitleFilter}
            />
          )}
          {hasActiveFilters && (
            <button
              onClick={clearAllFilters}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-3 w-3" /> Clear filters
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <div className="flex gap-0 border rounded-md overflow-hidden text-sm">
              <button
                className={`px-2.5 py-1.5 transition-colors ${groupBy === 'publisher' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'}`}
                onClick={() => setGroupBy('publisher')}
              >
                Publisher
              </button>
              <button
                className={`flex items-center gap-1.5 px-2.5 py-1.5 transition-colors ${groupBy === 'visual' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'}`}
                onClick={() => setGroupBy('visual')}
              >
                Visual
                {groupBy === 'visual' && hashesLoading && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
              </button>
            </div>
            {!loading && (
              <span className="text-sm text-muted-foreground">
                {sorted.length} edition{sorted.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto">
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
                      <EditionCard key={group.key} group={group} formatFilter={formatFilter} selectedKeys={selectedKeys} firstEditionKey={firstEditionKey} onToggle={toggleCard} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : hashesLoading && hashMap.size === 0 ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-4 py-2">
              {hashMap.size > 0 && aiMergeMap.size === 0 && dHashSections.length >= 2 && (
                aiCheckLoading ? (
                  <div className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Analyzing covers with AI…
                  </div>
                ) : (
                  <div className="flex justify-center">
                    <button
                      onClick={runAiEnhance}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg border border-dashed border-amber-400 text-amber-700 hover:bg-amber-50 text-sm transition-colors"
                    >
                      <Sparkles className="h-4 w-4" />
                      Improve grouping with AI
                    </button>
                  </div>
                )
              )}
            <div className="space-y-4">
              {visualSections.map((section, sectionIdx) => {
                const sectionLabel = section.clusterRep
                  ? (clusterLabels[section.clusterRep] ?? (labelsLoading ? '…' : `Cover design ${sectionIdx + 1}`))
                  : `Cover design ${sectionIdx + 1}`
                return (
                  <div key={section.clusterRep ?? `no-cover-${sectionIdx}`} className="border border-border rounded-lg overflow-hidden">
                    <SectionHeader label={sectionLabel} groups={section.groups} selectedKeys={selectedKeys} onToggleGroup={toggleGroup} />
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 p-3">
                      {section.groups.map((group) => (
                        <EditionCard key={group.key} group={group} formatFilter={formatFilter} selectedKeys={selectedKeys} firstEditionKey={firstEditionKey} onToggle={toggleCard} />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
            </div>
          )}
        </div>

        <div className="flex gap-2 shrink-0 pt-2 border-t items-center">
          {selectedCount > 0 && (
            <span className="text-sm text-muted-foreground">
              {selectedCount} edition{selectedCount !== 1 ? 's' : ''} selected
              {primaryKey && (() => {
                const g = coverGroups.find((g) => g.key === primaryKey)
                const rep = g ? bestEdition(g, formatFilter) : null
                return rep ? ` · top: ${rep.publisher || rep.publish_year || 'selected'}` : ''
              })()}
            </span>
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
