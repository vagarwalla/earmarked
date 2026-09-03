/**
 * press — the orders panel.
 *
 *   GET                        every order, newest first
 *   POST { action: 'refresh' } ask Lulu where the unfinished ones have got to
 *
 * Refresh is a button as well as a background pass on the worker's poll, so
 * the panel is right whether or not the worker is up — which, given how much
 * of this pipeline has run by hand, is the case worth designing for.
 */

import { NextResponse } from 'next/server'
import { cancelOrder, listOrders, refreshOrders, releaseOrder } from '@/lib/press/orders'
import { NOT_FOUND, asResponse, ownerDb, pressUiEnabled } from '../_lib/guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  if (!pressUiEnabled()) return NOT_FOUND()
  try {
    return NextResponse.json({ orders: await listOrders(await ownerDb()) })
  } catch (err) {
    return asResponse(err)
  }
}

export async function POST(request: Request) {
  if (!pressUiEnabled()) return NOT_FOUND()

  const body = (await request.json().catch(() => null)) as
    | { action?: string; orderId?: string }
    | null

  // Let go of a row Lulu never accepted, so the issue can be ordered again.
  // Only ever reaches rows with no job id; see `releaseOrder`.
  if (body?.action === 'release') {
    if (!body.orderId) return NextResponse.json({ error: 'no order named' }, { status: 400 })
    try {
      const db = await ownerDb()
      const released = await releaseOrder(body.orderId, db)
      if (!released) {
        return NextResponse.json(
          { error: 'That order is at Lulu, or was already released. Nothing changed.' },
          { status: 409 },
        )
      }
      return NextResponse.json({ ok: true, orders: await listOrders(db) })
    } catch (err) {
      return asResponse(err)
    }
  }

  // Cancel an unpaid job, so its issue can go into a bundle instead.
  if (body?.action === 'cancel') {
    if (!body.orderId) return NextResponse.json({ error: 'no order named' }, { status: 400 })
    try {
      const db = await ownerDb()
      const result = await cancelOrder(body.orderId, { db })
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })
      return NextResponse.json({ ok: true, orders: await listOrders(db) })
    } catch (err) {
      return asResponse(err)
    }
  }

  if (body?.action !== 'refresh') {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }

  try {
    // Partial failure is reported, not thrown: one job id Lulu has forgotten
    // must not freeze the whole panel.
    const db = await ownerDb()
    const result = await refreshOrders(db)
    return NextResponse.json({ ...result, orders: await listOrders(db) })
  } catch (err) {
    return asResponse(err)
  }
}
