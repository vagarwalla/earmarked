import { NextRequest, NextResponse } from 'next/server'
import { runBatchOptimize } from '@/lib/optimizer/batch'
import { validateOptimizeRequest } from '@/lib/optimizer/validate'

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'request body must be valid JSON' }, { status: 400 })
  }

  const validated = validateOptimizeRequest(body)
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 })
  }

  // One request optimizes every source view: listings are qualified once and
  // partitioned server-side instead of the client uploading the pool five times.
  const results = runBatchOptimize(validated.items, validated.listingsByIsbn)
  return NextResponse.json(results)
}
