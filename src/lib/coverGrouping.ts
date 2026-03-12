import Anthropic from '@anthropic-ai/sdk'

const CONCURRENCY = 15

async function withConcurrency<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  async function worker() {
    while (i < items.length) { const item = items[i++]; await fn(item) }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
}

type ImageEntry = { data: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' }

/**
 * Given a list of cover image URLs, uses Claude Sonnet to assign each URL to a
 * group ID (0-indexed). Same number = same cover design.
 *
 * Different scans of the same cover (different crops, color profiles, resolution,
 * or padding) are intentionally merged into one group.
 *
 * Returns one group ID per input URL. URLs that fail to load get their own unique
 * group ID so they are never incorrectly merged.
 */
export async function groupCoversHolistic(
  imageUrls: string[],
  client: Anthropic,
): Promise<number[]> {
  if (imageUrls.length < 2) {
    return imageUrls.map((_, i) => i)
  }

  // Fetch images in parallel
  const imageMap = new Map<string, ImageEntry>()

  await withConcurrency(imageUrls, async (url) => {
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
    } catch { /* skip — failed URLs get their own unique group */ }
  })

  const validUrls = imageUrls.filter(u => imageMap.has(u))

  if (validUrls.length < 2) {
    return imageUrls.map((_, i) => i)
  }

  const content: Anthropic.MessageParam['content'] = [
    {
      type: 'text',
      text: [
        `These ${validUrls.length} images are representative book covers from edition clusters.`,
        `Different scans of the SAME cover design may appear with different crops, color profiles,`,
        `image resolution, or padding — these should be grouped together.`,
        `Only group covers that show IDENTICAL artwork and design (same publisher edition look, same imagery).`,
        `Covers with genuinely different artwork must remain in separate groups, even if superficially similar.`,
        ``,
        `Return ONLY a JSON object: {"groups": [n0, n1, n2, ...]} where each number is the group ID for that image (0-indexed).`,
        `Assign group IDs starting from 0, incrementing for each distinct cover design.`,
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
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [{ role: 'user', content }],
    })

    const text = response.content.find(b => b.type === 'text')?.text ?? ''
    const jsonMatch = text.match(/\{[\s\S]*?\}/)
    if (!jsonMatch) throw new Error('No JSON in response')

    const parsed = JSON.parse(jsonMatch[0]) as { groups: number[] }
    if (!Array.isArray(parsed.groups) || parsed.groups.length !== validUrls.length) {
      throw new Error(`Unexpected groups length: got ${parsed.groups?.length}, expected ${validUrls.length}`)
    }

    // Map each input URL to its final group ID.
    // URLs that failed to load get a unique group so they're never merged.
    let nextGroup = Math.max(...parsed.groups) + 1
    return imageUrls.map((url) => {
      const idx = validUrls.indexOf(url)
      if (idx === -1) return nextGroup++
      return parsed.groups[idx]
    })
  } catch (err) {
    console.error('groupCoversHolistic failed:', err)
    // Fallback: no merges
    return imageUrls.map((_, i) => i)
  }
}
