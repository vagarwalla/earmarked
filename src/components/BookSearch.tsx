'use client'

import { useState, useEffect, useRef } from 'react'
import { Search, Loader2, Star, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import type { BookSearchResult } from '@/lib/types'
import type { GoodreadsData } from '@/lib/goodreads'
import { formatRatingsCount } from '@/lib/goodreads'

const OL_COVERS = 'https://covers.openlibrary.org'
const HISTORY_KEY = 'earmarked:search-history'
const MAX_HISTORY = 8

function loadHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') } catch { return [] }
}

function saveHistory(terms: string[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(terms))
}

interface Props {
  onSelect: (book: BookSearchResult) => void
}

/** Fetch up to 3 distinct cover URLs for a work from OL's works API */
async function fetchWorkCovers(workId: string): Promise<string[]> {
  try {
    const res = await fetch(`https://openlibrary.org${workId}.json`)
    if (!res.ok) return []
    const data = await res.json()
    const ids: number[] = (data.covers ?? []).filter((id: number) => id > 0)
    return ids.slice(0, 3).map((id) => `${OL_COVERS}/b/id/${id}-M.jpg`)
  } catch {
    return []
  }
}

export function BookSearch({ onSelect }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<BookSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  // work_id → array of cover URLs (lazy-loaded after results render)
  const [coverMap, setCoverMap] = useState<Record<string, string[]>>({})
  // work_id → Goodreads data (lazy-loaded after results render)
  const [goodreadsMap, setGoodreadsMap] = useState<Record<string, GoodreadsData | null>>({})
  const [history, setHistory] = useState<string[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setHistory(loadHistory()) }, [])

  useEffect(() => {
    if (query.length < 2) {
      setResults([])
      setCoverMap({})
      setGoodreadsMap({})
      setOpen(false)
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
      const data: BookSearchResult[] = await res.json()
      setResults(data)
      setCoverMap({})
      setGoodreadsMap({})
      setOpen(true)
      setLoading(false)

      // Lazily fetch covers and Goodreads data in parallel for each result
      const fetchAll = data.map(async (book) => {
        const [covers, grRes] = await Promise.allSettled([
          fetchWorkCovers(book.work_id),
          fetch(`/api/goodreads?title=${encodeURIComponent(book.title)}&author=${encodeURIComponent(book.author)}`),
        ])

        if (covers.status === 'fulfilled' && covers.value.length > 0) {
          setCoverMap((prev) => ({ ...prev, [book.work_id]: covers.value }))
        }

        if (grRes.status === 'fulfilled' && grRes.value.ok) {
          const grData: GoodreadsData | null = await grRes.value.json().catch(() => null)
          setGoodreadsMap((prev) => ({ ...prev, [book.work_id]: grData }))
        }
      })
      await Promise.allSettled(fetchAll)
    }, 400)
  }, [query])

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function addToHistory(term: string) {
    const trimmed = term.trim()
    if (!trimmed) return
    const next = [trimmed, ...loadHistory().filter((h) => h.toLowerCase() !== trimmed.toLowerCase())].slice(0, MAX_HISTORY)
    setHistory(next)
    saveHistory(next)
  }

  function removeFromHistory(term: string) {
    const next = loadHistory().filter((h) => h !== term)
    setHistory(next)
    saveHistory(next)
  }

  function handleHistoryClick(term: string) {
    setQuery(term)
  }

  function handleSelect(book: BookSearchResult) {
    addToHistory(query)
    setQuery('')
    setOpen(false)
    onSelect(book)
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        {loading
          ? <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
          : <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        }
        <Input
          className="pl-9 h-11 rounded-full bg-card border-border/80 shadow-sm"
          placeholder="Search for a book by title or author…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {history.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap mt-2">
          {history.map((term) => (
            <span
              key={term}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground border hover:border-primary/40 transition-colors"
            >
              <button
                className="hover:text-foreground transition-colors"
                onClick={() => handleHistoryClick(term)}
              >
                {term}
              </button>
              <button
                className="hover:text-destructive transition-colors ml-0.5"
                onClick={() => removeFromHistory(term)}
                aria-label={`Remove ${term} from history`}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      {open && results.length > 0 && (
        <div className="absolute z-50 top-full mt-2 w-full bg-popover border border-border/80 rounded-xl shadow-xl max-h-80 overflow-y-auto">
          {results.map((book) => {
            // Use lazily-fetched covers once available, fall back to the single cover from search
            const covers = coverMap[book.work_id] ?? (book.cover_url ? [book.cover_url] : [])
            const gr = goodreadsMap[book.work_id]
            return (
              <button
                key={book.work_id}
                className="w-full flex items-center gap-3 px-3 py-2 hover:bg-muted text-left"
                onClick={() => handleSelect(book)}
              >
                {/* Cover strip: up to 3 edition covers side by side */}
                <div className="flex items-end gap-0.5 shrink-0">
                  {covers.length > 0 ? (
                    covers.map((url, i) => (
                      <img
                        key={i}
                        src={url}
                        alt=""
                        className={`object-cover rounded ${i === 0 ? 'h-12 w-8' : 'h-10 w-6 opacity-60'}`}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                      />
                    ))
                  ) : (
                    <div className="h-10 w-7 bg-muted rounded flex items-center justify-center text-xs text-muted-foreground">?</div>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="font-medium text-base truncate">{book.title}</div>
                  {book.series && (
                    <div className="text-sm text-muted-foreground italic truncate">
                      {book.series}{book.series_number ? ` #${book.series_number}` : ''}
                    </div>
                  )}
                  <div className="text-sm text-muted-foreground flex items-center gap-1.5 flex-wrap">
                    <span>{book.author}{book.first_publish_year ? ` · ${book.first_publish_year}` : ''}</span>
                    {gr && (
                      <span className="flex items-center gap-0.5 text-amber-500">
                        <Star className="h-3 w-3 fill-amber-500" />
                        <span className="text-xs font-medium">{gr.rating.toFixed(2)}</span>
                        <span className="text-xs text-muted-foreground">({formatRatingsCount(gr.ratings_count)})</span>
                      </span>
                    )}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
