'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { Loader2, Star, ChevronDown, X } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { BookSearchResult, Edition, Format } from '@/lib/types'

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
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground mb-0.5"
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

  useEffect(() => {
    if (!book || !open) return
    setLoading(true)
    setEditions([])
    setSelectedKeys([])
    setPublisherFilter(new Set())
    setYearFilter(new Set())
    setTitleFilter(new Set())
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

        <p className="text-xs text-muted-foreground shrink-0 -mt-1">
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
          <div className="ml-auto flex gap-1 border rounded-md overflow-hidden text-xs">
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
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-3 w-3" /> Clear filters
            </button>
          )}
          {!loading && (
            <span className="ml-auto text-xs text-muted-foreground">
              {sorted.length} edition{sorted.length !== 1 ? 's' : ''}
            </span>
          )}
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
          ) : (
            <div className="space-y-6 py-2">
              {publisherSections.map(({ label, groups }) => (
                <div key={label}>
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 px-1">
                    {label}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                    {groups.map((group) => {
                      const rep = bestEdition(group, formatFilter)
                      const selIdx = selectedKeys.indexOf(group.key)
                      const isSelected = selIdx !== -1
                      const isPrimary = selIdx === 0
                      const isFirstEdition = group.key === firstEditionKey

                      return (
                        <button
                          key={group.key}
                          onClick={() => toggleCard(group.key)}
                          className={`relative rounded-lg p-2 text-left transition-all border-2 ${
                            isPrimary
                              ? 'border-amber-500 bg-amber-50'
                              : isSelected
                              ? 'border-primary bg-primary/5'
                              : 'border-transparent hover:border-border'
                          }`}
                        >
                          {/* Selection badge */}
                          {isSelected && (
                            <div
                              className={`absolute top-2 right-2 rounded-full px-1.5 py-0.5 z-10 flex items-center gap-0.5 text-[10px] font-semibold leading-none ${
                                isPrimary
                                  ? 'bg-amber-500 text-white'
                                  : 'bg-primary text-primary-foreground'
                              }`}
                            >
                              {isPrimary && <Star className="h-2.5 w-2.5 fill-white" />}
                              {isPrimary ? 'Top' : `#${selIdx + 1}`}
                            </div>
                          )}

                          {/* First-edition star when not selected */}
                          {isFirstEdition && !isSelected && (
                            <div className="absolute top-2 right-2 bg-amber-400 rounded-full p-1 z-10" title="First edition">
                              <Star className="h-3 w-3 text-white fill-white" />
                            </div>
                          )}

                          <div className="aspect-[2/3] bg-muted rounded overflow-hidden mb-3 flex items-center justify-center">
                            {group.cover_url ? (
                              <img
                                src={group.cover_url}
                                alt={rep.title}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <div className="text-center px-2">
                                <div className="text-[10px] text-muted-foreground leading-tight line-clamp-3">{rep.publisher ?? 'No cover'}</div>
                              </div>
                            )}
                          </div>
                          <div className="text-sm leading-snug space-y-1 min-h-[72px]">
                            {rep.edition_name && (
                              <div className="font-medium text-foreground line-clamp-2">{rep.edition_name}</div>
                            )}
                            <div className="text-muted-foreground">{rep.publish_year ?? ''}</div>
                            {rep.pages && (
                              <div className="text-muted-foreground text-xs">{rep.pages} pp</div>
                            )}
                            <div className="flex flex-wrap gap-1 pt-0.5">
                              {group.formats.filter((f) => f !== 'any').map((f) => (
                                <span key={f} className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground capitalize">
                                  {f === 'hardcover' ? 'HC' : 'PB'}
                                </span>
                              ))}
                            </div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex gap-2 shrink-0 pt-2 border-t items-center">
          {selectedCount > 0 && (
            <span className="text-xs text-muted-foreground">
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
