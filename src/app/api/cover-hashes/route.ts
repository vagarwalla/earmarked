import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '@/lib/supabase'
import { computeDHash } from '@/lib/dhash'
import { hammingDistance } from '@/lib/clustering'
import { groupCoversHolistic } from '@/lib/coverGrouping'

const CONCURRENCY = 20
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

async function withConcurrency<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  async function worker() {
    while (i < items.length) { const item = items[i++]; await fn(item) }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
}

function normalize(url: string): string {
  try {
    const u = new URL(url)
    if (u.hostname === 'books.google.com') {
      u.searchParams.delete('source')
      u.searchParams.delete('edge')
    }
    return u.toString()
  } catch { return url }
}

// Union-Find
function buildClusters(urls: string[], samePairs: [string, string][]): Record<string, string> {
  const parent = new Map<string, string>(urls.map(u => [u, u]))
  function find(u: string): string {
    if (parent.get(u) !== u) parent.set(u, find(parent.get(u)!))
    return parent.get(u)!
  }
  for (const [a, b] of samePairs) {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  return Object.fromEntries(urls.map(u => [u, find(u)]))
}

function groupCacheKey(reps: string[]): string {
  const sorted = [...reps].sort()
  return createHash('sha256').update(sorted.join('|||')).digest('hex')
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || !Array.isArray(body.coverUrls)) {
    return NextResponse.json({ error: 'coverUrls required' }, { status: 400 })
  }

  const force: boolean = body.force === true
  const coverUrls: string[] = [...new Set((body.coverUrls as string[]).map(normalize))]

  // 1. Fetch cached hashes
  const { data: cachedHashes } = await supabase
    .from('cover_hashes')
    .select('cover_url, hash')
    .in('cover_url', coverUrls)

  const hashMap = new Map<string, string>()
  for (const row of cachedHashes ?? []) hashMap.set(row.cover_url, row.hash)

  // 2. Fetch and hash missing covers
  const missing = coverUrls.filter(u => !hashMap.has(u))
  const toUpsertHashes: { cover_url: string; hash: string }[] = []

  await withConcurrency(missing, async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) return
      const ct = res.headers.get('content-type') ?? ''
      if (ct.startsWith('image/gif')) return
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 500) return
      const hash = await computeDHash(buf)
      hashMap.set(url, hash)
      toUpsertHashes.push({ cover_url: url, hash })
    } catch { /* skip */ }
  })

  if (toUpsertHashes.length > 0) {
    await supabase.from('cover_hashes').upsert(toUpsertHashes, { onConflict: 'cover_url' })
  }

  // 3. Build tier-1 pairs (Hamming ≤ 3 — definitely the same cover)
  const urls = Array.from(hashMap.keys())
  const tier1Pairs: [string, string][] = []
  for (let i = 0; i < urls.length; i++) {
    for (let j = i + 1; j < urls.length; j++) {
      const ha = BigInt('0x' + hashMap.get(urls[i])!)
      const hb = BigInt('0x' + hashMap.get(urls[j])!)
      if (hammingDistance(ha, hb) <= 3) {
        tier1Pairs.push([urls[i], urls[j]])
      }
    }
  }

  // 4. Build tier-1 clusters (fast, no AI)
  const tier1Clusters = buildClusters(urls, tier1Pairs)

  // 5. Collect one representative URL per tier-1 cluster
  const clusterReps = Array.from(new Set(Object.values(tier1Clusters)))

  // 6. Holistic AI grouping: send all cluster reps to Claude in one batch
  //    This catches cases dHash misses (same cover from different sources, Hamming > 3)
  let finalClusters = tier1Clusters

  if (clusterReps.length >= 2) {
    const key = groupCacheKey(clusterReps)

    // Check Supabase cache (skipped when force=true)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data: cached } = force ? { data: null } : await supabase
      .from('cover_group_cache')
      .select('groups')
      .eq('cache_key', key)
      .gt('created_at', thirtyDaysAgo)
      .maybeSingle()

    let holisticGroups: number[]
    if (cached?.groups) {
      holisticGroups = cached.groups as number[]
    } else {
      holisticGroups = await groupCoversHolistic(clusterReps, client)
      await supabase
        .from('cover_group_cache')
        .upsert({ cache_key: key, groups: holisticGroups }, { onConflict: 'cache_key' })
    }

    // Build holistic same-pairs: any two cluster reps with the same group ID should merge
    const holisticSamePairs: [string, string][] = []
    for (let i = 0; i < clusterReps.length; i++) {
      for (let j = i + 1; j < clusterReps.length; j++) {
        if (holisticGroups[i] === holisticGroups[j]) {
          holisticSamePairs.push([clusterReps[i], clusterReps[j]])
        }
      }
    }

    if (holisticSamePairs.length > 0) {
      // Re-run Union-Find combining tier-1 pairs + holistic merges
      finalClusters = buildClusters(urls, [...tier1Pairs, ...holisticSamePairs])
    }
  }

  return NextResponse.json({ clusters: finalClusters })
}
