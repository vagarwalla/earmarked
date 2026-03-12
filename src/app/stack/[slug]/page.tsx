'use client'

import { useEffect, useState, use } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { ArrowLeft, BookOpen, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { BookSearch } from '@/components/BookSearch'
import { EditionPicker } from '@/components/EditionPicker'
import { CoverPicker } from '@/components/CoverPicker'
import { CartItemCard } from '@/components/CartItemCard'
import { OptimizationPanel } from '@/components/OptimizationPanel'
import { CartDefaults } from '@/components/CartDefaults'
import { ThemeToggle } from '@/components/ThemeToggle'
import type { Cart, CartItem, BookSearchResult, Edition } from '@/lib/types'

function primaryEdition(editions: Edition[]): Edition { return editions[0] }

export default function CartPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params)
  const router = useRouter()
  const [cart, setCart] = useState<Cart | null>(null)
  const [items, setItems] = useState<CartItem[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Edition picker state
  const [pickerBook, setPickerBook] = useState<BookSearchResult | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  // When changing cover for existing item
  const [editingItem, setEditingItem] = useState<CartItem | null>(null)
  // Cover-only picker state
  const [coverItem, setCoverItem] = useState<CartItem | null>(null)
  const [coverPickerOpen, setCoverPickerOpen] = useState(false)

  useEffect(() => {
    async function load() {
      const [cartRes, itemsRes] = await Promise.all([
        fetch(`/api/cart/${slug}`),
        fetch(`/api/cart/${slug}/items`),
      ])
      if (!cartRes.ok) {
        toast.error('Stack not found')
        setLoading(false)
        return
      }
      setCart(await cartRes.json())
      setItems(await itemsRes.json())
      setLoading(false)
    }
    load()
  }, [slug])

  // User selected a book from search → open edition picker
  function handleBookSelect(book: BookSearchResult) {
    setPickerBook(book)
    setEditingItem(null)
    setPickerOpen(true)
  }

  // User wants to change cover on existing item → open edition picker with that book
  function handleChangeCover(item: CartItem) {
    if (!item.work_id) return
    setPickerBook({
      title: item.title,
      author: item.author || '',
      work_id: item.work_id,
      cover_url: item.cover_url,
      cover_urls: item.cover_url ? [item.cover_url] : [],
      first_publish_year: null,
      series: null,
      series_number: null,
    })
    setEditingItem(item)
    setPickerOpen(true)
  }

  // Edition confirmed — receives ordered array (index 0 = top pick)
  async function handleEditionConfirm(editions: Edition[]) {
    const edition = primaryEdition(editions)
    const isbns_candidates = editions.map((e) => e.isbn)

    if (editingItem) {
      // Update existing item's edition
      await fetch(`/api/cart/${slug}/items/${editingItem.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isbn_preferred: edition.isbn,
          cover_url: edition.cover_url,
          format: edition.format,
          isbns_candidates,
        }),
      })
      setItems((prev) =>
        prev.map((i) =>
          i.id === editingItem.id
            ? { ...i, isbn_preferred: edition.isbn, cover_url: edition.cover_url, format: edition.format, isbns_candidates }
            : i
        )
      )
      toast.success(isbns_candidates.length > 1 ? `${isbns_candidates.length} editions saved` : 'Edition updated')
    } else if (pickerBook) {
      // Add new item
      const res = await fetch(`/api/cart/${slug}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: pickerBook.title,
          author: pickerBook.author,
          work_id: pickerBook.work_id,
          isbn_preferred: edition.isbn,
          cover_url: edition.cover_url,
          isbns_candidates,
          conditions: cart?.default_conditions ?? ['new', 'fine', 'good'],
          format: edition.format !== 'any' ? edition.format : (cart?.default_format ?? 'any'),
          max_price: cart?.default_max_price ?? null,
          flexible: false,
          signed_only: cart?.default_signed_only ?? null,
          first_edition_only: cart?.default_first_edition_only ?? null,
          dust_jacket_only: cart?.default_dust_jacket_only ?? null,
          quantity: 1,
          sort_order: items.length,
        }),
      })
      const newItem = await res.json()
      if (!res.ok) {
        toast.error(`Failed to add book: ${newItem?.error ?? res.statusText}`)
      } else {
        setItems((prev) => [...prev, newItem])
        toast.success(`"${pickerBook.title}" added`)
      }
    }
    setEditingItem(null)
    setPickerBook(null)
  }

  function handlePickCover(item: CartItem) {
    setCoverItem(item)
    setCoverPickerOpen(true)
  }

  async function handleCoverConfirm(coverUrl: string) {
    if (!coverItem) return
    await fetch(`/api/cart/${slug}/items/${coverItem.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cover_url: coverUrl }),
    })
    setItems((prev) =>
      prev.map((i) => i.id === coverItem.id ? { ...i, cover_url: coverUrl } : i)
    )
    toast.success('Cover updated')
    setCoverItem(null)
  }

  function handleUpdateItem(id: string, patch: Partial<CartItem>) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)))
  }

  async function handleRemoveItem(id: string) {
    await fetch(`/api/cart/${slug}/items/${id}`, { method: 'DELETE' })
    setItems((prev) => prev.filter((i) => i.id !== id))
    toast.success('Book removed')
  }

  async function handleDeleteCart() {
    setDeleting(true)
    await fetch(`/api/cart/${slug}`, { method: 'DELETE' })
    router.push('/')
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    )
  }

  if (!cart) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-lg font-medium mb-2">Stack not found</p>
          <Link href="/"><Button variant="outline">Go home</Button></Link>
        </div>
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-background sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <BookOpen className="h-5 w-5 text-primary" />
          <div className="flex-1 min-w-0">
            <h1 className="font-serif font-semibold text-lg leading-tight">{cart.name}</h1>
            <p className="text-sm text-muted-foreground">{items.length} book{items.length !== 1 ? 's' : ''}</p>
          </div>
          <ThemeToggle />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
            title="Delete stack"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-[1fr_640px] gap-6">
        {/* Left: Book list */}
        <div className="space-y-4">
          <BookSearch onSelect={handleBookSelect} />
          <CartDefaults cart={cart} onUpdate={(updated) => setCart(updated)} slug={slug} />

          {items.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground border-2 border-dashed rounded-lg">
              <Plus className="h-10 w-10 mx-auto mb-3 opacity-20" />
              <p>Search for a book above to add it to your stack.</p>
            </div>
          ) : (
            <>
              <div className="book-shelf-area">
                <div className="space-y-2 max-h-[calc(100vh-240px)] overflow-y-auto pr-1">
                  {items.map((item) => (
                    <CartItemCard
                      key={item.id}
                      item={item}
                      onUpdate={handleUpdateItem}
                      onRemove={handleRemoveItem}
                      onChangeCover={handleChangeCover}
                      onPickCover={handlePickCover}
                    />
                  ))}
                </div>
              </div>
              <div className="book-shelf-edge" />
            </>
          )}
        </div>

        {/* Right: Optimization panel */}
        <div className="lg:sticky lg:top-20 lg:self-start">
          <OptimizationPanel items={items} cartSlug={slug} />
        </div>
      </div>

      <EditionPicker
        book={pickerBook}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onConfirm={handleEditionConfirm}
        initialIsbns={editingItem ? [
          ...(editingItem.isbn_preferred ? [editingItem.isbn_preferred] : []),
          ...(editingItem.isbns_candidates ?? []).filter((i) => i !== editingItem.isbn_preferred),
        ] : undefined}
        itemConditions={editingItem?.conditions ?? cart?.default_conditions}
      />

      <CoverPicker
        workId={coverItem?.work_id ?? null}
        currentCoverUrl={coverItem?.cover_url ?? null}
        open={coverPickerOpen}
        onOpenChange={setCoverPickerOpen}
        onConfirm={handleCoverConfirm}
      />

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete &ldquo;{cart.name}&rdquo;?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently delete the stack and all {items.length} book{items.length !== 1 ? 's' : ''} in it. This cannot be undone.
          </p>
          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteCart} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete stack'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  )
}
