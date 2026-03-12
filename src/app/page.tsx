'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Plus, ShoppingCart, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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
      <section className="max-w-5xl mx-auto px-4 py-16">
        <div className="flex flex-col lg:flex-row items-center gap-12">
          <div className="flex-1 text-center lg:text-left">
            <h1 className="text-5xl sm:text-6xl font-bold tracking-tight mb-5 leading-tight">
              Stack more books.
            </h1>
            <p className="text-muted-foreground text-xl max-w-xl mb-10">
              Tell us what you&apos;re after, pick your preferred edition and cover, and we&apos;ll track down second-hand copies across booksellers — grouped so you can order everything in one go.
            </p>
            <Button size="lg" className="text-base px-8 h-12" onClick={() => setOpen(true)}>
              <ShoppingCart className="h-5 w-5 mr-2" />
              Start a Stack
            </Button>
          </div>
          <div className="shrink-0">
            <img
              src="https://66.media.tumblr.com/tumblr_lnyexmyOR71qc3reoo1_500.gif"
              alt="Harry Potter receiving a stack of books at Flourish and Blotts"
              className="rounded-2xl shadow-lg w-72 sm:w-80"
            />
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="max-w-5xl mx-auto px-4 pb-14">
        <h2 className="text-2xl font-bold text-center mb-8">How the magic works</h2>
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
            <p className="text-muted-foreground text-sm leading-relaxed">We group your books by seller so you place the fewest orders possible. No twelve separate checkouts.</p>
          </div>
        </div>
        <div className="mt-8 p-4 rounded-xl border bg-muted/30 text-sm text-center max-w-2xl mx-auto">
          🌍 <strong>Note for international readers:</strong> Listings come from <strong>ThriftBooks</strong>, <strong>Better World Books</strong>, and <strong>AbeBooks</strong> — US-based marketplaces. They do ship internationally, but expect higher shipping costs outside the US.
        </div>
      </section>

      {/* Stacks gallery */}
      <section className="max-w-5xl mx-auto px-4 pb-16 flex-1 w-full">
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => (
              <Card key={i} className="animate-pulse">
                <CardHeader><div className="h-5 bg-muted rounded w-3/4" /></CardHeader>
                <CardContent><div className="h-4 bg-muted rounded w-1/4" /></CardContent>
              </Card>
            ))}
          </div>
        ) : carts.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <span className="text-5xl block mb-4">📚</span>
            <p className="text-lg">No stacks yet. Create one to get started.</p>
          </div>
        ) : (
          <div>
            <h2 className="text-lg font-semibold mb-4">All stacks <span className="text-muted-foreground font-normal text-sm">— visible to everyone</span></h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {carts.map((cart) => (
                <Link key={cart.id} href={`/stack/${cart.slug}`}>
                  <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-start justify-between gap-2">
                        <span>{cart.name}</span>
                        <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">
                          {cart.item_count ?? 0} {cart.item_count === 1 ? 'book' : 'books'}
                        </Badge>
                        <span className="text-sm text-muted-foreground">
                          {new Date(cart.created_at).toLocaleDateString()}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        )}
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
