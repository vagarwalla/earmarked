'use client'

import { useState, useEffect, useRef } from 'react'
import { Search, Loader2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import type { BookSearchResult } from '@/lib/types'

interface Props {
  onSelect: (book: BookSearchResult) => void
}

export function BookSearch({ onSelect }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<BookSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (query.length < 2) {
      setResults([])
      setOpen(false)
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
      const data = await res.json()
      setResults(data)
      setOpen(true)
      setLoading(false)
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
        <div className="absolute z-50 top-full mt-1 w-full bg-white border rounded-lg shadow-lg max-h-80 overflow-y-auto">
          {results.map((book) => (
            <button
              key={book.work_id}
              className="w-full flex items-center gap-3 px-3 py-2 hover:bg-muted text-left"
              onClick={() => handleSelect(book)}
            >
              {book.cover_url ? (
                <img src={book.cover_url} alt="" className="h-10 w-7 object-cover rounded shrink-0" />
              ) : (
                <div className="h-10 w-7 bg-muted rounded shrink-0 flex items-center justify-center text-xs text-muted-foreground">?</div>
              )}
              <div className="min-w-0">
                <div className="font-medium text-sm truncate">{book.title}</div>
                {book.series && (
                  <div className="text-xs text-muted-foreground italic truncate">{book.series}</div>
                )}
                <div className="text-xs text-muted-foreground">
                  {book.author}{book.first_publish_year ? ` · ${book.first_publish_year}` : ''}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
