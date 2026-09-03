/**
 * press — what the renderer is working on.
 *
 *   GET /api/press/job   →  { jobs: [ … ] }   everything queued or running
 *
 * The workbench asks for this on load. A compose outlives the tab that asked
 * for it — that is the whole point of moving it into a row — so a page opened
 * on a laptop after the button was pressed on a phone has to be able to find
 * the render already in flight, or it shows an idle button over a machine four
 * minutes into a hundred pages.
 */

import { NextResponse } from 'next/server'
import { liveJobs } from '@/lib/press/jobs'
import { NOT_FOUND, asResponse, ownerDb, pressUiEnabled } from '../_lib/guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  if (!pressUiEnabled()) return NOT_FOUND()
  try {
    return NextResponse.json({ jobs: await liveJobs(await ownerDb()) }, { headers: { 'cache-control': 'no-store' } })
  } catch (err) {
    return asResponse(err)
  }
}
