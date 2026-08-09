'use client'

import { useState, useEffect } from 'react'
import { Loader2, Check } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { Edition } from '@/lib/types'

interface Props {
  workId: string | null
  /** Used to find the book's other OL work records, which carry more cover art. */
  title?: string | null
  author?: string | null
  currentCoverUrl: string | null
  open: boolean
  onOpenChange: (v: boolean) => void
  onConfirm: (coverUrl: string) => void
}

export function CoverPicker({ workId, title, author, currentCoverUrl, open, onOpenChange, onConfirm }: Props) {
  const [covers, setCovers] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    if (!workId || !open) return
    setLoading(true)
    setCovers([])
    setSelected(currentCoverUrl)

    const editionParams = new URLSearchParams({ workId, title: title ?? '', author: author ?? '', language: '' })
    fetch(`/api/editions?${editionParams}`)
      .then((r) => r.json())
      .then((editions: Edition[]) => {
        // Collect unique cover URLs, current one first
        const seen = new Set<string>()
        const urls: string[] = []
        if (currentCoverUrl) { seen.add(currentCoverUrl); urls.push(currentCoverUrl) }
        for (const e of editions) {
          if (e.cover_url && !seen.has(e.cover_url)) {
            seen.add(e.cover_url)
            urls.push(e.cover_url)
          }
        }
        setCovers(urls)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [workId, title, author, open, currentCoverUrl])

  function handleConfirm() {
    if (!selected) return
    onConfirm(selected)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Choose cover image</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : covers.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              No cover images found for this book.
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-3 py-2">
              {covers.map((url) => (
                <button
                  key={url}
                  onClick={() => setSelected(url)}
                  className={`relative rounded-lg p-1 border-2 transition-all ${
                    selected === url ? 'border-primary bg-primary/5' : 'border-transparent hover:border-border'
                  }`}
                >
                  {selected === url && (
                    <div className="absolute top-1 right-1 bg-primary rounded-full p-0.5">
                      <Check className="h-2.5 w-2.5 text-white" />
                    </div>
                  )}
                  <div className="aspect-[2/3] bg-muted rounded overflow-hidden">
                    <img
                      src={url}
                      alt="Book cover"
                      className="w-full h-full object-cover"
                    />
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex gap-2 shrink-0 pt-2 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1">
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!selected} className="flex-1">
            Use this cover
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
