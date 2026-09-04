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
 *
 * It reaps before it lists, and that is the only thing that reaps at all on a
 * press whose worker is not running. `press_reap_jobs` had exactly one caller
 * — the worker loop — which is fine for a job whose machine died mid-render
 * and useless for the case that bit: no worker, so a queued row is never
 * claimed, never reaped, and 017's one-live-job index refuses every later
 * press of the button for that issue. Opening the workbench is the one moment
 * we can be sure somebody wants those buttons to work.
 *
 * Its failure is swallowed. A reap that will not run is not a reason to
 * withhold the list of live jobs, which is what this route is actually for.
 */

import { NextResponse } from 'next/server'
import { liveJobs, reapStaleJobs } from '@/lib/press/jobs'
import { NOT_FOUND, asResponse, ownerDb, pressUiEnabled } from '../_lib/guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  if (!pressUiEnabled()) return NOT_FOUND()
  try {
    const db = await ownerDb()
    await reapStaleJobs(db).catch(() => 0)
    return NextResponse.json({ jobs: await liveJobs(db) }, { headers: { 'cache-control': 'no-store' } })
  } catch (err) {
    return asResponse(err)
  }
}
