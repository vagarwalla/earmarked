'use client'

import { useState, useEffect, useMemo } from 'react'
import { Loader2, Check } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { BookSearchResult, Edition, Format } from '@/lib/types'

interface Props {
  book: BookSearchResult | null
  open: boolean
  onOpenChange: (v: boolean) => void
  onConfirm: (edition: Edition) => void
}

const FORMAT_LABELS: Record<Format, string> = {
  any: 'All',
  hardcover: 'Hardcover',
  paperback: 'Paperback',
}

type CoverGroup = {
  key: string
  cover_url: string
  editions: Edition[]
  formats: Format[]
}

function groupEditionsBycover(editions: Edition[]): CoverGroup[] {
  const map = new Map<string, CoverGroup>()
  for (const edition of editions) {
    if (!edition.cover_url) continue
    const key = edition.cover_id != null ? `id:${edition.cover_id}` : `url:${edition.cover_url}`
    if (!map.has(key)) {
      map.set(key, { key, cover_url: edition.cover_url, editions: [], formats: [] })
    }
    const group = map.get(key)!
    group.editions.push(edition)
    if (!group.formats.includes(edition.format)) {
      group.formats.push(edition.format)
    }
  }
  return Array.from(map.values())
}

function bestEdition(group: CoverGroup, formatFilter: Format): Edition {
  if (formatFilter !== 'any') {
    const exact = group.editions.find((e) => e.format === formatFilter)
    if (exact) return exact
  }
  // Prefer editions with more metadata
  return group.editions.sort((a, b) => {
    const aScore = (a.edition_name ? 1 : 0) + (a.pages ? 1 : 0) + (a.publisher ? 1 : 0)
    const bScore = (b.edition_name ? 1 : 0) + (b.pages ? 1 : 0) + (b.publisher ? 1 : 0)
    return bScore - aScore
  })[0]
}

export function EditionPicker({ book, open, onOpenChange, onConfirm }: Props) {
  const [editions, setEditions] = useState<Edition[]>([])
  const [loading, setLoading] = useState(false)
  const [formatFilter, setFormatFilter] = useState<Format>('any')
  const [language, setLanguage] = useState('eng')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  useEffect(() => {
    if (!book || !open) return
    setLoading(true)
    setEditions([])
    setSelectedKey(null)
    fetch(`/api/editions?workId=${encodeURIComponent(book.work_id)}&language=${language}`)
      .then((r) => r.json())
      .then((data) => {
        setEditions(data)
        setLoading(false)
      })
  }, [book, open, language])

  const coverGroups = useMemo(() => groupEditionsBycover(editions), [editions])

  const filtered = useMemo(() =>
    coverGroups.filter((group) =>
      formatFilter === 'any'
        ? true
        : group.editions.some((e) => e.format === formatFilter)
    ),
    [coverGroups, formatFilter]
  )

  function handleConfirm() {
    const group = filtered.find((g) => g.key === selectedKey)
    if (!group) return
    onConfirm(bestEdition(group, formatFilter))
    onOpenChange(false)
  }

  const selectedGroup = filtered.find((g) => g.key === selectedKey) ?? null
  const previewEdition = selectedGroup ? bestEdition(selectedGroup, formatFilter) : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl w-[90vw] max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Choose cover — {book?.title}</DialogTitle>
        </DialogHeader>

        {/* Filters */}
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

        {/* Grid */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              No editions found for this filter.
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-5 py-2">
              {filtered.map((group) => {
                const rep = bestEdition(group, formatFilter)
                const isSelected = group.key === selectedKey
                return (
                  <button
                    key={group.key}
                    onClick={() => setSelectedKey(group.key)}
                    className={`relative rounded-lg p-2 text-left transition-all border-2 ${
                      isSelected ? 'border-primary bg-primary/5' : 'border-transparent hover:border-border'
                    }`}
                  >
                    {isSelected && (
                      <div className="absolute top-2 right-2 bg-primary rounded-full p-1 z-10">
                        <Check className="h-3.5 w-3.5 text-white" />
                      </div>
                    )}
                    <div className="aspect-[2/3] bg-muted rounded overflow-hidden mb-3 min-h-[240px]">
                      <img
                        src={group.cover_url}
                        alt={rep.title}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div className="text-sm leading-snug space-y-1">
                      {rep.edition_name && (
                        <div className="font-medium text-foreground truncate">{rep.edition_name}</div>
                      )}
                      <div className="text-muted-foreground truncate">
                        {rep.publisher || 'Unknown'}{rep.publish_year ? ` · ${rep.publish_year}` : ''}
                      </div>
                      {rep.pages && (
                        <div className="text-muted-foreground text-xs">{rep.pages} pp</div>
                      )}
                      {/* Format badges */}
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
          )}
        </div>

        <div className="flex gap-2 shrink-0 pt-2 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1">
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!selectedKey} className="flex-1">
            {previewEdition
              ? `Add ${previewEdition.edition_name || previewEdition.publisher || 'this edition'}`
              : 'Select a cover'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
