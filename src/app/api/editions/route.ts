import { NextRequest, NextResponse } from 'next/server'
import { getEditions, findSiblingWorkIds } from '@/lib/openLibrary'

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams
  const workIdsParam = params.get('workIds')
  const workId = params.get('workId')

  let workIds = (workIdsParam ?? workId ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)

  if (workIds.length === 0) {
    return NextResponse.json({ error: 'workId required' }, { status: 400 })
  }

  // A single work id means the caller doesn't know the book's other OL work
  // records — resolve them, or the edition list comes back partial.
  if (workIds.length === 1) {
    const title = params.get('title')
    if (title) workIds = await findSiblingWorkIds(workIds[0], title, params.get('author') ?? '')
  }

  const language = params.get('language') ?? 'eng'
  const editions = await getEditions(workIds, language)
  return NextResponse.json(editions)
}
