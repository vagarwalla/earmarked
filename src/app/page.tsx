'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Plus, ShoppingCart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CreateCartDialog } from '@/components/CreateCartDialog'
import { ThemeToggle } from '@/components/ThemeToggle'
import type { Cart } from '@/lib/types'


export default function HomePage() {
  const [carts, setCarts] = useState<Cart[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)

  async function loadCarts() {
    try {
      const res = await fetch('/api/cart')
      const all: Cart[] = await res.json()
      const data = Array.isArray(all) ? all : []
      const empty = data.filter((c) => (c.item_count ?? 0) === 0)
      if (empty.length > 0) {
        await Promise.all(empty.map((c) => fetch(`/api/cart/${c.slug}`, { method: 'DELETE' })))
      }
      setCarts(data.filter((c) => (c.item_count ?? 0) > 0))
    } catch {
      setCarts([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadCarts() }, [])

  function handleCreated(cart: Cart) {
    setCarts((prev) => [cart, ...prev])
    setOpen(false)
    window.location.href = `/stack/${cart.slug}`
  }

  return (
    <main className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b bg-background sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl leading-none">📚</span>
            <span className="text-xl font-semibold">Earmarked</span>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              New Stack
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-4 pt-6 pb-4 text-center">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-1 leading-tight">
          Stack more books.
        </h1>
        <p className="text-muted-foreground text-base mb-4">Build a wishlist, pick your editions, order in one go.</p>
        <Button size="lg" className="text-base px-8 h-12" onClick={() => setOpen(true)}>
          <ShoppingCart className="h-5 w-5 mr-2" />
          Start a Stack
        </Button>
      </section>

      {/* Stacks list */}
      <section className="max-w-5xl mx-auto px-4 pb-16 flex-1 w-full">
        {loading ? (
          <div className="max-w-sm space-y-2">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-14 bg-muted rounded-lg animate-pulse" />
            ))}
          </div>
        ) : carts.length === 0 ? (
          <p className="text-muted-foreground italic">No stacks yet — create one to get started.</p>
        ) : (
          <div className="max-w-sm">
            <h2 className="text-base font-semibold mb-3 text-muted-foreground">All stacks — visible to everyone</h2>
            <div className="space-y-1">
              {carts.map((cart) => (
                <Link key={cart.id} href={`/stack/${cart.slug}`}>
                  <div className="flex items-center justify-between px-4 py-3 rounded-lg border bg-card hover:shadow-sm hover:border-primary/40 transition-all group cursor-pointer">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-base shrink-0">📚</span>
                      <span className="font-medium truncate group-hover:text-primary transition-colors">{cart.name}</span>
                    </div>
                    <span className="text-sm text-muted-foreground shrink-0 ml-3">
                      {cart.item_count ?? 0} {cart.item_count === 1 ? 'book' : 'books'}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* How it works */}
      <section className="max-w-5xl mx-auto px-4 pb-14">
        <h2 className="text-2xl font-bold text-center mb-8">How it works</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          <div className="text-center p-7 rounded-2xl bg-muted/50">
            <div className="text-4xl mb-4">🔍</div>
            <h3 className="font-semibold text-lg mb-2">Build your stack</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">Search for books by title or author and add them to your stack. Go on, add them all.</p>
          </div>
          <div className="text-center p-7 rounded-2xl bg-muted/50">
            <div className="text-4xl mb-4">📖</div>
            <h3 className="font-semibold text-lg mb-2">Pick your edition</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">Choose your preferred edition and cover for each book. First editions, beloved paperbacks — your call.</p>
          </div>
          <div className="text-center p-7 rounded-2xl bg-muted/50">
            <div className="text-4xl mb-4">📦</div>
            <h3 className="font-semibold text-lg mb-2">Order in one go</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">Books get grouped by seller so you place the fewest orders possible. No twelve separate checkouts.</p>
          </div>
        </div>
        <div className="mt-8 p-4 rounded-xl border bg-muted/30 text-sm text-center max-w-2xl mx-auto">
          🌍 Outside the US? Listings come from <strong>ThriftBooks</strong>, <strong>Better World Books</strong>, and <strong>AbeBooks</strong> — all US-based. They do ship internationally, though shipping will be a bit pricier.
        </div>
        <div className="mt-10 flex justify-center">
          <img
            src="https://66.media.tumblr.com/tumblr_lnyexmyOR71qc3reoo1_500.gif"
            alt="Harry Potter receiving a stack of books at Flourish and Blotts"
            className="rounded-2xl shadow-xl w-full max-w-2xl"
          />
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t py-4 px-4">
        <div className="max-w-5xl mx-auto flex justify-end">
          <p className="text-sm text-muted-foreground">made with ♥ by vaidehi</p>
        </div>
      </footer>

      <CreateCartDialog open={open} onOpenChange={setOpen} onCreated={handleCreated} />
    </main>
  )
}
