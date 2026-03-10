'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, Plus, ShoppingCart, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { CreateCartDialog } from '@/components/CreateCartDialog'
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
    window.location.href = `/cart/${cart.slug}`
  }

  return (
    <main className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-white sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookOpen className="h-6 w-6 text-primary" />
            <span className="text-xl font-semibold">Earmarked</span>
          </div>
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New Cart
          </Button>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-4 py-12 text-center">
        <h1 className="text-4xl font-bold tracking-tight mb-3">
          Find cheap used books, minimize shipping
        </h1>
        <p className="text-muted-foreground text-lg max-w-xl mx-auto mb-8">
          Build a list of books you want, pick your preferred edition and cover, and we&apos;ll find the cheapest way to buy them all by grouping sellers.
        </p>
        <Button size="lg" onClick={() => setOpen(true)}>
          <ShoppingCart className="h-5 w-5 mr-2" />
          Create a Cart
        </Button>
      </section>

      {/* Carts gallery */}
      <section className="max-w-5xl mx-auto px-4 pb-16">
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
            <ShoppingCart className="h-12 w-12 mx-auto mb-4 opacity-20" />
            <p>No carts yet. Create one to get started.</p>
          </div>
        ) : (
          <div>
            <h2 className="text-lg font-semibold mb-4">All carts <span className="text-muted-foreground font-normal text-sm">— visible to everyone</span></h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {carts.map((cart) => (
                <Link key={cart.id} href={`/cart/${cart.slug}`}>
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

      <CreateCartDialog open={open} onOpenChange={setOpen} onCreated={handleCreated} />
    </main>
  )
}
