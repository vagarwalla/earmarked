import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'

const client = new Anthropic()

interface ClusterInput {
  id: string
  editions: Array<{
    publisher: string | null
    year: number | null
    format: string
    edition_name: string | null
  }>
}

export async function POST(req: Request) {
  const { clusters }: { clusters: ClusterInput[] } = await req.json()

  if (!clusters || clusters.length === 0) {
    return NextResponse.json({})
  }

  const clusterDescriptions = clusters
    .map((c) => {
      const publishers = [...new Set(c.editions.map((e) => e.publisher).filter(Boolean))]
      const years = c.editions.map((e) => e.year).filter((y): y is number => y !== null)
      const minYear = years.length ? Math.min(...years) : null
      const maxYear = years.length ? Math.max(...years) : null
      const yearRange =
        minYear && maxYear
          ? minYear === maxYear
            ? String(minYear)
            : `${minYear}–${maxYear}`
          : null
      const formats = [...new Set(c.editions.map((e) => e.format).filter((f) => f !== 'any'))]
      const editionNames = [...new Set(c.editions.map((e) => e.edition_name).filter(Boolean))]

      return `id: ${c.id}
publishers: ${publishers.length ? publishers.join(', ') : 'unknown'}
years: ${yearRange ?? 'unknown'}
formats: ${formats.join(', ') || 'unknown'}
edition names: ${editionNames.length ? editionNames.join(', ') : 'none'}`
    })
    .join('\n\n')

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `Generate a short label (2–5 words) for each book edition cluster. Capture what makes the group distinctive — typically publisher and year range. Use · as separator between publisher and years.

${clusterDescriptions}

Respond ONLY with a JSON object mapping each id to its label. Example: {"id1": "Penguin · 1995–2002", "id2": "Del Rey Hardcovers", "id3": "Various · 2000s"}`,
        },
      ],
    })

    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return NextResponse.json({})
    return NextResponse.json(JSON.parse(match[0]))
  } catch (err) {
    console.error('label-clusters error:', err)
    return NextResponse.json({})
  }
}
