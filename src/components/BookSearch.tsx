'use client'

import { useState, useEffect, useRef } from 'react'
import { Search, Loader2, Star } from 'lucide-react'
import { Input } from '@/components/ui/input'
import type { BookSearchResult } from '@/lib/types'
import type { GoodreadsData } from '@/lib/goodreads'
import { formatRatingsCount } from '@/lib/goodreads'

const OL_COVERS = 'https://covers.openlibrary.org'

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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

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

  function handleSelect(book: BookSearchResult) {
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
          className="pl-9"
          placeholder="Search for a book by title or author…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-50 top-full mt-1 w-full bg-background border rounded-lg shadow-lg max-h-80 overflow-y-auto">
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
