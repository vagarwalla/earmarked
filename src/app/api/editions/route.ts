import { NextRequest, NextResponse } from 'next/server'
import { getEditions } from '@/lib/openLibrary'

export async function GET(req: NextRequest) {
  const workId = req.nextUrl.searchParams.get('workId')
  if (!workId) return NextResponse.json({ error: 'workId required' }, { status: 400 })
  const language = req.nextUrl.searchParams.get('language') ?? 'eng'
  const editions = await getEditions(workId, language)
  return NextResponse.json(editions)
}
