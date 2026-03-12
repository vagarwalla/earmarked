import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { groupCoversHolistic } from '@/lib/coverGrouping'

// One representative URL per dHash cluster → final group IDs after AI grouping
// Input:  { clusterUrls: string[] }   (one URL per dHash cluster, in order)
// Output: { groups: number[] }        (final group ID per input URL; same number = merge)

const client = new Anthropic()

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || !Array.isArray(body.clusterUrls) || body.clusterUrls.length === 0) {
    return NextResponse.json({ error: 'clusterUrls required' }, { status: 400 })
  }

  const clusterUrls: string[] = body.clusterUrls

  if (clusterUrls.length === 1) {
    return NextResponse.json({ groups: [0] })
  }

  const groups = await groupCoversHolistic(clusterUrls, client)
  return NextResponse.json({ groups })
}
