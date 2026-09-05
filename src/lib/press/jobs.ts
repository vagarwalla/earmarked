/**
 * press — the queue between a button on the website and the machine that renders.
 *
 * Composing an issue needs Chromium, which a Vercel function is not. So the
 * website does not render: it writes a row, and the Fly worker — which has a
 * browser and nothing else to do — claims it, renders, and writes back what
 * happened. The button polls the row.
 *
 * This replaces the NDJSON stream for the deployed path. Streaming was right
 * when the browser was directly driving a local build; it is wrong for a render
 * happening on another continent, because the progress has nowhere to go the
 * moment the tab closes and the four minutes of work are lost with it. A row
 * survives the tab, a reload, and a phone going to sleep.
 *
 * Server-only: press tables are service-role.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { JobIntent, JobResult, PressJob } from './types'

/** A refusal worth showing the reader — not a bug. */
export class JobError extends Error {}

/**
 * Ask for an issue to be composed.
 *
 * The partial unique index does the interesting work: a second press of the
 * button while a render is queued or running violates it, and that is not an
 * error to log but the answer to the question. Returned as a `JobError` with
 * the sentence the panel should print.
 */
export async function enqueueCompose(
  issueId: string,
  intent: JobIntent,
  db: SupabaseClient,
): Promise<PressJob> {
  const { data, error } = await db
    .from('press_jobs')
    .insert({ kind: 'compose', issue_id: issueId, intent, progress: 'Waiting for the renderer' })
    .select()
    .single()

  if (error) {
    // 23505 is unique_violation. The only unique index on this table is the
    // one-live-job-per-issue one, so there is no ambiguity about which.
    if (error.code === '23505') {
      throw new JobError('This issue is already being made. Watch the progress, or wait for it to finish.')
    }
    throw new Error(`press/jobs: enqueueCompose: ${error.message}`)
  }
  return data as PressJob
}

/**
 * How long a renderer may go quiet before the website stops believing in it.
 *
 * The worker touches its row on the job loop, which runs every ten seconds
 * whether or not there is anything to claim. Five minutes is thirty missed
 * beats — far past a slow poll or a restart, and far short of leaving a button
 * refusing after the machine has come back.
 */
const WORKER_STALE_MS = 5 * 60 * 1000

/** The renderer saying it is here. Called on the loop, not on the work. */
export async function noteWorkerAlive(
  db: SupabaseClient,
  id = 'compose',
  detail?: Record<string, unknown>,
): Promise<void> {
  const { error } = await db
    .from('press_workers')
    .upsert({ id, last_seen_at: new Date().toISOString(), detail: detail ?? null })
  // A heartbeat that will not write must not stop the renderer from rendering.
  // The cost of it failing is that the website starts refusing to queue, which
  // is the safe direction to be wrong in.
  if (error) console.error(`press/jobs: noteWorkerAlive: ${error.message}`)
}

/**
 * Is there a machine that will actually pick a job up?
 *
 * Asked before enqueueing, because a queue nobody serves is worse than a
 * refusal: the refusal tells you to go and use the laptop, while the queue
 * looks like progress, waits forever, and then blocks the button behind the
 * row it left. See the plan in 022's migration.
 *
 * An unreadable heartbeat counts as no renderer, for the same reason.
 */
export async function rendererAlive(db: SupabaseClient, id = 'compose'): Promise<boolean> {
  const { data, error } = await db
    .from('press_workers')
    .select('last_seen_at')
    .eq('id', id)
    .maybeSingle()
  if (error || !data) return false
  const seen = Date.parse((data as { last_seen_at: string }).last_seen_at)
  return Number.isFinite(seen) && Date.now() - seen < WORKER_STALE_MS
}

/** Claim the oldest queued job, or null when there is nothing to do. */
export async function claimJob(db: SupabaseClient): Promise<PressJob | null> {
  const { data, error } = await db.rpc('press_claim_job')
  if (error) throw new Error(`press/jobs: claimJob: ${error.message}`)
  return (data as PressJob) ?? null
}

/**
 * A progress line, and the heartbeat that goes with it.
 *
 * The two travel together deliberately. A heartbeat on its own timer would keep
 * a hung render looking alive, which is the one thing the reaper needs to be
 * able to tell apart — so "still alive" means "got as far as saying something".
 */
export async function reportProgress(
  jobId: string,
  message: string,
  db: SupabaseClient,
): Promise<void> {
  const { error } = await db
    .from('press_jobs')
    .update({ progress: message, heartbeat_at: new Date().toISOString() })
    .eq('id', jobId)
  // A progress line that will not write must not abort a render that is
  // otherwise fine. The reaper is the backstop if this keeps failing.
  if (error) console.error(`press/jobs: reportProgress: ${error.message}`)
}

export async function finishJob(
  jobId: string,
  result: JobResult,
  db: SupabaseClient,
): Promise<void> {
  const { error } = await db
    .from('press_jobs')
    .update({ state: 'done', result, progress: null, finished_at: new Date().toISOString() })
    .eq('id', jobId)
  if (error) throw new Error(`press/jobs: finishJob: ${error.message}`)
}

export async function failJob(
  jobId: string,
  message: string,
  db: SupabaseClient,
): Promise<void> {
  const { error } = await db
    .from('press_jobs')
    .update({ state: 'failed', error: message, progress: null, finished_at: new Date().toISOString() })
    .eq('id', jobId)
  // Nothing to escalate to — the caller is a worker loop whose next act is to
  // pick up the next job — so this is logged and swallowed. The reaper turns a
  // job stuck `running` because of it into a failure eventually.
  if (error) console.error(`press/jobs: failJob: ${error.message}`)
}

export async function getJob(jobId: string, db: SupabaseClient): Promise<PressJob | null> {
  const { data, error } = await db.from('press_jobs').select('*').eq('id', jobId).maybeSingle()
  if (error) throw new Error(`press/jobs: getJob: ${error.message}`)
  return (data as PressJob) ?? null
}

/**
 * Every job that has not finished.
 *
 * The workbench asks for this on load, so a render started from a phone is
 * still reporting its progress when the laptop opens the page. Without it, a
 * reload shows an idle button over a machine that is four minutes into a
 * hundred pages.
 */
export async function liveJobs(db: SupabaseClient): Promise<PressJob[]> {
  const { data, error } = await db
    .from('press_jobs')
    .select('*')
    .in('state', ['queued', 'running'])
    .order('created_at', { ascending: true })
  if (error) throw new Error(`press/jobs: liveJobs: ${error.message}`)
  return (data as PressJob[]) ?? []
}

/** The most recent job for an issue, whatever became of it. */
export async function latestJobForIssue(
  issueId: string,
  db: SupabaseClient,
): Promise<PressJob | null> {
  const { data, error } = await db
    .from('press_jobs')
    .select('*')
    .eq('issue_id', issueId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`press/jobs: latestJobForIssue: ${error.message}`)
  return (data as PressJob) ?? null
}

/** Fail whatever has been `running` longer than a render could honestly take. */
export async function reapStaleJobs(db: SupabaseClient): Promise<number> {
  const { data, error } = await db.rpc('press_reap_jobs')
  if (error) throw new Error(`press/jobs: reapStaleJobs: ${error.message}`)
  return (data as number) ?? 0
}
