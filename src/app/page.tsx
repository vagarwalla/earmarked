'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Plus, ShoppingCart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CreateCartDialog } from '@/components/CreateCartDialog'
import { ThemeToggle } from '@/components/ThemeToggle'
import type { Cart } from '@/lib/types'

const SPINE_COLORS = [
  'bg-amber-800', 'bg-emerald-800', 'bg-red-900', 'bg-indigo-800',
  'bg-stone-600', 'bg-teal-800', 'bg-rose-900', 'bg-violet-900',
  'bg-orange-800', 'bg-cyan-900', 'bg-lime-800', 'bg-fuchsia-900',
]
const SPINE_HEIGHTS = ['h-36', 'h-40', 'h-32', 'h-44', 'h-36', 'h-44', 'h-32', 'h-40']

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
      <section className="max-w-5xl mx-auto px-4 pt-16 pb-10 text-center">
        <h1 className="text-5xl sm:text-6xl font-bold tracking-tight mb-5 leading-tight">
          Stack more books.
        </h1>
        <Button size="lg" className="text-base px-8 h-12" onClick={() => setOpen(true)}>
          <ShoppingCart className="h-5 w-5 mr-2" />
          Start a Stack
        </Button>
        <div className="mt-12 flex justify-center">
          <img
            src="https://66.media.tumblr.com/tumblr_lnyexmyOR71qc3reoo1_500.gif"
            alt="Harry Potter receiving a stack of books at Flourish and Blotts"
            className="rounded-2xl shadow-xl w-full max-w-2xl"
          />
        </div>
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
      </section>

      {/* Stacks as books on a shelf */}
      <section className="max-w-5xl mx-auto px-4 pb-16 flex-1 w-full">
        {loading ? (
          <>
            <div className="bookcase-interior min-h-[196px] flex items-end gap-2">
              {[...Array(5)].map((_, i) => (
                <div key={i} className={`shrink-0 w-14 rounded-sm bg-muted/60 animate-pulse ${SPINE_HEIGHTS[i % SPINE_HEIGHTS.length]}`} />
              ))}
            </div>
            <div className="shelf-plank" />
          </>
        ) : carts.length === 0 ? (
          <>
            <div className="bookcase-interior min-h-[196px] flex items-center justify-center">
              <p className="text-muted-foreground text-sm italic">Your shelf is empty — start a stack!</p>
            </div>
            <div className="shelf-plank" />
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold mb-4">All stacks <span className="text-muted-foreground font-normal text-sm">— visible to everyone</span></h2>
            <div className="bookcase-interior">
              <div className="flex gap-2 items-end overflow-x-auto">
                {carts.map((cart, i) => (
                  <Link key={cart.id} href={`/stack/${cart.slug}`} title={`${cart.name} · ${cart.item_count ?? 0} books`}>
                    <div className={`shrink-0 w-14 rounded-sm flex items-center justify-center cursor-pointer hover:brightness-110 hover:-translate-y-2 transition-all duration-150 ${SPINE_COLORS[i % SPINE_COLORS.length]} ${SPINE_HEIGHTS[i % SPINE_HEIGHTS.length]}`}>
                      <span
                        className="text-xs font-semibold text-white/90 px-1 leading-tight w-full text-center line-clamp-4"
                        style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
                      >
                        {cart.name}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
            <div className="shelf-plank" />
          </>
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
