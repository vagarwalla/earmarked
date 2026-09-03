/**
 * press — running a compose job.
 *
 * Separate from `jobs.ts`, which is the queue and is safe to import anywhere:
 * this pulls in the composer, and through it Vivliostyle and a browser. Only a
 * machine that has one should ever load this file.
 *
 * The order of operations matches what /lock did when it streamed: compose
 * first, freeze second, so a lock whose render failed cannot leave an issue's
 * contents frozen against PDFs that do not match them.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { composeIssue } from './compose'
import { getIssue, itemsForIssue, pressDb, updateIssue } from './db'
import { failJob, finishJob, reportProgress } from './jobs'
import { lockIssue } from './workbench'
import type { JobResult, PressJob } from './types'

/**
 * Do what a job asks, and record what happened either way.
 *
 * Never throws: the caller is a loop whose next act is to pick up the next job,
 * and a job that ends without a terminal state is one the reaper has to clean
 * up half an hour later. Every exit from here writes `done` or `failed`.
 */
export async function runComposeJob(
  job: PressJob,
  db: SupabaseClient = pressDb(),
): Promise<JobResult | null> {
  try {
    const issue = await getIssue(job.issue_id, db)
    if (!issue) throw new Error('That issue no longer exists.')

    // The issue may have moved since the button was pressed — locked from
    // another tab, ordered, skipped. Composing over it would replace the exact
    // objects a signed URL or a Lulu job is pointing at.
    if (issue.state !== 'open') {
      throw new Error(
        `Issue ${issue.number} is ${issue.state === 'closed' ? 'locked' : issue.state}; unlock it first.`,
      )
    }

    const items = await itemsForIssue(issue.id, db)
    if (items.length === 0) throw new Error('An empty issue has nothing to render.')

    const result = await composeIssue(issue, {
      db,
      // A rebuild re-renders this issue; it does not re-title it. An unnamed
      // draft still gets its name from the compose.
      name: issue.name ?? undefined,
      onProgress: (message) => void reportProgress(job.id, message, db),
    })

    // `built_order` is what staleness turns on, and composeIssue does not
    // write it — it knows what it rendered, not which of Postgres's ids that
    // was. Without this the workbench goes on saying "edited since the last
    // build" about a build that just finished.
    await updateIssue(issue.id, { built_order: items.map((i) => i.id) }, db)

    // Only now, and only for a lock: the contents freeze against PDFs that are
    // known to match them.
    if (job.intent === 'lock') {
      await reportProgress(job.id, 'Locking the issue', db)
      await lockIssue(issue.id, result.pageCount, db)
    }

    const summary: JobResult = {
      name: result.name,
      pageCount: result.pageCount,
      preflight: result.preflight,
      skipped: result.skipped.map((s) => ({
        title: s.item.title ?? s.item.url ?? s.item.id,
        reason: s.reason,
      })),
    }
    await finishJob(job.id, summary, db)
    return summary
  } catch (err) {
    await failJob(job.id, (err as Error).message, db)
    return null
  }
}
