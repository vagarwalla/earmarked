/**
 * press — add a block of links to the pool.
 *
 *   POST /api/press/paste  { text: "…" }
 *   → { added, alreadyHad, rejected, duplicates, truncated, message }
 *
 * Nothing is fetched here. The rows land `queued` and the worker's extraction
 * finds them on its next pass, exactly as it does a Raindrop drop — a paste of
 * fifty links would otherwise be a request nobody's browser waits out.
 *
 * The URLs are strangers' input in the sense that matters: they are addresses
 * this app will later fetch from a machine inside a private network. That is
 * `src/lib/press/fetch.ts`'s job and it already does it — every hop resolved,
 * every private and link-local address refused. What is left for this route is
 * volume, which is the cap in `paste.ts`.
 */

import { NextResponse } from 'next/server'
import { describePaste, ingestPaste } from '@/lib/press/paste'
import { NOT_FOUND, asResponse, ownerDb, pressUiEnabled } from '../_lib/guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Longer than any paste needs and shorter than a denial of service. */
const MAX_BODY_CHARS = 64 * 1024

export async function POST(request: Request) {
  if (!pressUiEnabled()) return NOT_FOUND()

  const body = (await request.json().catch(() => null)) as { text?: string } | null
  const text = typeof body?.text === 'string' ? body.text : null
  if (!text || !text.trim()) {
    return NextResponse.json({ error: 'Paste some links first.' }, { status: 400 })
  }
  if (text.length > MAX_BODY_CHARS) {
    return NextResponse.json({ error: 'That is more text than a list of links.' }, { status: 413 })
  }

  try {
    const result = await ingestPaste(text, await ownerDb())
    // 200 even for a refusal: nothing went wrong, the answer is just no. The
    // panel shows `message` either way, and the counts are the real payload.
    return NextResponse.json({ ...result, message: describePaste(result) })
  } catch (err) {
    return asResponse(err)
  }
}
