/**
 * press — one render, polled.
 *
 *   GET /api/press/job/<id>  →  { job: { state, progress, error, result } }
 *
 * Polling rather than a stream, and cheaply: this is one indexed row read, and
 * the button asks for it every couple of seconds while a render is in flight.
 * The streamed version of this could not survive a reload; a row can.
 */

import { NextResponse } from 'next/server'
import { getJob } from '@/lib/press/jobs'
import { NOT_FOUND, asResponse, pressUiEnabled } from '../../_lib/guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!pressUiEnabled()) return NOT_FOUND()

  const { id } = await context.params
  // A UUID or nothing: this is a bare path segment, and handing anything else
  // to Postgres earns a 500 about invalid input syntax rather than a 404.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: 'no such job' }, { status: 404 })
  }

  try {
    const job = await getJob(id)
    if (!job) return NextResponse.json({ error: 'no such job' }, { status: 404 })
    return NextResponse.json({ job }, { headers: { 'cache-control': 'no-store' } })
  } catch (err) {
    return asResponse(err)
  }
}
