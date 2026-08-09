'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, BookMarked, Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { CartItem } from '@/lib/types'
import type { GoodreadsShelf, GoodreadsShelfBook } from '@/lib/goodreadsShelf'

const PROFILE_KEY = 'earmarked:goodreads-profile'

type Step = 'input' | 'shelves' | 'books' | 'importing'

interface Props {
  slug: string
  existingTitles: string[]
  onImported: (items: CartItem[]) => void
}

function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
}

export function GoodreadsImport({ slug, existingTitles, onImported }: Props) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('input')
  const [profile, setProfile] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const [userId, setUserId] = useState<string | null>(null)
  const [shelves, setShelves] = useState<GoodreadsShelf[]>([])
  const [shelfName, setShelfName] = useState<string | null>(null)
  const [books, setBooks] = useState<GoodreadsShelfBook[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const existingSet = new Set(existingTitles.map(normTitle))

  function openDialog() {
    setStep('input')
    setError(null)
    try { setProfile(localStorage.getItem(PROFILE_KEY) ?? '') } catch { /* ignore */ }
    setOpen(true)
  }

  async function handleFindShelves() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/goodreads/shelves?user=${encodeURIComponent(profile)}`)
      const data = await res.json()
      if (!res.ok) {
        setError(data?.error ?? 'Something went wrong')
        return
      }
      try { localStorage.setItem(PROFILE_KEY, profile) } catch { /* ignore */ }
      setUserId(data.userId)
      setShelves(data.shelves)
      if (data.requestedShelf) {
        // The pasted URL pointed at a specific shelf — skip straight to its books
        await loadShelf(data.userId, data.requestedShelf)
      } else {
        setStep('shelves')
      }
    } catch {
      setError('Something went wrong — try again')
    } finally {
      setLoading(false)
    }
  }

  function handlePickShelf(shelf: GoodreadsShelf) {
    if (!userId) return
    loadShelf(userId, shelf.name)
  }

  async function loadShelf(uid: string, name: string) {
    setLoading(true)
    setError(null)
    setShelfName(name)
    try {
      const res = await fetch(`/api/goodreads/shelf?userId=${uid}&shelf=${encodeURIComponent(name)}`)
      const data = await res.json()
      if (!res.ok) {
        setError(data?.error ?? 'Something went wrong')
        return
      }
      const fetched: GoodreadsShelfBook[] = data.books
      setBooks(fetched)
      // Pre-select everything that isn't already in the stack
      setSelected(new Set(fetched.map((b, i) => (existingSet.has(normTitle(b.title)) ? -1 : i)).filter((i) => i >= 0)))
      setStep('books')
    } catch {
      setError('Something went wrong — try again')
    } finally {
      setLoading(false)
    }
  }

  function toggleBook(i: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  async function handleImport() {
    const chosen = books.filter((_, i) => selected.has(i))
    if (chosen.length === 0) return
    setStep('importing')
    setError(null)
    try {
      const res = await fetch('/api/goodreads/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, books: chosen }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data?.error ?? 'Import failed')
        setStep('books')
        return
      }
      onImported(data.items)
      toast.success(`${data.items.length} book${data.items.length !== 1 ? 's' : ''} imported from Goodreads`)
      setOpen(false)
    } catch {
      setError('Import failed — try again')
      setStep('books')
    }
  }

  const selectedCount = selected.size

  return (
    <>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={openDialog}>
        <BookMarked className="h-3.5 w-3.5" />
        Import from Goodreads
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {step !== 'input' && step !== 'importing' && (
                <button
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => { setError(null); setStep(step === 'books' ? 'shelves' : 'input') }}
                  aria-label="Back"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
              )}
              {step === 'input' && 'Import from Goodreads'}
              {step === 'shelves' && 'Choose a shelf'}
              {step === 'books' && `Shelf: ${shelfName}`}
              {step === 'importing' && 'Importing…'}
            </DialogTitle>
          </DialogHeader>

          {step === 'input' && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Paste your Goodreads profile URL to browse your shelves — or paste a
                shelf URL directly (e.g. …/review/list/12345?shelf=sociology) to jump
                straight to it. Your profile needs to be public.
              </p>
              <Input
                placeholder="https://www.goodreads.com/user/show/12345-your-name"
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && profile.trim()) handleFindShelves() }}
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex justify-end">
                <Button onClick={handleFindShelves} disabled={loading || !profile.trim()}>
                  {loading && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                  Find shelves
                </Button>
              </div>
            </div>
          )}

          {step === 'shelves' && (
            <div className="space-y-3">
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="max-h-80 overflow-y-auto -mx-1 px-1 space-y-1">
                {shelves.map((shelf) => (
                  <button
                    key={shelf.name}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-md border hover:bg-muted text-left transition-colors disabled:opacity-50"
                    onClick={() => handlePickShelf(shelf)}
                    disabled={loading}
                  >
                    <span className="font-medium text-sm">{shelf.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {loading && shelf.name === shelfName
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : shelf.count >= 0 ? `${shelf.count} book${shelf.count !== 1 ? 's' : ''}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 'books' && (
            <div className="space-y-3">
              {books.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">This shelf is empty.</p>
              ) : (
                <>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      {selectedCount} of {books.length} selected
                    </span>
                    <div className="flex gap-2">
                      <button
                        className="text-xs text-primary hover:underline"
                        onClick={() => setSelected(new Set(books.map((_, i) => i)))}
                      >
                        Select all
                      </button>
                      <button
                        className="text-xs text-primary hover:underline"
                        onClick={() => setSelected(new Set())}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  <div className="max-h-80 overflow-y-auto -mx-1 px-1 space-y-1">
                    {books.map((book, i) => {
                      const isSelected = selected.has(i)
                      const isDupe = existingSet.has(normTitle(book.title))
                      return (
                        <button
                          key={`${book.goodreads_id ?? book.title}-${i}`}
                          className={`w-full flex items-center gap-3 px-2 py-1.5 rounded-md text-left transition-colors ${isSelected ? 'bg-muted' : 'hover:bg-muted/50'}`}
                          onClick={() => toggleBook(i)}
                        >
                          <span
                            className={`shrink-0 h-4 w-4 rounded border flex items-center justify-center ${isSelected ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/40'}`}
                          >
                            {isSelected && <Check className="h-3 w-3" />}
                          </span>
                          {book.cover_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={book.cover_url} alt="" className="shrink-0 h-10 w-7 object-cover rounded" />
                          ) : (
                            <div className="shrink-0 h-10 w-7 bg-muted rounded" />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium truncate">{book.title}</span>
                            <span className="block text-xs text-muted-foreground truncate">
                              {book.author}
                              {isDupe && <span className="ml-1.5 text-amber-600 dark:text-amber-500">· already in stack</span>}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  {error && <p className="text-sm text-destructive">{error}</p>}
                  <div className="flex justify-end">
                    <Button onClick={handleImport} disabled={selectedCount === 0}>
                      Add {selectedCount} book{selectedCount !== 1 ? 's' : ''} to stack
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {step === 'importing' && (
            <div className="py-8 flex flex-col items-center gap-3 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              <p className="text-sm">Matching books and adding them to your stack…</p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
