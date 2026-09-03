/**
 * press — inbound email webhook (U2, KTD5).
 *
 * A Cloudflare Email Worker forwards the raw MIME of every message sent to
 * the press address here. This repo is public and the address is guessable, so
 * the shared secret is checked before a single byte of the body is read.
 */

import { NextResponse } from 'next/server'
import { ingestEmail, secretMatches, EMAIL_WEBHOOK_HEADER } from '@/lib/press/email'
import { loadSettings } from '@/lib/press/settings'
import { ownerAccount } from '@/lib/press/accounts'
import { pressDb } from '@/lib/press/db'

// Parsing MIME and normalizing an attached PDF is not edge work.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(request: Request) {
  const settings = loadSettings()

  if (!settings.emailWebhookSecret) {
    // Refuse to run open rather than accept anything while unconfigured.
    console.error('press/email-in: PRESS_EMAIL_WEBHOOK_SECRET is unset — refusing all deliveries')
    return NextResponse.json({ error: 'not configured' }, { status: 503 })
  }

  if (!secretMatches(request.headers.get(EMAIL_WEBHOOK_HEADER), settings.emailWebhookSecret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let raw: ArrayBuffer
  try {
    raw = await request.arrayBuffer()
  } catch {
    return NextResponse.json({ error: 'unreadable body' }, { status: 400 })
  }
  if (raw.byteLength === 0) {
    return NextResponse.json({ error: 'empty message' }, { status: 400 })
  }

  try {
    // Unscoped, and the third of the four places that is right: this is a
    // webhook authenticated by a shared secret, with nobody signed in. What
    // arrives is V's mail — the allowlist is hers — and `ingestEmail` stamps
    // the owner onto what it stores.
    const result = await ingestEmail(raw, { settings, db: pressDb((await ownerAccount()).id) })
    return NextResponse.json({
      kind: result.kind,
      relayed: result.relayed,
      items: result.items.map((i) => ({ id: i.id, source: i.source, state: i.state })),
    })
  } catch (err) {
    // A 500 tells the Email Worker to retry; the raw MIME is already stored, so
    // a retry cannot lose the message even if this path keeps failing.
    console.error(`press/email-in: ${(err as Error).message}`)
    return NextResponse.json({ error: 'ingest failed' }, { status: 500 })
  }
}
