import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { normalizeItem } from '@/app/api/cart/[slug]/items/route'
import type { GoodreadsShelfBook } from '@/lib/goodreadsShelf'

const OL = 'https://openlibrary.org'
const OL_COVERS = 'https://covers.openlibrary.org'
const RESOLVE_CONCURRENCY = 5
const MAX_IMPORT = 200

interface ResolvedBook {
  title: string
  author: string | null
  work_id: string | null
  isbn_preferred: string | null
  cover_url: string | null
}

/** Resolve a Goodreads book to an Open Library work so the edition picker and price search work. */
async function resolveBook(book: GoodreadsShelfBook): Promise<ResolvedBook> {
  const base: ResolvedBook = {
    title: book.title,
    author: book.author || null,
    work_id: null,
    isbn_preferred: book.isbn,
    cover_url: book.cover_url,
  }

  // 1. ISBN lookup — exact edition match when Goodreads has one
  if (book.isbn) {
    try {
      const res = await fetch(`${OL}/isbn/${book.isbn}.json`, {
        signal: AbortSignal.timeout(6000),
        next: { revalidate: 86400 },
      })
      if (res.ok) {
        const data = await res.json()
        const workKey: string | undefined = data.works?.[0]?.key
        const coverId: number | undefined = (data.covers ?? []).find((id: number) => id > 0)
        if (workKey) {
          return {
            ...base,
            work_id: workKey,
            cover_url: coverId ? `${OL_COVERS}/b/id/${coverId}-M.jpg` : base.cover_url,
          }
        }
      }
    } catch {
      // fall through to title search
    }
  }

  // 2. Title + author search
  try {
    const params = new URLSearchParams({
      title: book.title,
      limit: '1',
      fields: 'key,cover_i',
    })
    if (book.author) params.set('author', book.author)
    const res = await fetch(`${OL}/search.json?${params}`, {
      signal: AbortSignal.timeout(6000),
      next: { revalidate: 86400 },
    })
    if (res.ok) {
      const data = await res.json()
      const doc = data.docs?.[0]
      if (doc?.key) {
        return {
          ...base,
          work_id: doc.key as string,
          cover_url: doc.cover_i ? `${OL_COVERS}/b/id/${doc.cover_i}-M.jpg` : base.cover_url,
        }
      }
    }
  } catch {
    // keep Goodreads data as-is
  }

  // 3. Unresolved — import with Goodreads metadata only
  return base
}

async function resolveAll(books: GoodreadsShelfBook[]): Promise<ResolvedBook[]> {
  const resolved: ResolvedBook[] = []
  for (let i = 0; i < books.length; i += RESOLVE_CONCURRENCY) {
    const chunk = books.slice(i, i + RESOLVE_CONCURRENCY)
    resolved.push(...(await Promise.all(chunk.map(resolveBook))))
  }
  return resolved
}

export async function POST(req: NextRequest) {
  try {
    const { slug, books }: { slug: string; books: GoodreadsShelfBook[] } = await req.json()
    if (!slug || !Array.isArray(books) || books.length === 0) {
      return NextResponse.json({ error: 'slug and books required' }, { status: 400 })
    }
    if (books.length > MAX_IMPORT) {
      return NextResponse.json({ error: `Too many books — max ${MAX_IMPORT} per import` }, { status: 400 })
    }

    const { data: cart } = await supabase.from('carts').select('*').eq('slug', slug).single()
    if (!cart) return NextResponse.json({ error: 'Cart not found' }, { status: 404 })

    const { count } = await supabase
      .from('cart_items')
      .select('id', { count: 'exact', head: true })
      .eq('cart_id', cart.id)
    const sortStart = count ?? 0

    const resolved = await resolveAll(books)

    const rows = resolved.map((b, i) => ({
      cart_id: cart.id,
      title: b.title,
      author: b.author,
      work_id: b.work_id,
      isbn_preferred: b.isbn_preferred,
      cover_url: b.cover_url,
      isbns_candidates: b.isbn_preferred ? [b.isbn_preferred] : null,
      conditions: cart.default_conditions ?? ['new', 'fine', 'good'],
      format: cart.default_format ?? 'any',
      max_price: cart.default_max_price ?? null,
      flexible: false,
      signed_only: cart.default_signed_only ?? null,
      first_edition_only: cart.default_first_edition_only ?? null,
      dust_jacket_only: cart.default_dust_jacket_only ?? null,
      quantity: 1,
      sort_order: sortStart + i,
    }))

    const { data, error } = await supabase.from('cart_items').insert(rows).select()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const items = (data ?? []).map((row) => normalizeItem(row as Record<string, unknown>))
    return NextResponse.json(
      { items, resolved_count: resolved.filter((b) => b.work_id).length },
      { status: 201 }
    )
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
