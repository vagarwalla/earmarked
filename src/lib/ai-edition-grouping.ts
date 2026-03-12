import Anthropic from '@anthropic-ai/sdk'
import type { Edition } from '@/lib/types'
import { groupEditionsByCover } from '@/components/EditionPicker'

export type { CoverGroup } from '@/components/EditionPicker'
import type { CoverGroup } from '@/components/EditionPicker'

// ─── AI-based edition grouping ────────────────────────────────────────────────

/**
 * Uses Claude Sonnet to group editions by cover/publication identity.
 * Falls back to empty array on error.
 */
export async function groupEditionsWithClaude(
  editions: Edition[],
  apiKey: string,
): Promise<CoverGroup[]> {
  if (editions.length === 0) return []

  const client = new Anthropic({ apiKey })

  const editionData = editions.map((e) => ({
    isbn: e.isbn,
    title: e.title,
    format: e.format,
    publisher: e.publisher,
    publish_date: e.publish_year,
    cover_id: e.cover_id,
    cover_url: e.cover_url,
  }))

  const prompt = `Given these book editions, group them by cover/publication identity.
Editions that are the SAME cover (same artwork, same publisher run) belong in one group.
Different covers/publishers = different groups. Return JSON: array of groups, each with
{cover_url, editions: [isbn...]}. Be conservative — only group when clearly the same cover.

Editions:
${JSON.stringify(editionData, null, 2)}

Return ONLY a JSON array, no other text.`

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.content.find((b) => b.type === 'text')?.text ?? ''

    // Extract JSON array from response
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) throw new Error('No JSON array in response')

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      cover_url: string | null
      editions: string[]
    }>

    if (!Array.isArray(parsed)) throw new Error('Response is not an array')

    // Convert to CoverGroup format
    const isbnToEdition = new Map<string, Edition>(editions.map((e) => [e.isbn, e]))
    const groups: CoverGroup[] = []

    for (let i = 0; i < parsed.length; i++) {
      const raw = parsed[i]
      if (!raw || !Array.isArray(raw.editions)) continue

      const groupEditions = raw.editions
        .map((isbn) => isbnToEdition.get(isbn))
        .filter((e): e is Edition => e != null)

      if (groupEditions.length === 0) continue

      const formats = [...new Set(groupEditions.map((e) => e.format))]
      const coverUrl = raw.cover_url ?? groupEditions.find((e) => e.cover_url != null)?.cover_url ?? null
      const key = coverUrl ? `ai:${coverUrl}` : `ai:group:${i}`

      groups.push({ key, cover_url: coverUrl, editions: groupEditions, formats })
    }

    // Add any editions that weren't placed in any group
    const placedIsbns = new Set(groups.flatMap((g) => g.editions.map((e) => e.isbn)))
    for (const edition of editions) {
      if (!placedIsbns.has(edition.isbn)) {
        const key = edition.cover_url ? `ai:orphan:${edition.cover_url}` : `ai:orphan:${edition.isbn}`
        groups.push({
          key,
          cover_url: edition.cover_url,
          editions: [edition],
          formats: edition.format !== 'any' ? [edition.format] : [],
        })
      }
    }

    return groups
  } catch (err) {
    console.error('groupEditionsWithClaude failed:', err)
    return []
  }
}

// ─── Opus judge ───────────────────────────────────────────────────────────────

/**
 * Uses Claude Opus to score the quality of a grouping (0–100).
 * Returns 0 on error.
 */
export async function judgeGroupingWithOpus(
  editions: Edition[],
  groups: CoverGroup[],
  apiKey: string,
): Promise<number> {
  const client = new Anthropic({ apiKey })

  const editionData = editions.map((e) => ({
    isbn: e.isbn,
    title: e.title,
    publisher: e.publisher,
    publish_year: e.publish_year,
    cover_id: e.cover_id,
    cover_url: e.cover_url,
    format: e.format,
  }))

  const groupData = groups.map((g) => ({
    key: g.key,
    cover_url: g.cover_url,
    edition_isbns: g.editions.map((e) => e.isbn),
    formats: g.formats,
  }))

  const prompt = `You are judging the quality of book edition grouping. Given these editions and
this grouping, score it 0-100 where 100 = perfect. Deduct points for:
- Different covers grouped together (-20 per error)
- Same cover split across groups (-10 per error)
- Poor representative edition chosen for group (-5 per error)
Return ONLY a JSON object: {"score": N, "reasoning": "..."}

Editions:
${JSON.stringify(editionData, null, 2)}

Grouping:
${JSON.stringify(groupData, null, 2)}`

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.content.find((b) => b.type === 'text')?.text ?? ''
    const jsonMatch = text.match(/\{[\s\S]*?\}/)
    if (!jsonMatch) throw new Error('No JSON in response')

    const parsed = JSON.parse(jsonMatch[0]) as { score: number; reasoning: string }
    const score = Number(parsed.score)
    if (isNaN(score)) throw new Error(`Invalid score: ${parsed.score}`)

    return Math.max(0, Math.min(100, score))
  } catch (err) {
    console.error('judgeGroupingWithOpus failed:', err)
    return 0
  }
}

// ─── Experiment runner ────────────────────────────────────────────────────────

export interface ExperimentResult {
  heuristicScore: number
  aiScore: number
  aiGroups: CoverGroup[]
  heuristicGroups: CoverGroup[]
}

/**
 * Runs both the deterministic heuristic grouper and the AI grouper, then judges
 * both with Claude Opus for a fair comparison.
 */
export async function runGroupingExperiment(
  editions: Edition[],
  apiKey: string,
): Promise<ExperimentResult> {
  const heuristicGroups = groupEditionsByCover(editions)
  const aiGroups = await groupEditionsWithClaude(editions, apiKey)

  // Use the same Opus judge for both to ensure consistency
  const [heuristicScore, aiScore] = await Promise.all([
    judgeGroupingWithOpus(editions, heuristicGroups, apiKey),
    judgeGroupingWithOpus(editions, aiGroups.length > 0 ? aiGroups : heuristicGroups, apiKey),
  ])

  return { heuristicScore, aiScore, aiGroups, heuristicGroups }
}
