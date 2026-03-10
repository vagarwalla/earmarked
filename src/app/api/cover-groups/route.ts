import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

// One representative URL per dHash cluster → final group IDs after Claude sanity check
// Input:  { clusterUrls: string[] }   (one URL per dHash cluster, in order)
// Output: { groups: number[] }        (final group ID per input URL; same number = merge)

const client = new Anthropic()

const CONCURRENCY = 15

async function withConcurrency<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
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
  if (!body || !Array.isArray(body.clusterUrls) || body.clusterUrls.length === 0) {
    return NextResponse.json({ error: 'clusterUrls required' }, { status: 400 })
  }

  const clusterUrls: string[] = body.clusterUrls

  // With only one cluster there's nothing to merge
  if (clusterUrls.length === 1) {
    return NextResponse.json({ groups: [0] })
  }

  // Fetch images in parallel
  type ImageEntry = { data: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' }
  const imageMap = new Map<string, ImageEntry>()

  await withConcurrency(clusterUrls, async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) return
      const contentType = res.headers.get('content-type') ?? 'image/jpeg'
      if (contentType.includes('gif')) return // likely a placeholder
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 500) return // too small, likely a placeholder
      const mediaType = (
        contentType.startsWith('image/png') ? 'image/png'
        : contentType.startsWith('image/webp') ? 'image/webp'
        : 'image/jpeg'
      ) as ImageEntry['mediaType']
      imageMap.set(url, { data: buf.toString('base64'), mediaType })
    } catch {
      // skip failed images — they'll stay in their own cluster
    }
  })

  const validUrls = clusterUrls.filter(u => imageMap.has(u))

  // If fewer than 2 images loaded, nothing to merge
  if (validUrls.length < 2) {
    return NextResponse.json({ groups: clusterUrls.map((_, i) => i) })
  }

  // Build message content: instructions + labelled images
  const content: Anthropic.MessageParam['content'] = [
    {
      type: 'text',
      text: [
        `These ${validUrls.length} images are representative covers from separate visual-similarity clusters produced by a perceptual hash algorithm.`,
        `Some clusters may have been incorrectly split — the same cover design can appear at different resolutions, crops, or with slight color shifts.`,
        `Your job: identify which clusters actually show the same cover design and should be merged.`,
        ``,
        `Return ONLY a JSON object: {"groups": [n0, n1, n2, ...]} where each number is the final group ID for that image (0-indexed).`,
        `Assign group IDs starting from 0 and incrementing for each genuinely distinct cover design.`,
        `Example — if images 0 and 2 are the same design and 1 is different: {"groups": [0, 1, 0]}`,
      ].join('\n'),
    },
  ]

  for (let i = 0; i < validUrls.length; i++) {
    const img = imageMap.get(validUrls[i])!
    content.push({ type: 'text', text: `Cover ${i}:` })
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    })
  }

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 512,
      messages: [{ role: 'user', content }],
    })

    const text = response.content.find(b => b.type === 'text')?.text ?? ''
    const jsonMatch = text.match(/\{[\s\S]*?\}/)
    if (!jsonMatch) throw new Error('No JSON in response')

    const parsed = JSON.parse(jsonMatch[0]) as { groups: number[] }
    if (!Array.isArray(parsed.groups) || parsed.groups.length !== validUrls.length) {
      throw new Error('Unexpected groups length')
    }

    // Map each input clusterUrl to its final group ID.
    // URLs that failed to load stay in their own unique group (won't be merged).
    let nextGroup = Math.max(...parsed.groups) + 1
    const result: number[] = clusterUrls.map((url) => {
      const idx = validUrls.indexOf(url)
      if (idx === -1) return nextGroup++ // image failed to load
      return parsed.groups[idx]
    })

    return NextResponse.json({ groups: result })
  } catch (err) {
    console.error('cover-groups sanity check failed:', err)
    // Fall back to identity (no merges)
    return NextResponse.json({ groups: clusterUrls.map((_, i) => i) })
  }
}
