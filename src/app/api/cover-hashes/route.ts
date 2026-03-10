import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { computeDHash } from '@/lib/dhash'

const CONCURRENCY = 20

async function withConcurrency<T>(
  items: T[],
  fn: (item: T) => Promise<void>
): Promise<void> {
  let i = 0
  async function worker() {
    while (i < items.length) {
      const item = items[i++]
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || !Array.isArray(body.coverUrls)) {
    return NextResponse.json({ error: 'coverUrls required' }, { status: 400 })
  }

  // Normalize URLs: strip query params that vary (zoom, source) from GB URLs
  const normalize = (url: string) => {
    try {
      const u = new URL(url)
      if (u.hostname === 'books.google.com') {
        u.searchParams.delete('source')
        u.searchParams.delete('edge')
        // keep id, printsec, img, zoom — they define the image
      }
      return u.toString()
    } catch {
      return url
    }
  }

  const coverUrls: string[] = [...new Set((body.coverUrls as string[]).map(normalize))]

  // Fetch cached hashes from DB
  const { data: cached } = await supabase
    .from('cover_hashes')
    .select('cover_url, hash')
    .in('cover_url', coverUrls)

  const result: Record<string, string> = {}
  const cachedSet = new Set<string>()
  for (const row of cached ?? []) {
    result[row.cover_url] = row.hash
    cachedSet.add(row.cover_url)
  }

  const missing = coverUrls.filter(u => !cachedSet.has(u))
  if (missing.length === 0) return NextResponse.json(result)

  // Fetch and hash missing covers
  const toUpsert: { cover_url: string; hash: string }[] = []

  await withConcurrency(missing, async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) return
      const contentType = res.headers.get('content-type') ?? ''
      if (contentType.startsWith('image/gif')) return // OL placeholder
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 500) return // too small, likely placeholder
      const hash = await computeDHash(buf)
      result[url] = hash
      toUpsert.push({ cover_url: url, hash })
    } catch {
      // skip failed images silently
    }
  })

  // Upsert new hashes
  if (toUpsert.length > 0) {
    await supabase.from('cover_hashes').upsert(toUpsert, { onConflict: 'cover_url' })
  }

  return NextResponse.json(result)
}
